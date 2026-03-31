import type { Instruction, Address as SolAddress } from "@solana/kit";
import {
  AccountRole,
  createSolanaRpc,
  address as solAddress,
} from "@solana/kit";
import type { Hash, Hex } from "viem";
import { toBytes } from "viem";
import type { EvmChainAdapter } from "../../../adapters/chains/evm/types";
import type { SolanaChainAdapter } from "../../../adapters/chains/solana/types";
import type { Ix } from "../../../clients/ts/src/bridge";
import { fetchMaybeIncomingMessage } from "../../../clients/ts/src/bridge";
import type { Logger } from "../../../utils/logger";
import {
  BridgeInvariantViolationError,
  BridgeProofNotAvailableError,
  BridgeUnsupportedActionError,
  wrapEngineError,
} from "../../errors";
import { pollingMonitor } from "../../monitor/polling";
import type {
  BridgeContext,
  BridgeOperation,
  BridgeRequest,
  BridgeRoute,
  DestinationCall,
  ExecuteOptions,
  ExecuteResult,
  ExecutionStatus,
  MessageRef,
  MonitorOptions,
  ProveOptions,
  ProveResult,
  Quote,
  QuoteRequest,
  RouteAdapter,
  RouteCapabilities,
  SolanaInstruction,
  StatusOptions,
} from "../../types";
import { isSolanaDestinationCall } from "../../utils";
import { BaseEngine } from "../engines/base-engine";
import { SOLANA_BASE_TX_FEE } from "../engines/constants";
import { SolanaEngine } from "../engines/solana-engine";
import { decodeMessageInitiatedEvents } from "../events";
import { deriveIncomingMessagePda } from "../pda";

// ─────────────────────────────────────────────────────────────────────────────
// Gas estimation constants for Base -> SVM quotes
// ─────────────────────────────────────────────────────────────────────────────

/** Default gas estimate for call operations when estimation fails */
const DEFAULT_CALL_GAS = 150_000n;
/** Default gas estimate for transfer operations when estimation fails */
const DEFAULT_TRANSFER_GAS = 200_000n;
/** Base gas cost for a bridgeCall transaction */
const BRIDGE_CALL_BASE_GAS = 100_000n;
/** Additional gas per Solana instruction in a bridgeCall */
const GAS_PER_INSTRUCTION = 5_000n;
/** Base gas cost for a bridgeToken transaction */
const BRIDGE_TOKEN_BASE_GAS = 150_000n;

// ─────────────────────────────────────────────────────────────────────────────
// Solana fee estimation constants
// ─────────────────────────────────────────────────────────────────────────────

/** Estimated compute units for prove operation */
const SOLANA_PROVE_COMPUTE_LAMPORTS = 5_000n;
/** Bridge execute overhead in compute units (CPI, account validation) */
const BRIDGE_EXECUTE_OVERHEAD_CU = 50_000n;
/** Lamports per compute unit (conservative priority fee estimate) */
const LAMPORTS_PER_CU = 1n;
/** Fallback lamports per instruction when simulation fails */
const FALLBACK_LAMPORTS_PER_INSTRUCTION = 50_000n;
/** Minimum compute fee when calculated fee is zero */
const MIN_COMPUTE_FEE_LAMPORTS = 5_000n;
/** Base execute fee when no custom instructions */
const BASE_EXECUTE_FEE_LAMPORTS = 10_000n;

/** Max instruction data bytes before falling back to the buffered prove path. */
const PROVE_BUFFER_THRESHOLD = 900;
/** Max data bytes per appendToProveBufferData transaction. */
const PROVE_DATA_CHUNK_SIZE = 900;
/** Max proof nodes per appendToProveBufferProof transaction. */
const PROVE_PROOF_CHUNK_SIZE = 25;
/** Fixed-overhead bytes in the proveMessage instruction (discriminator + nonce + sender + length prefixes + messageHash). */
const PROVE_FIXED_OVERHEAD = 76;

/**
 * Base -> SVM route adapter (Base is always the EVM side).
 */
export class BaseToSvmRouteAdapter implements RouteAdapter {
  readonly route: BridgeRoute;

