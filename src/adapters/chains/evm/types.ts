import type { ChainAdapter, ChainRef } from "../../../core/types";
import type { Chain, Hash, Hex, PublicClient, WalletClient } from "viem";

export type EvmWalletConfig =
  | { type: "privateKey"; key: Hex }
  | { type: "none" };

export type BridgeEvmChainRef = {
  id: `eip155:${number}`;
  chainId: number;
  viem: Chain;
};

export type EvmAdapterConfig =
  | {
      /** EVM chain id (e.g. 8453). */
      chainId: number;
      chain?: undefined;
      rpcUrl: string;
      wallet?: EvmWalletConfig;
    }
  | {
      /** Bridge SDK chain object (e.g. `import { base } from "@base-markets/bridge-sdk/chains"`). */
      chain: BridgeEvmChainRef;
      chainId?: undefined;
      rpcUrl: string;
      wallet?: EvmWalletConfig;
    }
  | {
      /** viem chain object (e.g. `import { base } from "viem/chains"`). */
      chain: Chain;
      chainId?: undefined;
      rpcUrl: string;
      wallet?: EvmWalletConfig;
    };

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
