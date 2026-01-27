import type { Address as SolAddress } from "@solana/kit";
import { address as solAddress } from "@solana/kit";
import type { Hex, Hash } from "viem";
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
import type { EvmChainAdapter } from "../../../adapters/chains/evm/types";
import type { SolanaChainAdapter } from "../../../adapters/chains/solana/types";
import { SolanaEngine } from "../engines/solana-engine";
import { BaseEngine } from "../engines/base-engine";
import type { EngineConfig } from "../engines/types";
import { BRIDGE_ABI } from "../../../interfaces/abis/bridge.abi";
import { buildEvmIncomingMessage } from "../identity";

// ─────────────────────────────────────────────────────────────────────────────
// Fee estimation constants for SVM -> Base quotes
// ─────────────────────────────────────────────────────────────────────────────

/** Solana base transaction fee in lamports */
const SOLANA_BASE_TX_FEE = 5_000n;
/** Additional compute unit buffer for bridge operations */
const SOLANA_COMPUTE_UNIT_BUFFER = 10_000n;
/** Default gas limit when not specified */
const DEFAULT_GAS_LIMIT = 100_000n;
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
 * SVM -> Base route adapter
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
    const gasLimit = req.relay?.gasLimit ?? DEFAULT_GAS_LIMIT;
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
          `Gas limit ${gasLimit} is below minimum ${relayerGasConfig.minGasLimitPerMessage}`
        );
      }
      if (gasLimit > relayerGasConfig.maxGasLimitPerMessage) {
        warnings.push(
          `Gas limit ${gasLimit} exceeds maximum ${relayerGasConfig.maxGasLimitPerMessage}`
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
          `Destination gas estimation failed: ${err instanceof Error ? err.message : String(err)}. Using provided limit.`
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
    const relayMode = req.relay?.mode ?? "auto";
    const payForRelay = relayMode === "auto";
    const gasLimit = req.relay?.gasLimit ?? 100_000n;

    if (req.action.kind === "call") {
      const evmCall = this.extractEvmCall(req.action.call);

      const outgoingPda = await this.solanaEngine.bridgeCall({
        to: evmCall.to,
        value: evmCall.value,
        data: evmCall.data,
        ty: evmCall.ty,
        payForRelay,
        gasLimit,
        idempotencyKey: req.idempotencyKey,
      });

      const destinationHash = await this.deriveOuterHash(outgoingPda, gasLimit);

      const messageRef: MessageRef = {
        route: req.route,
        source: {
          chain: req.route.sourceChain,
          id: { scheme: "solana:outgoingMessagePda", value: outgoingPda },
        },
        destination: {
          chain: req.route.destinationChain,
          id: { scheme: "evm:bridgeOuterHash", value: destinationHash },
        },
        derived: { gasLimit: gasLimit.toString() },
      };

      return { route: req.route, request: req, messageRef };
    }

    if (req.action.kind === "transfer") {
      // Extract optional EVM call for transfer+call
      const evmCall = this.extractOptionalEvmCall(req.action.call);

      if (req.action.asset.kind === "native") {
        const outgoingPda = await this.solanaEngine.bridgeSol({
          to: req.action.recipient as `0x${string}`,
          amount: req.action.amount,
          payForRelay,
          call: evmCall
            ? {
                to: evmCall.to,
                value: evmCall.value,
                data: evmCall.data,
                ty: evmCall.ty,
              }
            : undefined,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        });

        const destinationHash = await this.deriveOuterHash(
          outgoingPda,
          gasLimit
        );

        const messageRef: MessageRef = {
          route: req.route,
          source: {
            chain: req.route.sourceChain,
            id: { scheme: "solana:outgoingMessagePda", value: outgoingPda },
          },
          destination: {
            chain: req.route.destinationChain,
            id: { scheme: "evm:bridgeOuterHash", value: destinationHash },
          },
          derived: { gasLimit: gasLimit.toString() },
        };

        return { route: req.route, request: req, messageRef };
      }

      if (req.action.asset.kind === "token") {
        const mint = req.action.asset.address;
        const remoteToken = this.tokenMapping?.[mint];
        if (!remoteToken) {
          throw new BridgeUnsupportedActionError({
            route: req.route,
            actionKind: "transfer(token): missing tokenMappings for mint",
          });
        }

        const outgoingPda = await this.solanaEngine.bridgeSpl({
          to: req.action.recipient as `0x${string}`,
          mint,
          remoteToken,
          amount: req.action.amount,
          payForRelay,
          call: evmCall
            ? {
                to: evmCall.to,
                value: evmCall.value,
                data: evmCall.data,
                ty: evmCall.ty,
              }
            : undefined,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        });

        const destinationHash = await this.deriveOuterHash(
          outgoingPda,
          gasLimit
        );

        const messageRef: MessageRef = {
          route: req.route,
          source: {
            chain: req.route.sourceChain,
            id: { scheme: "solana:outgoingMessagePda", value: outgoingPda },
          },
          destination: {
            chain: req.route.destinationChain,
            id: { scheme: "evm:bridgeOuterHash", value: destinationHash },
          },
          derived: { gasLimit: gasLimit.toString() },
        };

        return { route: req.route, request: req, messageRef };
      }

      if (req.action.asset.kind === "wrapped") {
        const outgoingPda = await this.solanaEngine.bridgeWrapped({
          to: req.action.recipient as `0x${string}`,
          mint: req.action.asset.address,
          amount: req.action.amount,
          payForRelay,
          call: evmCall
            ? {
                to: evmCall.to,
                value: evmCall.value,
                data: evmCall.data,
                ty: evmCall.ty,
              }
            : undefined,
          gasLimit,
          idempotencyKey: req.idempotencyKey,
        });

        const destinationHash = await this.deriveOuterHash(
          outgoingPda,
          gasLimit
        );

        const messageRef: MessageRef = {
          route: req.route,
          source: {
            chain: req.route.sourceChain,
            id: { scheme: "solana:outgoingMessagePda", value: outgoingPda },
          },
          destination: {
            chain: req.route.destinationChain,
            id: { scheme: "evm:bridgeOuterHash", value: destinationHash },
          },
          derived: { gasLimit: gasLimit.toString() },
        };

        return { route: req.route, request: req, messageRef };
      }
    }

    throw new BridgeUnsupportedActionError({
      route: req.route,
      actionKind: req.action.kind,
    });
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
    destCall?: DestinationCall
  ): EvmCall | undefined {
    if (!destCall) return undefined;
    return this.extractEvmCall(destCall);
  }

  async prove(_ref: MessageRef, _opts?: ProveOptions): Promise<ProveResult> {
    throw new BridgeUnsupportedStepError({ route: this.route, step: "prove" });
  }

  async execute(
    ref: MessageRef,
    _opts?: ExecuteOptions
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
      solAddress(ref.source.id.value)
    );

    const tx = await this.baseEngine.executeMessage(outgoing);
    return { messageRef: ref, executionTx: tx };
  }

  async status(
    ref: MessageRef,
    _opts?: StatusOptions
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
    opts?: MonitorOptions
  ): AsyncIterable<ExecutionStatus> {
    return pollingMonitor(() => this.status(ref), opts);
  }

  private async deriveOuterHash(
    outgoingPda: SolAddress,
    gasLimit: bigint
  ): Promise<Hash> {
    const outgoing = await this.solanaEngine.getOutgoingMessage(
      solAddress(outgoingPda)
    );
    const { outerHash } = buildEvmIncomingMessage(outgoing, { gasLimit });
    return outerHash as Hash;
  }
}
