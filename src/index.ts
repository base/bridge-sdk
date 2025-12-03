export { BridgeSDK, createBridgeSDK } from "@/core/bridge-sdk";
export { SolanaEngine } from "@/core/solana-engine";
export { BaseEngine } from "@/core/base-engine";

export { DEFAULT_CONFIG } from "@/config/defaults";

export {
  SOLANA_MAINNET_RPC,
  SOLANA_BRIDGE_PROGRAM_ID,
  SOLANA_RELAYER_PROGRAM_ID,
  BASE_MAINNET_RPC,
} from "@/constants";

export type { BridgeConfig, BridgeConfigOverrides } from "@/types";
