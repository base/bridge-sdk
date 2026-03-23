import type {
  Chain,
  Hash,
  Hex,
  PublicClient,
  TransactionReceipt,
  WalletClient,
} from "viem";
import type { ChainAdapter, ChainRef } from "../../../core/types";

export type EvmWalletConfig =
  | { type: "privateKey"; key: Hex }
  | { type: "none" };

export type BridgeEvmChainRef = {
  id: `eip155:${number}`;
  chainId: number;
  viem: Chain;
};

type EvmAdapterConfigBase = {
  rpcUrl: string;
  wallet?: EvmWalletConfig;
};

export type EvmAdapterConfig = EvmAdapterConfigBase &
  (
    | {
        /** EVM chain id (e.g. 8453). */
        chainId: number;
        chain?: undefined;
      }
    | {
        /** Bridge SDK chain object (e.g. `import { base } from "bridge-sdk/chains"`). */
        chain: BridgeEvmChainRef;
        chainId?: undefined;
      }
    | {
        /** viem chain object (e.g. `import { base } from "viem/chains"`). */
        chain: Chain;
        chainId?: undefined;
      }
  );

export interface EvmChainAdapter extends ChainAdapter {
  readonly chain: ChainRef;
  readonly kind: "evm";
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly viemChain: Chain;
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  /** Present only when wallet.type === "privateKey". */
  readonly privateKey?: Hex;

  /** Convenience reads */
  getTransactionReceipt(hash: Hash): Promise<TransactionReceipt>;
}
