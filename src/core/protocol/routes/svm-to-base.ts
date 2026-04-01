import type { Signature, Address as SolAddress } from "@solana/kit";
import { address as solAddress } from "@solana/kit";
import type { Hash, Hex } from "viem";
import { hexToBytes, toBytes } from "viem";
import type { EvmChainAdapter } from "../../../adapters/chains/evm/types";
import type { SolanaChainAdapter } from "../../../adapters/chains/solana/types";
import { CallType } from "../../../clients/ts/src/bridge";
import { BRIDGE_ABI } from "../../../interfaces/abis/bridge.abi";
import type { Logger } from "../../../utils/logger";
import {
  BridgeInvariantViolationError,
  BridgeUnsupportedActionError,
  BridgeUnsupportedStepError,
  wrapEngineError,
} from "../../errors";
import { pollingMonitor } from "../../monitor/polling";
import type {
  BridgeContext,
  BridgeOperation,
  BridgeRequest,
  BridgeRoute,
  DestinationCall,
  EvmCall,
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
  RouteStep,
  StatusOptions,
} from "../../types";
import { isEvmDestinationCall } from "../../utils";
import { buildEvmIncomingMessage } from "../encoding";
import { BaseEngine } from "../engines/base-engine";
import {
  DEFAULT_EVM_GAS_LIMIT,
  SOLANA_BASE_TX_FEE,
} from "../engines/constants";
import { SolanaEngine } from "../engines/solana-engine";

// ─────────────────────────────────────────────────────────────────────────────
// Call data buffering constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Byte threshold beyond which call data must use the buffered path.
 * Solana transactions are limited to ~1,232 bytes; after accounting for
 * signatures, blockhash, accounts, and instruction overhead, ~900 bytes
 * of call data is the practical maximum for inline instructions.
 */
const CALL_DATA_BUFFER_THRESHOLD = 900;

/**
 * Maximum bytes of call data in the `initializeCallBuffer` transaction.
 * Slightly smaller than the append chunk size because the init instruction
 * carries additional fields (callType, to, value, maxDataLen) and requires
 * an extra signer (the callBuffer keypair).
 */
const INIT_CHUNK_SIZE = 800;

/**
 * Maximum bytes of call data per `appendToCallBuffer` transaction.
 * The append instruction has minimal overhead (discriminator + data).
 */
const APPEND_CHUNK_SIZE = 900;

// ─────────────────────────────────────────────────────────────────────────────
// Fee estimation constants for SVM -> Base quotes
// ─────────────────────────────────────────────────────────────────────────────

/** Additional compute unit buffer for bridge operations */
const SOLANA_COMPUTE_UNIT_BUFFER = 10_000n;
/** Base gas cost for token transfer on Base (without call) */
const BASE_TOKEN_TRANSFER_GAS = 65_000n;

// ─────────────────────────────────────────────────────────────────────────────
// Timing estimates for SVM -> Base (in milliseconds)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum expected time: Solana finality (~400ms) + validator (~30s) + Base (~2s) */
const MIN_TIME_MS = 30_000;
/** Maximum expected time: conservative estimate with delays */
const MAX_TIME_MS = 120_000;

// ─────────────────────────────────────────────────────────────────────────────
// Message identification schemes
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_ID_SCHEME = "solana:outgoingMessagePda" as const;
const DESTINATION_ID_SCHEME = "evm:bridgeOuterHash" as const;

/**
 * SVM -> Base route adapter.
 *
 * `initiate()` dispatches to private helpers by action kind / asset kind,
 * mirroring the dispatcher pattern used by {@link BaseToSvmRouteAdapter}.
 * Common post-initiation work (outer-hash derivation, MessageRef construction,
 * and BridgeOperation assembly) is consolidated in {@link buildOperation} and
 * {@link buildMessageRef}.
 *
 * Note: We keep the underlying chain IDs as `solana:*` for now, but route naming
 * uses the more general "SVM" terminology.
 */
