import type {
  Account,
  Address as SolAddress,
  KeyPairSigner,
} from "@solana/kit";
import type { ChainAdapter, ChainRef } from "../../../core/types";
import type { OutgoingMessage } from "../../../clients/ts/src/bridge";

export type SolanaPayerConfig = { type: "keypairPath"; path: string };

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
  /** Original payer keypair path (expanded). */
  readonly payerKeypairPath: string;
  readonly payer: KeyPairSigner;

  fetchOutgoingMessage(
    address: SolAddress
  ): Promise<Account<OutgoingMessage, string>>;
}
