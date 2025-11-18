import {
  type BridgeConfig,
  type BridgeExecutionParams,
  type BridgeExecutionResult,
  type QuoteRequest,
  type RouteQuote,
} from "@/types";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { RpcProvider } from "@/services/rpc-provider";
import { RoutingEngine } from "@/core/routing-engine";
import { createLogger, type Logger } from "@/utils/logger";

export interface BridgeSDKOptions {
  config?: Partial<BridgeConfig>;
  logger?: Logger;
  rpcProvider?: RpcProvider;
}

const mergeConfig = (overrides?: Partial<BridgeConfig>): BridgeConfig => {
  if (!overrides) {
    return DEFAULT_CONFIG;
  }

  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    routing: {
      ...DEFAULT_CONFIG.routing,
      ...overrides.routing,
    },
    supportedChains:
      overrides.supportedChains ?? DEFAULT_CONFIG.supportedChains,
    supportedTokens:
      overrides.supportedTokens ?? DEFAULT_CONFIG.supportedTokens,
  };
};

export class BridgeSDK {
  readonly config: BridgeConfig;
  private readonly logger: Logger;
  private readonly routingEngine: RoutingEngine;

  constructor(options: BridgeSDKOptions = {}) {
    this.config = mergeConfig(options.config);
    this.logger = options.logger ?? createLogger({ namespace: "sdk" });

    const provider =
      options.rpcProvider ??
      new RpcProvider({
        chains: this.config.supportedChains,
        logger: this.logger,
      });

    this.routingEngine = new RoutingEngine({
      config: this.config,
      provider,
      logger: this.logger,
    });
  }

  getSupportedChains() {
    return this.config.supportedChains;
  }

  getSupportedTokens(chainId?: number) {
    if (!chainId) {
      return this.config.supportedTokens;
    }

    return this.config.supportedTokens.filter(
      (token) => token.chainId === chainId
    );
  }

  async getQuote(request: QuoteRequest): Promise<RouteQuote> {
    return this.routingEngine.quote(request);
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
