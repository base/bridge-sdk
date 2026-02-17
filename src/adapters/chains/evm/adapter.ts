import {
  type Chain,
  createPublicClient,
  createWalletClient,
  type Hash,
  type Hex,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainRef } from "../../../core/types";
import type { EvmAdapterConfig, EvmChainAdapter } from "./types";

function makeViemChain(chainId: number): Chain {
  // Minimal viem Chain object; callers can still override behavior via RPC.
  return {
    id: chainId,
    name: `eip155:${chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [""] } },
  } as const as Chain;
}

function hasViemChain(
  config: EvmAdapterConfig,
): config is Extract<EvmAdapterConfig, { chain: unknown }> {
  return "chain" in config && config.chain != null;
}

export function makeEvmAdapter(config: EvmAdapterConfig): EvmChainAdapter {
  const chainId = hasViemChain(config)
    ? typeof (config.chain as Record<string, unknown>).chainId === "number"
      ? ((config.chain as Record<string, unknown>).chainId as number)
      : ((config.chain as Record<string, unknown>).id as number)
    : config.chainId;
  const chain: ChainRef = { id: `eip155:${chainId}` };
  const viemChain = hasViemChain(config)
    ? (((config.chain as Record<string, unknown>).viem ??
        config.chain) as Chain)
    : makeViemChain(chainId);

  const publicClient = createPublicClient({
    chain: viemChain,
    transport: http(config.rpcUrl),
  }) as PublicClient;

  let walletClient: WalletClient | undefined;
  let hasSigner = false;
  let privateKey: Hex | undefined;

  const wallet = config.wallet ?? { type: "none" as const };
  if (wallet.type === "privateKey") {
    const account = privateKeyToAccount(wallet.key as Hex);
    walletClient = createWalletClient({
      chain: viemChain,
      transport: http(config.rpcUrl),
      account,
    }) as WalletClient;
    hasSigner = true;
    privateKey = wallet.key as Hex;
  }

  return {
    kind: "evm",
    chain,
    chainId,
    rpcUrl: config.rpcUrl,
    viemChain,
    publicClient,
    walletClient,
    hasSigner,
    privateKey,
    async ping() {
      await publicClient.getBlockNumber();
    },
    async getTransactionReceipt(hash: Hash) {
      return await publicClient.getTransactionReceipt({ hash });
    },
  };
}