  private readonly solana: SolanaChainAdapter;
  private readonly evm: EvmChainAdapter;
  private readonly solanaDeployment: {
    bridgeProgram: SolAddress;
    relayerProgram: SolAddress;
  };
  private readonly evmDeployment: { bridgeContract: Hex };
  private readonly tokenMapping?: Record<string, string>;

  private readonly solanaEngine: SolanaEngine;
  private readonly baseEngine: BaseEngine;
  private readonly solanaRpc: ReturnType<typeof createSolanaRpc>;
  private readonly pdaCache = new Map<Hex, SolAddress>();

  constructor(args: {
    route: BridgeRoute;
    solana: SolanaChainAdapter;
    evm: EvmChainAdapter;
    solanaDeployment: { bridgeProgram: SolAddress; relayerProgram: SolAddress };
    evmDeployment: { bridgeContract: Hex };
    tokenMapping?: Record<string, string>;
    logger?: Logger;
  }) {
    this.route = args.route;
    this.solana = args.solana;
    this.evm = args.evm;
    this.solanaDeployment = args.solanaDeployment;
    this.evmDeployment = args.evmDeployment;
    this.tokenMapping = args.tokenMapping;

    this.solanaEngine = new SolanaEngine({
      config: {
        rpcUrl: this.solana.rpcUrl,
        payer: this.solana.payer,
        bridgeProgram: this.solanaDeployment.bridgeProgram,
        relayerProgram: this.solanaDeployment.relayerProgram,
      },
    });
    this.baseEngine = new BaseEngine({
      config: {
        rpcUrl: this.evm.rpcUrl,
        bridgeContract: this.evmDeployment.bridgeContract,
        chain: this.evm.viemChain,
        privateKey: this.evm.privateKey,
      },
      logger: args.logger,
    });
    this.solanaRpc = createSolanaRpc(this.solana.rpcUrl);
  }

  async capabilities(): Promise<RouteCapabilities> {
    return {
      steps: ["initiate", "prove", "execute", "monitor"],
      autoRelay: false,
      manualExecute: true,
      prove: true,
      supportsQuote: true,
    };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const warnings: string[] = [];

    // Estimate source chain fees (Base EVM gas)
    // We estimate gas for the bridgeCall or bridgeToken operation
    let sourceGas: bigint;
    try {
      sourceGas = await this.estimateInitiateGas(req);
    } catch (err) {
      // If estimation fails, use conservative defaults
      sourceGas =
        req.action.kind === "call" ? DEFAULT_CALL_GAS : DEFAULT_TRANSFER_GAS;
      warnings.push(
        `Source gas estimation failed: ${err instanceof Error ? err.message : String(err)}. Using conservative estimate.`,
      );
    }

    // Fetch gas price and estimate execute fee in parallel (independent RPC calls)
    const proveFee = SOLANA_BASE_TX_FEE + SOLANA_PROVE_COMPUTE_LAMPORTS;
    const [gasPrice, executeFee] = await Promise.all([
      this.evm.publicClient.getGasPrice(),
      this.estimateExecuteFee(req, warnings),
    ]);
    const sourceGasCost = sourceGas * gasPrice;
    const destinationFee = proveFee + executeFee;

    // Estimate timing for Base -> SVM
    // - Base finality: ~2 seconds
    // - Proof availability: depends on Solana bridge state updates
    // - Prove + Execute: ~1-2 seconds each on Solana
    // Total: ~1-5 minutes depending on bridge state sync
    const estimatedTimeMs = {
      min: 60_000, // 1 minute optimistic
      max: 300_000, // 5 minutes conservative
    };

    const quote: Quote = {
      route: req.route,
      estimatedFees: {
        source: {
          amount: sourceGasCost,
          token: "ETH",
        },
        destination: {
          amount: destinationFee,
          token: "SOL",
          note: "estimate varies based on instruction complexity",
        },
      },
      estimatedTimeMs,
    };

    // Note: No auto-relay for Base -> SVM, so no relay fee
    // User must manually prove and execute

    if (warnings.length > 0) {
      quote.warnings = warnings;
    }

    return quote;
  }

