import type { Address as SolAddress, Instruction } from "@solana/kit";
import { address as solAddress } from "@solana/kit";
import type { Hash, Hex } from "viem";
import { decodeEventLog, toBytes } from "viem";
import {
  BridgeAlreadyExecutedError,
  BridgeNotProvenError,
  BridgeProofNotAvailableError,
  BridgeUnsupportedActionError,
} from "../../errors";
import { pollingMonitor } from "../../monitor/polling";
import type {
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
import type { Ix } from "../../../clients/ts/src/bridge";
import type { EvmChainAdapter } from "../../../adapters/chains/evm/types";
import type { SolanaChainAdapter } from "../../../adapters/chains/solana/types";
import type { EngineConfig } from "../engines/types";
import { SolanaEngine } from "../engines/solana-engine";
import { BaseEngine } from "../engines/base-engine";
import { BRIDGE_ABI } from "../../../interfaces/abis/bridge.abi";

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

  constructor(args: {
    route: BridgeRoute;
    solana: SolanaChainAdapter;
    evm: EvmChainAdapter;
    solanaDeployment: { bridgeProgram: SolAddress; relayerProgram: SolAddress };
    evmDeployment: { bridgeContract: Hex };
    tokenMapping?: Record<string, string>;
  }) {
    this.route = args.route;
    this.solana = args.solana;
    this.evm = args.evm;
    this.solanaDeployment = args.solanaDeployment;
    this.evmDeployment = args.evmDeployment;
    this.tokenMapping = args.tokenMapping;

    const engineConfig: EngineConfig = {
      solana: {
        rpcUrl: this.solana.rpcUrl,
        payerKp: this.solana.payerKeypairPath,
        bridgeProgram: this.solanaDeployment.bridgeProgram,
        relayerProgram: this.solanaDeployment.relayerProgram,
      },
      base: {
        rpcUrl: this.evm.rpcUrl,
        bridgeContract: this.evmDeployment.bridgeContract,
        chain: this.evm.viemChain,
        privateKey: this.evm.privateKey,
      },
    };

    this.solanaEngine = new SolanaEngine({ config: engineConfig });
    this.baseEngine = new BaseEngine({ config: engineConfig });
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
    } catch {
      // If estimation fails, use conservative defaults
      sourceGas = req.action.kind === "call" ? 150_000n : 200_000n;
      warnings.push("Source gas estimation failed, using conservative estimate");
    }

    // Get current gas price from Base
    const gasPrice = await this.evm.publicClient.getGasPrice();
    const sourceGasCost = sourceGas * gasPrice;

    // Estimate destination chain fees (Solana)
    // Solana base tx fee: 5000 lamports per signature
    // Prove tx: fixed cost (~5000 lamports base + minimal compute)
    // Execute tx: variable cost depending on user instructions
    const SOLANA_BASE_TX_FEE = 5_000n;
    const SOLANA_PROVE_COMPUTE = 5_000n; // Prove is a fixed operation
    const proveFee = SOLANA_BASE_TX_FEE + SOLANA_PROVE_COMPUTE;

    // Execute fee depends on the instructions being run
    // We simulate the instructions to get accurate compute unit estimates
    const executeFee = await this.estimateExecuteFee(req, warnings);
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
      // Base cost ~100k gas + ~5k per instruction
      const instructionCount = req.action.call.call.instructions.length;
      return 100_000n + BigInt(instructionCount) * 5_000n;
    }

    if (req.action.kind === "transfer") {
      // Estimate gas for bridgeToken
      // Base cost ~150k gas, with call ~200k+
      const call = req.action.call;
      if (call) {
        if (!isSolanaDestinationCall(call)) {
          throw new BridgeUnsupportedActionError({
            route: req.route,
            actionKind: "base->svm: transfer call requires SolanaCall",
          });
        }
        const instructionCount = call.call.instructions.length;
        return 150_000n + BigInt(instructionCount) * 5_000n;
      }
      return 150_000n;
    }

    return 150_000n;
  }

  /**
   * Estimate Solana execute transaction fee by simulating the instructions.
   * Falls back to heuristic estimation if simulation fails.
   */
  private async estimateExecuteFee(
    req: QuoteRequest,
    warnings: string[]
  ): Promise<bigint> {
    const SOLANA_BASE_TX_FEE = 5_000n;
    // Bridge execute overhead (CPI, account validation, etc.)
    const BRIDGE_EXECUTE_OVERHEAD_CU = 50_000n;
    // Lamports per compute unit (current Solana priority fee model)
    // Base fee covers ~200k CU, additional CU cost ~1 microlamport each
    const LAMPORTS_PER_CU = 1n; // Conservative: 1 microlamport per CU

    // Extract instructions from the request
    let instructions: SolanaInstruction[] = [];
    if (req.action.kind === "call") {
      if (isSolanaDestinationCall(req.action.call)) {
        instructions = req.action.call.call.instructions;
      }
    } else if (req.action.kind === "transfer" && req.action.call) {
      if (isSolanaDestinationCall(req.action.call)) {
        instructions = req.action.call.call.instructions;
      }
    }

    if (instructions.length === 0) {
      // No custom instructions, just the bridge execute overhead
      return SOLANA_BASE_TX_FEE + 10_000n;
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
      return SOLANA_BASE_TX_FEE + (computeFee > 0n ? computeFee : 5_000n);
    }

    // Simulation failed - fall back to heuristic
    warnings.push(
      `Could not simulate instructions; using heuristic estimate for ${instructions.length} instruction(s)`
    );

    // Conservative fallback: 50k lamports per instruction
    const LAMPORTS_PER_INSTRUCTION = 50_000n;
    return SOLANA_BASE_TX_FEE + BigInt(instructions.length) * LAMPORTS_PER_INSTRUCTION;
  }

  /**
   * Convert SDK SolanaInstruction[] to @solana/kit Instruction[] for simulation.
   */
  private convertToInstruction(instructions: SolanaInstruction[]): Instruction[] {
    return instructions.map((ix) => ({
      programAddress: solAddress(ix.programId),
      accounts: ix.accounts.map((acc) => ({
        address: solAddress(acc.pubkey),
        role: acc.isSigner
          ? acc.isWritable
            ? 3 // AccountRole.WRITABLE_SIGNER
            : 2 // AccountRole.READONLY_SIGNER
          : acc.isWritable
            ? 1 // AccountRole.WRITABLE
            : 0, // AccountRole.READONLY
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
      throw new Error("Expected call action");
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
    const txHash = await this.baseEngine.bridgeCall({ ixs });

    const { messageHash, nonce, sender, data, mmrRoot } =
      await this.extractMessageInitiated(txHash);

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
      route: req.route,
      request: req,
      messageRef,
      initiationTx: txHash,
    };
  }

  /**
   * Initiate a transfer action, optionally with a SolanaCall for transfer+call.
   */
  private async initiateTransfer(req: BridgeRequest): Promise<BridgeOperation> {
    if (req.action.kind !== "transfer") {
      throw new Error("Expected transfer action");
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

    const txHash = await this.baseEngine.bridgeToken({
      transfer: {
        localToken,
        remoteToken: solAddress(mint),
        to: solAddress(req.action.recipient),
        amount: req.action.amount,
      },
      ixs,
    });

    const { messageHash, nonce, sender, data, mmrRoot } =
      await this.extractMessageInitiated(txHash);

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
      route: req.route,
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
        { route: ref.route, chain: ref.route.sourceChain }
      );
    }

    const blockNumber =
      opts?.sourceBlockNumber ??
      (await this.solanaEngine.getLatestBaseBlockNumber());

    const { event, rawProof } = await this.baseEngine.generateProof(
      txHash,
      blockNumber
    );
    const res = await this.solanaEngine.handleProveMessage(
      event,
      rawProof,
      blockNumber
    );

    if (!res.signature) {
      return { messageRef: ref };
    }

    return { messageRef: ref, proofTx: res.signature };
  }

  async execute(
    ref: MessageRef,
    _opts?: ExecuteOptions
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

    try {
      const sig = await this.solanaEngine.handleExecuteMessage(messageHash);
      return { messageRef: ref, executionTx: sig };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("already been executed")) {
        throw new BridgeAlreadyExecutedError(
          "Message already executed on SVM",
          {
            route: ref.route,
            chain: ref.route.destinationChain,
          }
        );
      }
      if (msg.includes("Ensure it has been proven")) {
        throw new BridgeNotProvenError("Message not proven on SVM", {
          route: ref.route,
          chain: ref.route.destinationChain,
        });
      }
      throw e;
    }
  }

  async status(
    ref: MessageRef,
    _opts?: StatusOptions
  ): Promise<ExecutionStatus> {
    const at = Date.now();
    const messageHash =
      ref.source.id.scheme === "evm:messageHash"
        ? (ref.source.id.value as Hex)
        : undefined;
    if (!messageHash) return { type: "Unknown", at };

    const pda = await this.deriveIncomingMessagePda(messageHash);

    const rpc = (await import("@solana/kit")).createSolanaRpc(
      this.solana.rpcUrl
    );
    const { fetchMaybeIncomingMessage } = await import(
      "../../../clients/ts/src/bridge"
    );
    const maybe = await fetchMaybeIncomingMessage(rpc, pda);

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
    opts?: MonitorOptions
  ): AsyncIterable<ExecutionStatus> {
    return pollingMonitor(() => this.status(ref), opts);
  }

  private async deriveIncomingMessagePda(
    messageHash: Hex
  ): Promise<SolAddress> {
    const { getProgramDerivedAddress } = await import("@solana/kit");
    const { getIdlConstant } = await import(
      "../../../utils/bridge-idl.constants"
    );
    const seeds = [
      Buffer.from(getIdlConstant("INCOMING_MESSAGE_SEED")),
      Buffer.from((await import("viem")).toBytes(messageHash)),
    ];
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.solanaDeployment.bridgeProgram,
      seeds,
    });
    return pda;
  }

  private async extractMessageInitiated(txHash: Hash): Promise<{
    messageHash: Hex;
    mmrRoot: Hex;
    nonce: bigint;
    sender: Hex;
    data: Hex;
  }> {
    const receipt = await this.evm.publicClient.getTransactionReceipt({
      hash: txHash,
    });
    const events = receipt.logs
      .map((log) => {
        try {
          const decoded = decodeEventLog({
            abi: BRIDGE_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName !== "MessageInitiated") return null;
          return decoded.args as any;
        } catch {
          return null;
        }
      })
      .filter((x) => x !== null);

    if (events.length !== 1) {
      throw new BridgeProofNotAvailableError(
        `Expected exactly 1 MessageInitiated event in tx receipt; found ${events.length}`,
        { route: this.route, chain: this.route.sourceChain }
      );
    }

    const e = events[0] as any;
    return {
      messageHash: e.messageHash as Hex,
      mmrRoot: e.mmrRoot as Hex,
      nonce: BigInt(e.message.nonce),
      sender: e.message.sender as Hex,
      data: e.message.data as Hex,
    };
  }
}
