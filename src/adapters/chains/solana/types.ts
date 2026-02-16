import type {
  Account,
  KeyPairSigner,
  Address as SolAddress,
} from "@solana/kit";
import type { OutgoingMessage } from "../../../clients/ts/src/bridge";
import type { ChainAdapter, ChainRef } from "../../../core/types";

export type SolanaPayerConfig = { type: "signer"; signer: KeyPairSigner };

export interface SolanaAdapterConfig {
  rpcUrl: string;
  payer: SolanaPayerConfig;
  /** Optional label for chain ref. */
  chain?: ChainRef;
}

export interface SolanaChainAdapter extends ChainAdapter {
  readonly chain: ChainRef;
  readonly kind: "solana";
  readonly rpcUrl: string;
  readonly payer: KeyPairSigner;

  fetchOutgoingMessage(
    address: SolAddress,
  ): Promise<Account<OutgoingMessage, string>>;
}
