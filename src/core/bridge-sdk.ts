import {
  type BridgeConfig,
  type BridgeExecutionParams,
  type BridgeExecutionResult,
} from "@/types";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { createLogger, type Logger } from "@/utils/logger";

export interface BridgeSDKOptions {
  config?: Partial<BridgeConfig>;
  logger?: Logger;
  solRpcUrl?: string;
}

const mergeConfig = (overrides?: Partial<BridgeConfig>): BridgeConfig => {
  if (!overrides) {
    return DEFAULT_CONFIG;
  }

  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  };
};

export class BridgeSDK {
  readonly config: BridgeConfig;
  private readonly logger: Logger;

  constructor(options: BridgeSDKOptions = {}) {
    this.config = mergeConfig(options.config);
    this.logger = options.logger ?? createLogger({ namespace: "sdk" });
  }

  async execute(params: BridgeExecutionParams): Promise<BridgeExecutionResult> {
    this.logger.info("Execute called - placeholder implementation", {
      quoteId: params.quoteId,
      userAddress: params.userAddress,
      dryRun: params.dryRun ?? false,
    });

    return {
      requestId: crypto.randomUUID(),
      status: params.dryRun ? "submitted" : "confirmed",
      txHash: params.dryRun
        ? undefined
        : `0x${crypto.randomUUID().replace(/-/g, "")}`,
    };
  }
}

export const createBridgeSDK = (options?: BridgeSDKOptions) =>
  new BridgeSDK(options);
