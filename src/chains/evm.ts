import type { Chain } from "viem";
import { base as viemBase, baseSepolia as viemBaseSepolia } from "viem/chains";

export type BridgeEvmChain = {
  /** Canonical chain id used by this SDK (CAIP-2 style). */
  id: `eip155:${number}`;
  /** Numeric EVM chain id (e.g. 8453). */
  chainId: number;
  /** viem Chain object for clients/wallets. */
  viem: Chain;
  /** Human name. */
  name: string;
  /** Whether this is a testnet. */
  testnet?: boolean;
};

function bridgeEvmChain(viem: Chain): BridgeEvmChain {
  return {
    id: `eip155:${viem.id}` as const,
    chainId: viem.id,
    viem,
    name: viem.name,
    testnet: viem.testnet,
  };
}

/** Base mainnet (chainId 8453). */
export const base = bridgeEvmChain(viemBase);

/** Base Sepolia (chainId 84532). */
export const baseSepolia = bridgeEvmChain(viemBaseSepolia);
