import type {
  Account,
  KeyPairSigner,
  Address as SolAddress,
} from "@solana/kit";
import type { OutgoingMessage } from "../../../clients/ts/src/bridge";
import type { ChainAdapter, ChainRef } from "../../../core/types";

export interface SolanaAdapterConfig {
  rpcUrl: string;
  /** Optional WebSocket URL for RPC subscriptions. If not provided, derived from `rpcUrl`. */
  wssUrl?: string;
  payer: KeyPairSigner;
  /** Optional label for chain ref. */
  chain?: ChainRef;
}

export interface SolanaChainAdapter extends ChainAdapter {
  readonly chain: ChainRef;
  readonly kind: "solana";
  readonly rpcUrl: string;
  readonly wssUrl?: string;
  readonly payer: KeyPairSigner;

  fetchOutgoingMessage(
    address: SolAddress,
  ): Promise<Account<OutgoingMessage, string>>;
}
