import type {
  BridgeConfig,
  QuoteRequest,
  RouteLeg,
  RouteQuote,
  TokenMetadata,
} from "@/types";
import { DEFAULT_ROUTE_TIMEOUT_MS } from "@/constants";
import { RpcProvider } from "@/services/rpc-provider";
import { createLogger, type Logger } from "@/utils/logger";

const generateId = () => crypto.randomUUID();

export interface RoutingEngineOptions {
  config: BridgeConfig;
  provider: RpcProvider;
  logger?: Logger;
}

export class RoutingEngine {
  private readonly config: BridgeConfig;
  private readonly provider: RpcProvider;
  private readonly logger: Logger;

  constructor({ config, provider, logger }: RoutingEngineOptions) {
    this.config = config;
    this.provider = provider;
    this.logger = logger ?? createLogger({ namespace: "routing" });
  }

  async quote(request: QuoteRequest): Promise<RouteQuote> {
    const fromToken = this.getToken(
      request.fromTokenAddress,
      request.fromChainId
    );
    const toToken = this.getToken(request.toTokenAddress, request.toChainId);

    if (!fromToken || !toToken) {
      throw new Error("Unsupported token requested");
    }

    const legs: RouteLeg[] = [
      {
        fromChainId: request.fromChainId,
        toChainId: request.toChainId,
        protocol: "superbridge",
        estimatedTimeSeconds: 90,
        gasEstimateUSD: 2.5,
        bridgeAddress: "0x0000000000000000000000000000000000000000",
      },
    ];

    const quote: RouteQuote = {
      id: generateId(),
      fromToken,
      toToken,
      inputAmount: request.amount,
      outputAmount: request.amount,
      estimatedSlippageBps:
        request.slippageBps ?? this.config.routing.maxSlippageBps,
      confidence: 0.92,
      legs,
      expiresAt: Date.now() + DEFAULT_ROUTE_TIMEOUT_MS,
      metadata: {
        simulated: true,
      },
    };

    this.logger.debug("Generated routing quote", {
      quoteId: quote.id,
      fromChain: request.fromChainId,
      toChain: request.toChainId,
    });

    return quote;
  }

  private getToken(
    address: string,
    chainId: number
  ): TokenMetadata | undefined {
    return this.config.supportedTokens.find(
      (token) =>
        token.chainId === chainId &&
        token.address.toLowerCase() === address.toLowerCase()
    );
  }
}
