import type { ChainRef } from "../core/types";

export type BridgeSolanaChain = ChainRef & {
  /** Canonical cluster identifier. */
  cluster: "mainnet" | "devnet";
};

export const solanaMainnet: BridgeSolanaChain = {
  id: "solana:mainnet",
  cluster: "mainnet",
};

export const solanaDevnet: BridgeSolanaChain = {
  id: "solana:devnet",
  cluster: "devnet",
};

/** Default Solana chain export (mainnet). */
export const solana = solanaMainnet;
