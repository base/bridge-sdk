import { type BridgeConfig, type BridgeConfigOverrides } from "@/types";
import { mergeConfig } from "@/config/defaults";
import {
  SolanaEngine,
  type BridgeCallOpts,
  type BridgeSolOpts,
  type BridgeSplOpts,
  type BridgeWrappedOpts,
  type WrapTokenOpts,
} from "./solana-engine";
import { type Logger } from "@/utils/logger";
import { BaseEngine } from "./base-engine";
import type { Address, Signature } from "@solana/kit";
import type { Hash, Hex } from "viem";
import { DEFAULT_RELAY_GAS_LIMIT } from "@/constants";

export interface BridgeSDKOptions {
  config?: BridgeConfigOverrides;
  logger?: Logger;
  solanaEngine?: SolanaEngine;
  baseEngine?: BaseEngine;
}

export class BridgeSDK {
  readonly config: BridgeConfig;
  private readonly solanaEngine: SolanaEngine;
  private readonly baseEngine: BaseEngine;

  constructor(options: BridgeSDKOptions = {}) {
    this.config = mergeConfig(options.config);
    this.solanaEngine =
      options.solanaEngine ??
      new SolanaEngine({
        config: this.config,
        logger: options.logger,
      });
    this.baseEngine =
      options.baseEngine ??
      new BaseEngine({
        config: this.config,
        logger: options.logger,
      });
  }

  async bridgeSol(opts: BridgeSolOpts): Promise<Address> {
    if (opts.gasLimit === undefined && opts.payForRelay && opts.call) {
      const estimatedGas = await this.baseEngine.estimateGasForCall(opts.call);
      opts.gasLimit = estimatedGas + DEFAULT_RELAY_GAS_LIMIT;
    }

    return await this.solanaEngine.bridgeSol(opts);
  }

  async bridgeSpl(opts: BridgeSplOpts): Promise<Address> {
    if (opts.gasLimit === undefined && opts.payForRelay && opts.call) {
      const estimatedGas = await this.baseEngine.estimateGasForCall(opts.call);
      opts.gasLimit = estimatedGas + DEFAULT_RELAY_GAS_LIMIT;
    }

    return await this.solanaEngine.bridgeSpl(opts);
  }

  async bridgeWrapped(opts: BridgeWrappedOpts): Promise<Address> {
    if (opts.gasLimit === undefined && opts.payForRelay && opts.call) {
      const estimatedGas = await this.baseEngine.estimateGasForCall(opts.call);
      opts.gasLimit = estimatedGas + DEFAULT_RELAY_GAS_LIMIT;
    }

    return await this.solanaEngine.bridgeWrapped(opts);
  }

  async bridgeCall(opts: BridgeCallOpts): Promise<Address> {
    if (opts.gasLimit === undefined && opts.payForRelay) {
      const estimatedGas = await this.baseEngine.estimateGasForCall(opts);
      opts.gasLimit = estimatedGas + DEFAULT_RELAY_GAS_LIMIT;
    }

    return await this.solanaEngine.bridgeCall(opts);
  }

  async wrapToken(opts: WrapTokenOpts): Promise<Address> {
    return await this.solanaEngine.wrapToken(opts);
  }

  async waitForMessageExecution(outgoingMessagePubkey: Address) {
    await this.baseEngine.monitorMessageExecution(
      await this.solanaEngine.getOutgoingMessage(outgoingMessagePubkey)
    );
  }

  async proveOnSolana(
    transactionHash: Hash
  ): Promise<{ signature?: Signature; messageHash: Hash }> {
    const blockNumber = await this.solanaEngine.getLatestBaseBlockNumber();
    const { event, rawProof } = await this.baseEngine.generateProof(
      transactionHash,
      blockNumber
    );
    return await this.solanaEngine.handleProveMessage(
      event,
      rawProof,
      blockNumber
    );
  }

  async executeOnSolana(msgHash: Hex): Promise<Signature> {
    return await this.solanaEngine.handleExecuteMessage(msgHash);
  }
}

export const createBridgeSDK = (options?: BridgeSDKOptions) =>
  new BridgeSDK(options);
