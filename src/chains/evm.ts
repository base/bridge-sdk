import type { Chain } from "viem";
import { base as viemBase, baseSepolia as viemBaseSepolia } from "viem/chains";
import type { BridgeEvmChainRef } from "../adapters/chains/evm/types";

type BridgeEvmChain = BridgeEvmChainRef & {
  /** Human name (required for EVM chains). */
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
