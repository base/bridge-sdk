import {
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
} from "../core/protocol/router";
import type { ChainRef } from "../core/types";

type BridgeSolanaChain = ChainRef & {
  /** Canonical cluster identifier. */
  cluster: "mainnet" | "devnet";
};

export const solanaMainnet: BridgeSolanaChain = {
  id: SOLANA_MAINNET_CHAIN_ID,
  cluster: "mainnet",
};

export const solanaDevnet: BridgeSolanaChain = {
  id: SOLANA_DEVNET_CHAIN_ID,
  cluster: "devnet",
};
