export type ChainId = number;

export interface TokenMetadata {
  address: string;
  symbol: string;
  decimals: number;
  chainId: ChainId;
}

export interface ChainMetadata {
  id: ChainId;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrencySymbol: string;
  blockTimeSeconds: number;
  isTestnet?: boolean;
}

export interface RoutingPreferences {
  maxSlippageBps: number;
  maxHops: number;
  requireDexAggregation: boolean;
  preferredProtocols: string[];
  timeoutMs: number;
}

export interface BridgeConfig {
  appName: string;
  defaultFromChainId: ChainId;
  supportedChains: ChainMetadata[];
  supportedTokens: TokenMetadata[];
  routing: RoutingPreferences;
}

export interface RouteLeg {
  fromChainId: ChainId;
  toChainId: ChainId;
  protocol: string;
  estimatedTimeSeconds: number;
  gasEstimateUSD: number;
  bridgeAddress: string;
}

export interface RouteQuote {
  id: string;
  fromToken: TokenMetadata;
  toToken: TokenMetadata;
  inputAmount: string;
  outputAmount: string;
  estimatedSlippageBps: number;
  confidence: number;
  legs: RouteLeg[];
  expiresAt: number;
  metadata?: Record<string, unknown>;
}

export interface QuoteRequest {
  fromChainId: ChainId;
  toChainId: ChainId;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  userAddress: string;
  slippageBps?: number;
}

export interface BridgeExecutionParams {
  quoteId: string;
  userAddress: string;
  dryRun?: boolean;
}

export interface BridgeExecutionResult {
  requestId: string;
  status: "submitted" | "confirmed" | "failed";
  txHash?: string;
  error?: string;
}
