import type { Address as SolAddress } from "@solana/kit";
import { address as solAddress } from "@solana/kit";
import type { Hash, Hex } from "viem";
import { decodeEventLog } from "viem";
import {
  BridgeAlreadyExecutedError,
  BridgeNotProvenError,
  BridgeProofNotAvailableError,
  BridgeUnsupportedActionError,
} from "../../../../core/errors";
import { pollingMonitor } from "../../../../core/monitor/polling";
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
} from "../../../../core/types";
import type { EvmChainAdapter } from "../../../chains/evm/types";
import type { SolanaChainAdapter } from "../../../chains/solana/types";
import type { BridgeConfig } from "../legacy/types";
import { SolanaEngine } from "../legacy/solana-engine";
import { BaseEngine } from "../legacy/base-engine";
import { BRIDGE_ABI } from "../../../../interfaces/abis/bridge.abi";

/**
 * Base -> SVM route adapter (Base is always the EVM side).
 */
export class BaseMarketsBaseToSvmRouteAdapter implements RouteAdapter {
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

    const legacyConfig: BridgeConfig = {
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

    this.solanaEngine = new SolanaEngine({ config: legacyConfig });
    this.baseEngine = new BaseEngine({ config: legacyConfig });
  }

  async capabilities(): Promise<RouteCapabilities> {
    return {
      steps: ["initiate", "prove", "execute", "monitor"],
      autoRelay: false,
      manualExecute: true,
      prove: true,
    };
  }

  async initiate(req: BridgeRequest): Promise<BridgeOperation> {
    if (req.action.kind !== "transfer") {
      throw new BridgeUnsupportedActionError({
        route: req.route,
        actionKind: "base->svm: only transfer supported in v1",
      });
    }

    if (req.action.asset.kind !== "token") {
      throw new BridgeUnsupportedActionError({
        route: req.route,
        actionKind: "base->svm: only token transfers supported in v1",
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

    const txHash = await this.baseEngine.bridgeToken({
      transfer: {
        localToken,
        remoteToken: solAddress(mint),
        to: solAddress(req.action.recipient),
        amount: req.action.amount,
      },
      ixs: [],
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
      "../../../../clients/ts/src/bridge"
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
      "../../../../utils/bridge-idl.constants"
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
