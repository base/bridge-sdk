export type { BridgeClient, BridgeClientConfig } from "./core/client";
export { createBridgeClient } from "./core/client";
export type * from "./core/types";

// Re-export KeyPairSigner for consumers using loadSolanaKeypair
export type { KeyPairSigner } from "@solana/kit";
