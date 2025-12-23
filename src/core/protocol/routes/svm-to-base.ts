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
  ExecuteOptions,
  ExecuteResult,
  ExecutionStatus,
  MessageRef,
  MonitorOptions,
  ProveOptions,
  ProveResult,
  RouteAdapter,
  RouteCapabilities,
  StatusOptions,
} from "../../types";
import type { EvmChainAdapter } from "../../../adapters/chains/evm/types";
import type { SolanaChainAdapter } from "../../../adapters/chains/solana/types";
import { SolanaEngine } from "../engines/solana-engine";
import { BaseEngine } from "../engines/base-engine";
import type { EngineConfig } from "../engines/types";
import { BRIDGE_ABI } from "../../../interfaces/abis/bridge.abi";
import { buildEvmIncomingMessage } from "../identity";

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
      steps: ["initiate", "execute", "monitor"],
      autoRelay: true,
      manualExecute: this.evm.hasSigner,
      prove: false,
    };
  }

  async initiate(req: BridgeRequest): Promise<BridgeOperation> {
    const relayMode = req.relay?.mode ?? "auto";
    const payForRelay = relayMode === "auto";
    const gasLimit = req.relay?.gasLimit ?? 100_000n;

    if (req.action.kind === "call") {
      const outgoingPda = await this.solanaEngine.bridgeCall({
        to: req.action.call.to,
        value: req.action.call.value,
        data: req.action.call.data,
        ty: req.action.call.ty,
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
      if (req.action.asset.kind === "native") {
        const outgoingPda = await this.solanaEngine.bridgeSol({
          to: req.action.recipient as `0x${string}`,
          amount: req.action.amount,
          payForRelay,
          call: req.action.call
            ? {
                to: req.action.call.to,
                value: req.action.call.value,
                data: req.action.call.data,
                ty: req.action.call.ty,
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
          call: req.action.call
            ? {
                to: req.action.call.to,
                value: req.action.call.value,
                data: req.action.call.data,
                ty: req.action.call.ty,
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
          call: req.action.call
            ? {
                to: req.action.call.to,
                value: req.action.call.value,
                data: req.action.call.data,
                ty: req.action.call.ty,
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
