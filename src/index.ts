export { BridgeSDK, createBridgeSDK } from "@/core/bridge-sdk";
export { RoutingEngine } from "@/core/routing-engine";

export {
  DEFAULT_CONFIG,
  DEFAULT_CHAINS,
  BASE_MAINNET,
  ETHEREUM_MAINNET,
} from "@/config/defaults";

export {
  SDK_VERSION,
  DEFAULT_ROUTE_TIMEOUT_MS,
  DEFAULT_SLIPPAGE_BPS,
} from "@/constants";

export type {
  BridgeConfig,
  BridgeExecutionParams,
  BridgeExecutionResult,
  ChainId,
  ChainMetadata,
  QuoteRequest,
  RouteLeg,
  RouteQuote,
  RoutingPreferences,
  TokenMetadata,
} from "@/types";