  /**
   * Estimate gas for the initiate operation on Base.
   */
  private async estimateInitiateGas(req: QuoteRequest): Promise<bigint> {
    if (req.action.kind === "call") {
      if (!isSolanaDestinationCall(req.action.call)) {
        throw new BridgeUnsupportedActionError({
          route: req.route,
          actionKind: "base->svm: call requires SolanaCall",
        });
      }
      // Estimate gas for bridgeCall
      const instructionCount = req.action.call.call.instructions.length;
      return (
        BRIDGE_CALL_BASE_GAS + BigInt(instructionCount) * GAS_PER_INSTRUCTION
      );
    }

    if (req.action.kind === "transfer") {
      // Estimate gas for bridgeToken
      const call = req.action.call;
      if (call) {
        if (!isSolanaDestinationCall(call)) {
          throw new BridgeUnsupportedActionError({
            route: req.route,
            actionKind: "base->svm: transfer call requires SolanaCall",
          });
        }
        const instructionCount = call.call.instructions.length;
        return (
          BRIDGE_TOKEN_BASE_GAS + BigInt(instructionCount) * GAS_PER_INSTRUCTION
        );
      }
      return BRIDGE_TOKEN_BASE_GAS;
    }

    return BRIDGE_TOKEN_BASE_GAS;
  }

  /**
   * Estimate Solana execute transaction fee by simulating the instructions.
   * Falls back to heuristic estimation if simulation fails.
   */
  private async estimateExecuteFee(
    req: QuoteRequest,
    warnings: string[],
  ): Promise<bigint> {
    // Extract instructions from the request
    const destCall = req.action.call;
    const instructions: SolanaInstruction[] =
      destCall && isSolanaDestinationCall(destCall)
        ? destCall.call.instructions
        : [];

    if (instructions.length === 0) {
      // No custom instructions, just the bridge execute overhead
      return SOLANA_BASE_TX_FEE + BASE_EXECUTE_FEE_LAMPORTS;
    }

    // Convert SDK instructions to @solana/kit Instruction format
    const solanaInstructions = this.convertToInstruction(instructions);

    // Try to simulate to get accurate compute units
    const computeUnits =
      await this.solanaEngine.simulateInstructions(solanaInstructions);

    if (computeUnits !== undefined) {
      // Simulation succeeded - calculate fee based on actual compute units
      const totalCU = computeUnits + BRIDGE_EXECUTE_OVERHEAD_CU;
      // Fee = base tx fee + compute budget fee
      // Note: This is a simplified model; actual fees depend on priority fee market
      const computeFee = (totalCU * LAMPORTS_PER_CU) / 1_000_000n; // microlamports to lamports
      return (
        SOLANA_BASE_TX_FEE +
        (computeFee > 0n ? computeFee : MIN_COMPUTE_FEE_LAMPORTS)
      );
    }

    // Simulation failed - fall back to heuristic
    warnings.push(
      `Could not simulate instructions; using heuristic estimate for ${instructions.length} instruction(s)`,
    );

    return (
      SOLANA_BASE_TX_FEE +
      BigInt(instructions.length) * FALLBACK_LAMPORTS_PER_INSTRUCTION
    );
  }

  /**
   * Convert SDK SolanaInstruction[] to @solana/kit Instruction[] for simulation.
   */
  private convertToInstruction(
    instructions: SolanaInstruction[],
  ): Instruction[] {
    return instructions.map((ix) => ({
      programAddress: solAddress(ix.programId),
      accounts: ix.accounts.map((acc) => ({
        address: solAddress(acc.pubkey),
        role: acc.isSigner
          ? acc.isWritable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
          : acc.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
      })),
      data:
        ix.data instanceof Uint8Array
          ? ix.data
          : toBytes(ix.data as `0x${string}`),
    })) as Instruction[];
  }

  async initiate(req: BridgeRequest): Promise<BridgeOperation> {
    if (req.action.kind === "call") {
      return this.initiateCall(req);
    }

    if (req.action.kind === "transfer") {
      return this.initiateTransfer(req);
    }

    // Exhaustive check - this should never be reached
    const _exhaustive: never = req.action;
    throw new BridgeUnsupportedActionError({
      route: req.route,
      actionKind: (_exhaustive as { kind: string }).kind,
    });
  }