export class SvmToBaseRouteAdapter implements RouteAdapter {
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
      logger: args.logger,
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
  }

  async capabilities(): Promise<RouteCapabilities> {
    return {
      steps: ["initiate", "execute", "monitor"],
      autoRelay: true,
      manualExecute: this.evm.privateKey !== undefined,
      prove: false,
      supportsQuote: true,
    };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const gasLimit = req.relay?.gasLimit ?? DEFAULT_EVM_GAS_LIMIT;
    const relayMode = req.relay?.mode ?? "auto";
    const warnings: string[] = [];

    // Fetch on-chain config for fee estimation
    const { relayerGasConfig } = await wrapEngineError(
      () => this.solanaEngine.getGasConfigs(),
      { route: req.route, chain: req.route.sourceChain, stage: "initiate" },
    );

    // Estimate source chain fees (Solana transaction fees)
    const sourceGasFee = SOLANA_BASE_TX_FEE + SOLANA_COMPUTE_UNIT_BUFFER;

    // Calculate relay fee if auto-relay is requested
    let relayFee: bigint | undefined;
    if (relayMode === "auto") {
      // Relay fee calculation: (gasLimit * gasCostScaler) / gasCostScalerDp
      // This converts EVM gas to lamports based on current pricing
      relayFee =
        (gasLimit * relayerGasConfig.gasCostScaler) /
        relayerGasConfig.gasCostScalerDp;

      // Validate gas limit is within allowed bounds
      if (gasLimit < relayerGasConfig.minGasLimitPerMessage) {
        warnings.push(
          `Gas limit ${gasLimit} is below minimum ${relayerGasConfig.minGasLimitPerMessage}`,
        );
      }
      if (gasLimit > relayerGasConfig.maxGasLimitPerMessage) {
        warnings.push(
          `Gas limit ${gasLimit} exceeds maximum ${relayerGasConfig.maxGasLimitPerMessage}`,
        );
      }
    }

    // Estimate destination chain fees (Base execution)
    // For SVM -> Base, the relayer pays the destination gas
    // Users only pay the relay fee upfront on Solana
    let destinationGas: bigint | undefined;
    if (req.action.kind === "call") {
      const evmCall = this.extractEvmCall(req.action.call);
      try {
        destinationGas = await this.baseEngine.estimateGasForCall({
          to: evmCall.to,
          value: evmCall.value,
          data: evmCall.data,
        });
      } catch (err) {
        // Gas estimation may fail if call would revert, use default
        destinationGas = gasLimit;
        warnings.push(
          `Destination gas estimation failed: ${err instanceof Error ? err.message : String(err)}. Using provided limit.`,
        );
      }
    } else if (req.action.kind === "transfer") {
      // Transfer operations have predictable gas costs on Base
      destinationGas = req.action.call ? gasLimit : BASE_TOKEN_TRANSFER_GAS;
    }

    const estimatedTimeMs = {
      min: MIN_TIME_MS,
      max: MAX_TIME_MS,
    };

    const quote: Quote = {
      route: req.route,
      estimatedFees: {
        source: {
          amount: sourceGasFee + (relayFee ?? 0n),
          token: "SOL",
        },
      },
      estimatedTimeMs,
    };

    // Add destination fee info (informational - paid by relayer)
    if (destinationGas !== undefined) {
      quote.estimatedFees.destination = {
        amount: destinationGas,
        token: "ETH",
        note: "paid by relayer",
      };
    }

    // Add relay fee breakdown if applicable
    if (relayMode === "auto" && relayFee !== undefined) {
      quote.estimatedFees.relay = {
        amount: relayFee,
        token: "SOL",
      };
    }

    if (warnings.length > 0) {
      quote.warnings = warnings;
    }

    return quote;
  }

  async initiate(req: BridgeRequest): Promise<BridgeOperation> {
    if (req.action.kind === "call") {
      return this.initiateCall(req);
    }

    if (req.action.kind === "transfer") {
      const asset = req.action.asset;
      if (asset.kind === "native") return this.initiateNativeTransfer(req);
      if (asset.kind === "token") return this.initiateTokenTransfer(req);
      if (asset.kind === "wrapped") return this.initiateWrappedTransfer(req);

      // Exhaustive asset kind check
      const _exhaustiveAsset: never = asset;
      throw new BridgeUnsupportedActionError({
        route: req.route,
        actionKind: (_exhaustiveAsset as { kind: string }).kind,
      });
    }

    // Exhaustive check - this should never be reached
    const _exhaustive: never = req.action;
    throw new BridgeUnsupportedActionError({
      route: req.route,
      actionKind: (_exhaustive as { kind: string }).kind,
    });
  }

  /** Initiate a pure call action (EVM call only, no transfer). */
  private async initiateCall(req: BridgeRequest): Promise<BridgeOperation> {
    if (req.action.kind !== "call") {
      throw new BridgeInvariantViolationError("Expected call action", {
        stage: "initiate",
        route: req.route,
      });
    }

    const evmCall = this.extractEvmCall(req.action.call);
    const gasLimit = req.relay?.gasLimit ?? DEFAULT_EVM_GAS_LIMIT;
    const payForRelay = (req.relay?.mode ?? "auto") === "auto";

    return this.dispatchBridgeOp(
      req,
      evmCall,
      gasLimit,
      () =>
        this.solanaEngine.bridgeCall({
          to: evmCall.to,
          value: evmCall.value,
          data: evmCall.data,
          ty: evmCall.ty,
          payForRelay,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        }),
      (buffer) =>
        this.solanaEngine.bridgeCallBuffered({
          bufferAddress: buffer,
          payForRelay,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        }),
    );
  }

  /** Initiate a native SOL transfer, optionally with an EVM call. */
  private async initiateNativeTransfer(
    req: BridgeRequest,
  ): Promise<BridgeOperation> {
    if (req.action.kind !== "transfer") {
      throw new BridgeInvariantViolationError("Expected transfer action", {
        stage: "initiate",
        route: req.route,
      });
    }

    const to = req.action.recipient as `0x${string}`;
    const amount = req.action.amount;
    const { evmCall, gasLimit, payForRelay } = this.transferDefaults(
      req,
      req.action.call,
    );

    return this.dispatchBridgeOp(
      req,
      evmCall,
      gasLimit,
      () =>
        this.solanaEngine.bridgeSol({
          to,
          amount,
          payForRelay,
          call: evmCall,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        }),
      (buffer) =>
        this.solanaEngine.bridgeSolWithBufferedCall({
          bufferAddress: buffer,
          to,
          amount,
          payForRelay,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        }),
    );
  }

  /** Initiate an SPL token transfer, optionally with an EVM call. */
  private async initiateTokenTransfer(
    req: BridgeRequest,
  ): Promise<BridgeOperation> {
    if (req.action.kind !== "transfer") {
      throw new BridgeInvariantViolationError("Expected transfer action", {
        stage: "initiate",
        route: req.route,
      });
    }

    const mint =
      req.action.asset.kind === "token" ? req.action.asset.address : undefined;
    const remoteToken = mint ? this.tokenMapping?.[mint] : undefined;
    if (!mint || !remoteToken) {
      throw new BridgeUnsupportedActionError({
        route: req.route,
        actionKind: "transfer(token): missing tokenMappings for mint",
      });
    }

    const to = req.action.recipient as `0x${string}`;
    const amount = req.action.amount;
    const { evmCall, gasLimit, payForRelay } = this.transferDefaults(
      req,
      req.action.call,
    );

    return this.dispatchBridgeOp(
      req,
      evmCall,
      gasLimit,
      () =>
        this.solanaEngine.bridgeSpl({
          to,
          mint,
          remoteToken,
          amount,
          payForRelay,
          call: evmCall,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        }),
      (buffer) =>
        this.solanaEngine.bridgeSplWithBufferedCall({
          bufferAddress: buffer,
          to,
          mint,
          remoteToken,
          amount,
          payForRelay,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        }),
    );
  }

  /** Initiate a wrapped token transfer, optionally with an EVM call. */
  private async initiateWrappedTransfer(
    req: BridgeRequest,
  ): Promise<BridgeOperation> {
    if (req.action.kind !== "transfer" || req.action.asset.kind !== "wrapped") {
      throw new BridgeInvariantViolationError(
        "Expected wrapped transfer action",
        { stage: "initiate", route: req.route },
      );
    }

    const to = req.action.recipient as `0x${string}`;
    const mintAddress = req.action.asset.address;
    const amount = req.action.amount;
    const { evmCall, gasLimit, payForRelay } = this.transferDefaults(
      req,
      req.action.call,
    );

    return this.dispatchBridgeOp(
      req,
      evmCall,
      gasLimit,
      () =>
        this.solanaEngine.bridgeWrapped({
          to,
          mint: mintAddress,
          amount,
          payForRelay,
          call: evmCall,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        }),
      (buffer) =>
        this.solanaEngine.bridgeWrappedTokenWithBufferedCall({
          bufferAddress: buffer,
          to,
          mint: mintAddress,
          amount,
          payForRelay,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        }),
    );
  }

  /**
   * Extract common defaults shared by all transfer initiation helpers:
   * the optional EVM destination call, gas limit, and relay-payment flag.
   */
  private transferDefaults(
    req: BridgeRequest,
    call?: DestinationCall,
  ): {
    evmCall: EvmCall | undefined;
    gasLimit: bigint;
    payForRelay: boolean;
  } {
    return {
      evmCall: this.extractOptionalEvmCall(call),
      gasLimit: req.relay?.gasLimit ?? DEFAULT_EVM_GAS_LIMIT,
      payForRelay: (req.relay?.mode ?? "auto") === "auto",
    };
  }

  /**
   * Derive the destination outer hash and build the common BridgeOperation
   * returned by all initiation helpers.
   */
  private async buildOperation(args: {
    req: BridgeRequest;
    outgoingPda: SolAddress;
    signature: string;
    gasLimit: bigint;
    auxiliaryTxs?: string[];
  }): Promise<BridgeOperation> {
    const destinationHash = await this.deriveOuterHash(
      args.outgoingPda,
      args.gasLimit,
    );
    const messageRef = this.buildMessageRef({
      route: args.req.route,
      outgoingPda: args.outgoingPda,
      destinationHash,
      gasLimit: args.gasLimit,
    });
    return {
      request: args.req,
      messageRef,
      initiationTx: args.signature,
      ...(args.auxiliaryTxs && { auxiliaryTxs: args.auxiliaryTxs }),
    };
  }

  /**
   * Build the MessageRef common to all SVM -> Base initiation paths.
   */
  private buildMessageRef(args: {
    route: BridgeRoute;
    outgoingPda: string;
    destinationHash: string;
    gasLimit: bigint;
  }): MessageRef {
    return {
      route: args.route,
      source: {
        chain: args.route.sourceChain,
        id: { scheme: SOURCE_ID_SCHEME, value: args.outgoingPda },
      },
      destination: {
        chain: args.route.destinationChain,
        id: { scheme: DESTINATION_ID_SCHEME, value: args.destinationHash },
      },
      derived: { gasLimit: args.gasLimit.toString() },
    };
  }

  /**
   * Extract the destination outer hash from a MessageRef, if present.
   */
  private getDestinationOuterHash(ref: MessageRef): Hex | undefined {
    if (ref.destination?.id.scheme === DESTINATION_ID_SCHEME) {
      return ref.destination.id.value as Hex;
    }
    return undefined;
  }

  /**
   * Extract EvmCall from a DestinationCall, validating it's the correct type.
   */
  private extractEvmCall(destCall: DestinationCall): EvmCall {
    if (!isEvmDestinationCall(destCall)) {
      throw new BridgeUnsupportedActionError({
        route: this.route,
        actionKind:
          "svm->base: call requires EvmCall. Use { kind: 'evm', call: EvmCall }.",
      });
    }
    return destCall.call;
  }

  /**
   * Extract optional EvmCall from an optional DestinationCall.
   */
  private extractOptionalEvmCall(
    destCall?: DestinationCall,
  ): EvmCall | undefined {
    if (!destCall) return undefined;
    return this.extractEvmCall(destCall);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Call data buffering helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Dispatches a bridge operation through either the inline or buffered path
   * depending on call data size. Automatically uses the buffered path when
   * call data exceeds the inline threshold (~900 bytes).
   */
  private async dispatchBridgeOp(
    req: BridgeRequest,
    evmCall: EvmCall | undefined,
    gasLimit: bigint,
    inlineFn: () => Promise<{ outgoingPda: SolAddress; signature: Signature }>,
    bufferedFn: (
      bufferAddress: SolAddress,
    ) => Promise<{ outgoingPda: SolAddress; signature: Signature }>,
  ): Promise<BridgeOperation> {
    const initCtx = {
      route: req.route,
      chain: req.route.sourceChain,
      stage: "initiate" as const,
    };

    const bufferableData = this.getBufferableCallData(evmCall);
    if (bufferableData) {
      // evmCall is guaranteed non-null when bufferableData is non-null
      return this.initiateWithBuffer(
        req,
        evmCall!,
        bufferableData,
        gasLimit,
        initCtx,
        bufferedFn,
      );
    }
    const { outgoingPda, signature } = await wrapEngineError(inlineFn, initCtx);
    return this.buildOperation({ req, outgoingPda, signature, gasLimit });
  }

  /**
   * Returns the decoded call data bytes when the payload is too large for a
   * single Solana transaction, or `null` when it fits inline.
   */
  private getBufferableCallData(call?: EvmCall): Uint8Array | null {
    if (!call) return null;
    // Quick string-length check avoids a full hexToBytes allocation for small payloads.
    // Each byte is 2 hex chars; subtract 2 for the "0x" prefix.
    const byteLen = (call.data.length - 2) / 2;
    if (byteLen <= CALL_DATA_BUFFER_THRESHOLD) return null;
    return hexToBytes(call.data);
  }

  /**
   * Orchestrates the full call-buffer lifecycle for large call payloads:
   *   1. Initialize a call buffer with the first chunk of data
   *   2. Append remaining chunks in separate transactions
   *   3. Execute the bridge operation using the buffer
   *
   * On bridge failure, the buffer is closed to recover rent.
   *
   * @param bridgeFn - Receives the buffer address and performs the final
   *   bridge_*_buffered instruction.
   */
  private async initiateWithBuffer(
    req: BridgeRequest,
    call: EvmCall,
    callData: Uint8Array,
    gasLimit: bigint,
    initCtx: BridgeContext & { stage: RouteStep },
    bridgeFn: (
      bufferAddress: SolAddress,
    ) => Promise<{ outgoingPda: SolAddress; signature: Signature }>,
  ): Promise<BridgeOperation> {
    const firstChunk = callData.subarray(0, INIT_CHUNK_SIZE);
    const remainingData = callData.subarray(INIT_CHUNK_SIZE);
    const auxiliarySignatures: string[] = [];

    // 1. Initialize the call buffer
    const { bufferAddress, signature: initSig } = await wrapEngineError(
      () =>
        this.solanaEngine.initializeCallBuffer({
          callType: (call.ty as CallType | undefined) ?? CallType.Call,
          to: toBytes(call.to),
          value: call.value,
          initialData: firstChunk,
          maxDataLen: BigInt(callData.length),
        }),
      initCtx,
    );
    auxiliarySignatures.push(initSig);

    // Once the buffer is initialized, any failure in appends or the bridge
    // call should trigger cleanup to recover rent from the buffer account.
    try {
      // 2. Append remaining chunks
      for (
        let offset = 0;
        offset < remainingData.length;
        offset += APPEND_CHUNK_SIZE
      ) {
        const chunk = remainingData.subarray(
          offset,
          offset + APPEND_CHUNK_SIZE,
        );
        const { signature: appendSig } = await wrapEngineError(
          () =>
            this.solanaEngine.appendToCallBuffer({
              bufferAddress,
              data: chunk,
            }),
          initCtx,
        );
        auxiliarySignatures.push(appendSig);
      }

      // 3. Execute the buffered bridge instruction (which also closes the buffer)
      const result = await wrapEngineError(
        () => bridgeFn(bufferAddress),
        initCtx,
      );
      return this.buildOperation({
        req,
        outgoingPda: result.outgoingPda,
        signature: result.signature,
        gasLimit,
        auxiliaryTxs: auxiliarySignatures,
      });
    } catch (e) {
      // Attempt to close the buffer to recover rent
      try {
        await this.solanaEngine.closeCallBuffer({ bufferAddress });
      } catch {
        // Ignore cleanup failure — the original error is more important
      }
      throw e;
    }
  }

  async prove(_ref: MessageRef, _opts?: ProveOptions): Promise<ProveResult> {
    throw new BridgeUnsupportedStepError({ route: this.route, step: "prove" });
  }

  async execute(
    ref: MessageRef,
    opts?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    if (!this.getDestinationOuterHash(ref)) {
      throw new BridgeUnsupportedActionError({
        route: this.route,
        actionKind: "execute: missing destination outerHash",
      });
    }

    const outgoing = await wrapEngineError(
      () =>
        this.solanaEngine.getOutgoingMessage(solAddress(ref.source.id.value)),
      { route: ref.route, chain: ref.route.sourceChain, stage: "execute" },
    );

    const tx = await wrapEngineError(
      () =>
        this.baseEngine.executeMessage(
          outgoing,
          { route: ref.route, chain: ref.route.destinationChain },
          { gasLimit: opts?.relay?.gasLimit },
        ),
      {
        route: ref.route,
        chain: ref.route.destinationChain,
        stage: "execute",
      },
    );
    return { messageRef: ref, executionTx: tx };
  }

  async status(
    ref: MessageRef,
    _opts?: StatusOptions,
  ): Promise<ExecutionStatus> {
    const at = Date.now();

    const outerHash = this.getDestinationOuterHash(ref);

    if (!outerHash) return { type: "Unknown", at };

    const [success, failure] = await wrapEngineError(
      () =>
        this.evm.publicClient.multicall({
          contracts: [
            {
              address: this.evmDeployment.bridgeContract,
              abi: BRIDGE_ABI,
              functionName: "successes",
              args: [outerHash],
            },
            {
              address: this.evmDeployment.bridgeContract,
              abi: BRIDGE_ABI,
              functionName: "failures",
              args: [outerHash],
            },
          ],
          allowFailure: false,
        }),
      {
        route: ref.route,
        chain: ref.route.destinationChain,
        stage: "monitor",
      },
    );

    if (failure) {
      return {
        type: "Failed",
        at,
        reason: "destination marked failure",
        executionTx: outerHash,
      };
    }

    if (success) {
      return { type: "Executed", at, executionTx: outerHash };
    }

    return { type: "Executable", at };
  }

  monitor(
    ref: MessageRef,
    opts?: MonitorOptions,
  ): AsyncIterable<ExecutionStatus> {
    return pollingMonitor((signal) => this.status(ref, { signal }), opts);
  }

  private async deriveOuterHash(
    outgoingPda: SolAddress,
    gasLimit: bigint,
  ): Promise<Hash> {
    const outgoing = await wrapEngineError(
      () => this.solanaEngine.getOutgoingMessage(solAddress(outgoingPda)),
      {
        route: this.route,
        chain: this.route.sourceChain,
        stage: "initiate",
      },
    );
    const { outerHash } = buildEvmIncomingMessage(outgoing, { gasLimit });
    return outerHash as Hash;
  }
}
