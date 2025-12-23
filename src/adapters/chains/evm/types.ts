import type { ChainAdapter, ChainRef } from "../../../core/types";
import type { Chain, Hash, Hex, PublicClient, WalletClient } from "viem";

export type EvmWalletConfig =
  | { type: "privateKey"; key: Hex }
  | { type: "none" };

export interface EvmAdapterConfig {
  chainId: number;
  rpcUrl: string;
  wallet?: EvmWalletConfig;
}

export interface EvmChainAdapter extends ChainAdapter {
  readonly chain: ChainRef;
  readonly kind: "evm";
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly viemChain: Chain;
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly hasSigner: boolean;
  /** Present only when wallet.type === "privateKey". */
  readonly privateKey?: Hex;

  /** Convenience reads */
  getTransactionReceipt(
    hash: Hash
  ): Promise<Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>>;
}