  /**
   * Initiate a pure call action (Solana instructions only, no transfer).
   */
  private async initiateCall(req: BridgeRequest): Promise<BridgeOperation> {
    if (req.action.kind !== "call") {
      throw new BridgeInvariantViolationError("Expected call action", {
        stage: "initiate",
        route: req.route,
      });
    }

    const destCall = req.action.call;
    if (!isSolanaDestinationCall(destCall)) {
      throw new BridgeUnsupportedActionError({
        route: req.route,
        actionKind:
          "base->svm: call requires SolanaCall (kind: 'solana'). Use { kind: 'solana', call: { instructions: [...] } }",
      });
    }

    const ixs = this.convertToIx(destCall.call.instructions);
    const txHash = await wrapEngineError(
      () => this.baseEngine.bridgeCall({ ixs }),
      { route: req.route, chain: req.route.sourceChain, stage: "initiate" },
    );

    return this.buildOperation(req, txHash);
  }

  /**
   * Initiate a transfer action, optionally with a SolanaCall for transfer+call.
   */
  private async initiateTransfer(req: BridgeRequest): Promise<BridgeOperation> {
    if (req.action.kind !== "transfer") {
      throw new BridgeInvariantViolationError("Expected transfer action", {
        stage: "initiate",
        route: req.route,
      });
    }

    if (req.action.asset.kind !== "token") {
      throw new BridgeUnsupportedActionError({
        route: req.route,
        actionKind: "base->svm: only token transfers supported",
      });
    }

    const localToken = req.action.asset.address as Hex;
    const mint = this.tokenMapping?.[localToken];
    if (!mint) {
      throw new BridgeUnsupportedActionError({
        route: req.route,
        actionKind: "transfer(token): missing tokenMappings for ERC20",
      });
    }

    // Convert optional SolanaCall to Ix[] for transfer+call
    const ixs = this.extractSolanaIxs(req.action.call);
    const { recipient, amount } = req.action;

    const txHash = await wrapEngineError(
      () =>
        this.baseEngine.bridgeToken({
          transfer: {
            localToken,
            remoteToken: solAddress(mint),
            to: solAddress(recipient),
            amount,
          },
          ixs,
        }),
      { route: req.route, chain: req.route.sourceChain, stage: "initiate" },
    );

    return this.buildOperation(req, txHash);
  }

  /**
   * Extract the MessageInitiated event from a tx receipt and build the
   * common BridgeOperation returned by all initiation helpers.
   */
  private async buildOperation(
    req: BridgeRequest,
    txHash: Hash,
  ): Promise<BridgeOperation> {
    const { messageHash, nonce, sender, data, mmrRoot } =
      await this.extractMessageInitiated(txHash, {
        route: req.route,
        chain: req.route.sourceChain,
      });

    const messageRef: MessageRef = {
      route: req.route,
      source: {
        chain: req.route.sourceChain,
        id: { scheme: "evm:messageHash", value: messageHash },
      },
      derived: {
        txHash,
        nonce: nonce.toString(),
        sender,
        data,
        mmrRoot,
      },
    };

    return {
      request: req,
      messageRef,
      initiationTx: txHash,
    };
  }

  /**
   * Extract Solana instructions from an optional DestinationCall.
   * Returns empty array if no call, throws if call is not a SolanaCall.
   */
  private extractSolanaIxs(call?: DestinationCall): Ix[] {
    if (!call) return [];

    if (!isSolanaDestinationCall(call)) {
      throw new BridgeUnsupportedActionError({
        route: this.route,
        actionKind:
          "base->svm: transfer call must be SolanaCall (kind: 'solana')",
      });
    }

    return this.convertToIx(call.call.instructions);
  }

  /**
   * Convert SDK SolanaInstruction[] to internal Ix[] format used by the bridge.
   */
  private convertToIx(instructions: SolanaInstruction[]): Ix[] {
    return instructions.map((ix) => ({
      programId: solAddress(ix.programId),
      accounts: ix.accounts.map((acc) => ({
        pubkey: solAddress(acc.pubkey),
        isWritable: acc.isWritable,
        isSigner: acc.isSigner,
      })),
      data:
        ix.data instanceof Uint8Array
          ? ix.data
          : toBytes(ix.data as `0x${string}`),
    }));
  }

