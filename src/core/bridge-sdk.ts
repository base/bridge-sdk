import { type BridgeConfig, type BridgeConfigOverrides } from "@/types";
import { DEFAULT_CONFIG } from "@/config/defaults";
import {
  SolanaEngine,
  type BridgeCallOpts,
  type BridgeSolOpts,
  type BridgeSplOpts,
  type BridgeWrappedOpts,
} from "./solana-engine";
import { BaseEngine } from "./base-engine";
import type { Address } from "@solana/kit";

export interface BridgeSDKOptions {
  config?: BridgeConfigOverrides;
  solRpcUrl?: string;
}

const mergeConfig = (overrides?: BridgeConfigOverrides): BridgeConfig => ({
  solana: {
    ...DEFAULT_CONFIG.solana,
    ...(overrides?.solana ?? {}),
  },
  base: {
    ...DEFAULT_CONFIG.base,
    ...(overrides?.base ?? {}),
  },
});

export class BridgeSDK {
  readonly config: BridgeConfig;
  private readonly solanaEngine: SolanaEngine;
  private readonly baseEngine: BaseEngine;

  constructor(options: BridgeSDKOptions = {}) {
    this.config = mergeConfig(options.config);
    this.solanaEngine = new SolanaEngine({
      config: this.config,
    });
    this.baseEngine = new BaseEngine({
      config: this.config,
    });
  }

  async bridgeSol(opts: BridgeSolOpts): Promise<Address> {
    return await this.solanaEngine.bridgeSol(opts);
  }

  async bridgeSpl(opts: BridgeSplOpts): Promise<Address> {
    return await this.solanaEngine.bridgeSpl(opts);
  }

  async bridgeWrapped(opts: BridgeWrappedOpts): Promise<Address> {
    return await this.solanaEngine.bridgeWrapped(opts);
  }

  async bridgeCall(opts: BridgeCallOpts): Promise<Address> {
    return await this.solanaEngine.bridgeCall(opts);
  }

  async waitForMessageExecution(outgoingMessagePubkey: Address) {
    await this.baseEngine.monitorMessageExecution(
      await this.solanaEngine.getOutgoingMessage(outgoingMessagePubkey)
    );
  }
}

export const createBridgeSDK = (options?: BridgeSDKOptions) =>
  new BridgeSDK(options);
