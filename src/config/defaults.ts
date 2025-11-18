import {
  type BridgeConfig,
  type ChainMetadata,
  type TokenMetadata,
} from "@/types";

import {
  DEFAULT_MAX_HOPS,
  DEFAULT_ROUTE_TIMEOUT_MS,
  DEFAULT_SLIPPAGE_BPS,
} from "@/constants";

export const BASE_MAINNET: ChainMetadata = {
  id: 8453,
  name: "Base",
  rpcUrl: "https://mainnet.base.org",
  explorerUrl: "https://basescan.org",
  nativeCurrencySymbol: "ETH",
  blockTimeSeconds: 2,
};

export const ETHEREUM_MAINNET: ChainMetadata = {
  id: 1,
  name: "Ethereum",
  rpcUrl: "https://rpc.ankr.com/eth",
  explorerUrl: "https://etherscan.io",
  nativeCurrencySymbol: "ETH",
  blockTimeSeconds: 12,
};

export const DEFAULT_CHAINS: ChainMetadata[] = [BASE_MAINNET, ETHEREUM_MAINNET];

export const DEFAULT_TOKENS: TokenMetadata[] = [
  {
    address: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    decimals: 18,
    chainId: BASE_MAINNET.id,
  },
  {
    address: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    decimals: 18,
    chainId: ETHEREUM_MAINNET.id,
  },
  {
    address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    symbol: "USDC",
    decimals: 6,
    chainId: BASE_MAINNET.id,
  },
  {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    decimals: 6,
    chainId: ETHEREUM_MAINNET.id,
  },
];

export const DEFAULT_CONFIG: BridgeConfig = {
  appName: "base-bridge-sdk",
  defaultFromChainId: BASE_MAINNET.id,
  supportedChains: DEFAULT_CHAINS,
  supportedTokens: DEFAULT_TOKENS,
  routing: {
    maxSlippageBps: DEFAULT_SLIPPAGE_BPS,
    maxHops: DEFAULT_MAX_HOPS,
    requireDexAggregation: true,
    preferredProtocols: ["superbridge", "layerswap", "celer"],
    timeoutMs: DEFAULT_ROUTE_TIMEOUT_MS,
  },
};