  async prove(ref: MessageRef, opts?: ProveOptions): Promise<ProveResult> {
    const txHash = ref.derived?.txHash as Hash | undefined;
    if (!txHash) {
      throw new BridgeProofNotAvailableError(
        "Missing derived.txHash; cannot prove without the initiating EVM transaction hash.",
        { route: ref.route, chain: ref.route.sourceChain },
      );
    }

    const proveOnSource = {
      route: ref.route,
      chain: ref.route.sourceChain,
      stage: "prove" as const,
    };
    const proveOnDest = {
      route: ref.route,
      chain: ref.route.destinationChain,
      stage: "prove" as const,
    };

    const blockNumber =
      opts?.sourceBlockNumber ??
      (await wrapEngineError(
        () => this.solanaEngine.getLatestBaseBlockNumber(),
        proveOnDest,
      ));

    const { event, rawProof } = await wrapEngineError(
      () =>
        this.baseEngine.generateProof(txHash, blockNumber, {
          route: ref.route,
          chain: ref.route.sourceChain,
        }),
      proveOnSource,
    );

    const estimatedDataLen = (event.message.data.length - 2) / 2;
    const proofPayloadSize =
      PROVE_FIXED_OVERHEAD + estimatedDataLen + rawProof.length * 32;

    if (proofPayloadSize > PROVE_BUFFER_THRESHOLD) {
      const dataBytes = toBytes(event.message.data);
      const proofNodes = rawProof.map((e) => toBytes(e));
      return this.proveWithBuffer(
        ref,
        event,
        dataBytes,
        proofNodes,
        blockNumber,
        proveOnDest,
      );
    }

    const res = await wrapEngineError(
      () => this.solanaEngine.handleProveMessage(event, rawProof, blockNumber),
      proveOnDest,
    );

    if (!res.signature) {
      return { messageRef: ref };
    }

    return { messageRef: ref, proofTx: res.signature };
  }

  private async proveWithBuffer(
    ref: MessageRef,
    event: {
      messageHash: `0x${string}`;
      message: {
        nonce: bigint;
        sender: `0x${string}`;
      };
    },
    dataBytes: Uint8Array,
    proofNodes: Uint8Array[],
    blockNumber: bigint,
    proveOnDest: BridgeContext & { stage: "prove" },
  ): Promise<ProveResult> {
    const alreadyProven = await wrapEngineError(
      () => this.solanaEngine.isMessageAlreadyProven(event.messageHash),
      proveOnDest,
    );
    if (alreadyProven) {
      return { messageRef: ref };
    }

    const { bufferAddress } = await wrapEngineError(
      () =>
        this.solanaEngine.initializeProveBuffer({
          maxDataLen: BigInt(dataBytes.length),
          maxProofLen: BigInt(proofNodes.length),
        }),
      proveOnDest,
    );

    try {
      // Data and proof target independent buffer segments, so append concurrently.
      await Promise.all([
        this.appendDataChunks(bufferAddress, dataBytes, proveOnDest),
        this.appendProofChunks(bufferAddress, proofNodes, proveOnDest),
      ]);

      const res = await wrapEngineError(
        () =>
          this.solanaEngine.proveMessageBuffered({
            bufferAddress,
            event,
            blockNumber,
          }),
        proveOnDest,
      );

      if (!res.signature) {
        // Already proven — buffer is still alive, close to recover rent.
        try {
          await this.solanaEngine.closeProveBuffer({ bufferAddress });
        } catch {}
        return { messageRef: ref };
      }

      return { messageRef: ref, proofTx: res.signature };
    } catch (e) {
      try {
        await this.solanaEngine.closeProveBuffer({ bufferAddress });
      } catch {}
      throw e;
    }
  }

