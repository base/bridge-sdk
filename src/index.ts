// Re-export KeyPairSigner for consumers using loadSolanaKeypair
export type { KeyPairSigner } from "@solana/kit";
export type { BridgeClient, BridgeClientConfig } from "./core/client";
export { createBridgeClient } from "./core/client";
export type { ActionableOutcome, BridgeErrorCode } from "./core/errors";
export { BridgeError } from "./core/errors";
export {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
} from "./core/protocol/router";
export type * from "./core/types";
export { EvmCallType } from "./core/types";
