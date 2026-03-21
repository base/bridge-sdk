import type { Address as SolAddress } from "@solana/kit";
import { address as solAddress } from "@solana/kit";
import type { Hash, Hex } from "viem";
import type { EvmChainAdapter } from "../../../adapters/chains/evm/types";
import type { SolanaChainAdapter } from "../../../adapters/chains/solana/types";
import { BRIDGE_ABI } from "../../../interfaces/abis/bridge.abi";
import {
  BridgeUnsupportedActionError,
  BridgeUnsupportedStepError,
} from "../../errors";
import { pollingMonitor } from "../../monitor/polling";
import type {
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
  StatusOptions,
} from "../../types";
import { isEvmDestinationCall } from "../../utils";
import { BaseEngine } from "../engines/base-engine";
import {
  DEFAULT_EVM_GAS_LIMIT,
  SOLANA_BASE_TX_FEE,
} from "../engines/constants";
import { SolanaEngine } from "../engines/solana-engine";
import type { EngineConfig } from "../engines/types";
import { buildEvmIncomingMessage } from "../identity";

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
        payer: this.solana.payer,
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
      steps: ["initiate", "execute", "monitor"],
      autoRelay: true,
      manualExecute: this.evm.hasSigner,
      prove: false,
      supportsQuote: true,
    };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const gasLimit = req.relay?.gasLimit ?? DEFAULT_EVM_GAS_LIMIT;
    const relayMode = req.relay?.mode ?? "auto";
    const warnings: string[] = [];

    // Fetch on-chain config for fee estimation
    const { relayerGasConfig } = await this.solanaEngine.getGasConfigs();

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

  /**
   * Initiate a pure call action (EVM call only, no transfer).
   */
  private async initiateCall(req: BridgeRequest): Promise<BridgeOperation> {
    if (req.action.kind !== "call") {
      throw new Error("Expected call action");
    }

    const evmCall = this.extractEvmCall(req.action.call);
    const gasLimit = req.relay?.gasLimit ?? DEFAULT_EVM_GAS_LIMIT;
    const payForRelay = (req.relay?.mode ?? "auto") === "auto";

    const { outgoingPda, signature } = await this.solanaEngine.bridgeCall({
      to: evmCall.to,
      value: evmCall.value,
      data: evmCall.data,
      ty: evmCall.ty,
      payForRelay,
      gasLimit,
      idempotencyKey: req.idempotencyKey,
    });

    return this.buildOperation({ req, outgoingPda, signature, gasLimit });
  }

  /**
   * Initiate a native SOL transfer, optionally with an EVM call.
   */
  private async initiateNativeTransfer(
    req: BridgeRequest,
  ): Promise<BridgeOperation> {
    if (req.action.kind !== "transfer") {
      throw new Error("Expected transfer action");
    }

    const { evmCall, gasLimit, payForRelay } = this.transferDefaults(
      req,
      req.action.call,
    );

    const { outgoingPda, signature } = await this.solanaEngine.bridgeSol({
      to: req.action.recipient as `0x${string}`,
      amount: req.action.amount,
      payForRelay,
      call: evmCall,
      gasLimit,
      idempotencyKey: req.idempotencyKey,
    });

    return this.buildOperation({ req, outgoingPda, signature, gasLimit });
  }

  /**
   * Initiate an SPL token transfer, optionally with an EVM call.
   */
  private async initiateTokenTransfer(
    req: BridgeRequest,
  ): Promise<BridgeOperation> {
    if (req.action.kind !== "transfer") {
      throw new Error("Expected transfer action");
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

    const { evmCall, gasLimit, payForRelay } = this.transferDefaults(
      req,
      req.action.call,
    );

    const { outgoingPda, signature } = await this.solanaEngine.bridgeSpl({
      to: req.action.recipient as `0x${string}`,
      mint,
      remoteToken,
      amount: req.action.amount,
      payForRelay,
      call: evmCall,
      gasLimit,
      idempotencyKey: req.idempotencyKey,
    });

    return this.buildOperation({ req, outgoingPda, signature, gasLimit });
  }

  /**
   * Initiate a wrapped token transfer, optionally with an EVM call.
   */
  private async initiateWrappedTransfer(
    req: BridgeRequest,
  ): Promise<BridgeOperation> {
    if (req.action.kind !== "transfer" || req.action.asset.kind !== "wrapped") {
      throw new Error("Expected wrapped transfer action");
    }

    const { evmCall, gasLimit, payForRelay } = this.transferDefaults(
      req,
      req.action.call,
    );

    const { outgoingPda, signature } = await this.solanaEngine.bridgeWrapped({
      to: req.action.recipient as `0x${string}`,
      mint: req.action.asset.address,
      amount: req.action.amount,
      payForRelay,
      call: evmCall,
      gasLimit,
      idempotencyKey: req.idempotencyKey,
    });

    return this.buildOperation({ req, outgoingPda, signature, gasLimit });
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
        id: { scheme: "solana:outgoingMessagePda", value: args.outgoingPda },
      },
      destination: {
        chain: args.route.destinationChain,
        id: { scheme: "evm:bridgeOuterHash", value: args.destinationHash },
      },
      derived: { gasLimit: args.gasLimit.toString() },
    };
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

  async prove(_ref: MessageRef, _opts?: ProveOptions): Promise<ProveResult> {
    throw new BridgeUnsupportedStepError({ route: this.route, step: "prove" });
  }

  async execute(
    ref: MessageRef,
    _opts?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    if (
      !ref.destination ||
      ref.destination.id.scheme !== "evm:bridgeOuterHash"
    ) {
      throw new BridgeUnsupportedActionError({
        route: this.route,
        actionKind: "execute: missing destination outerHash",
      });
    }

    const outgoing = await this.solanaEngine.getOutgoingMessage(
      solAddress(ref.source.id.value),
    );

    const tx = await this.baseEngine.executeMessage(outgoing);
    return { messageRef: ref, executionTx: tx };
  }

  async status(
    ref: MessageRef,
    _opts?: StatusOptions,
  ): Promise<ExecutionStatus> {
    const at = Date.now();

    const outerHash =
      ref.destination?.id.scheme === "evm:bridgeOuterHash"
        ? (ref.destination.id.value as Hex)
        : undefined;

    if (!outerHash) return { type: "Unknown", at };

    const [success, failure] = await this.evm.publicClient.multicall({
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
    });

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
    const outgoing = await this.solanaEngine.getOutgoingMessage(
      solAddress(outgoingPda),
    );
    const { outerHash } = buildEvmIncomingMessage(outgoing, { gasLimit });
    return outerHash as Hash;
  }
}