  private async appendDataChunks(
    bufferAddress: SolAddress,
    dataBytes: Uint8Array,
    ctx: BridgeContext & { stage: "prove" },
  ): Promise<void> {
    for (
      let offset = 0;
      offset < dataBytes.length;
      offset += PROVE_DATA_CHUNK_SIZE
    ) {
      const chunk = dataBytes.subarray(offset, offset + PROVE_DATA_CHUNK_SIZE);
      await wrapEngineError(
        () =>
          this.solanaEngine.appendToProveBufferData({
            bufferAddress,
            chunk,
          }),
        ctx,
      );
    }
  }

  private async appendProofChunks(
    bufferAddress: SolAddress,
    proofNodes: Uint8Array[],
    ctx: BridgeContext & { stage: "prove" },
  ): Promise<void> {
    for (let i = 0; i < proofNodes.length; i += PROVE_PROOF_CHUNK_SIZE) {
      const proofChunk = proofNodes.slice(i, i + PROVE_PROOF_CHUNK_SIZE);
      await wrapEngineError(
        () =>
          this.solanaEngine.appendToProveBufferProof({
            bufferAddress,
            proofChunk,
          }),
        ctx,
      );
    }
  }

  async execute(
    ref: MessageRef,
    _opts?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const messageHash =
      ref.source.id.scheme === "evm:messageHash"
        ? (ref.source.id.value as Hex)
        : undefined;
    if (!messageHash) {
      throw new BridgeUnsupportedActionError({
        route: ref.route,
        actionKind: "execute: missing evm:messageHash source id",
      });
    }

    const sig = await wrapEngineError(
      () => this.solanaEngine.handleExecuteMessage(messageHash),
      {
        route: ref.route,
        chain: ref.route.destinationChain,
        stage: "execute",
      },
    );
    return { messageRef: ref, executionTx: sig };
  }

  async status(
    ref: MessageRef,
    opts?: StatusOptions,
  ): Promise<ExecutionStatus> {
    const at = Date.now();
    const messageHash =
      ref.source.id.scheme === "evm:messageHash"
        ? (ref.source.id.value as Hex)
        : undefined;
    if (!messageHash) return { type: "Unknown", at };

    const pda = await this.deriveIncomingMessagePdaCached(messageHash);

    const maybe = await wrapEngineError(
      () =>
        fetchMaybeIncomingMessage(this.solanaRpc, pda, {
          abortSignal: opts?.signal,
        }),
      {
        route: ref.route,
        chain: ref.route.destinationChain,
        stage: "monitor",
      },
    );

    if (!maybe.exists) {
      return { type: "Initiated", at, sourceTx: ref.derived?.txHash };
    }

    if (maybe.data.executed) {
      return { type: "Executed", at };
    }

    return { type: "Executable", at };
  }

  monitor(
    ref: MessageRef,
    opts?: MonitorOptions,
  ): AsyncIterable<ExecutionStatus> {
    return pollingMonitor((signal) => this.status(ref, { signal }), opts);
  }

  private async deriveIncomingMessagePdaCached(
    messageHash: Hex,
  ): Promise<SolAddress> {
    const cached = this.pdaCache.get(messageHash);
    if (cached) return cached;

    const pda = await deriveIncomingMessagePda(
      this.solanaDeployment.bridgeProgram,
      messageHash,
    );
    this.pdaCache.set(messageHash, pda);
    return pda;
  }

  private async extractMessageInitiated(
    txHash: Hash,
    context: BridgeContext,
  ): Promise<{
    messageHash: Hex;
    mmrRoot: Hex;
    nonce: bigint;
    sender: Hex;
    data: Hex;
  }> {
    const receipt = await wrapEngineError(
      () => this.evm.publicClient.getTransactionReceipt({ hash: txHash }),
      { route: context.route, chain: context.chain, stage: "initiate" },
    );
    const [e, ...rest] = decodeMessageInitiatedEvents(receipt.logs);

    if (!e || rest.length > 0) {
      throw new BridgeProofNotAvailableError(
        `Expected exactly 1 MessageInitiated event in tx receipt; found ${e ? rest.length + 1 : 0}`,
        context,
      );
    }

    return {
      messageHash: e.messageHash as Hex,
      mmrRoot: e.mmrRoot as Hex,
      nonce: BigInt(e.message.nonce),
      sender: e.message.sender as Hex,
      data: e.message.data as Hex,
    };
  }
}
