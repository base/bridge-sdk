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
import type {
  BridgeEvmChainRef,
  EvmAdapterConfig,
  EvmChainAdapter,
} from "./types";

function makeViemChain(chainId: number): Chain {
  // Minimal viem Chain object; callers can still override behavior via RPC.
  return {
    id: chainId,
    name: `eip155:${chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [""] } },
  } as const as Chain;
}

function isBridgeEvmChainRef(chain: unknown): chain is BridgeEvmChainRef {
  return (
    typeof chain === "object" &&
    chain !== null &&
    "viem" in chain &&
    "chainId" in chain
  );
}

function resolveChain(config: EvmAdapterConfig): {
  chainId: number;
  viemChain: Chain;
} {
  if (config.chain == null) {
    return {
      chainId: config.chainId,
      viemChain: makeViemChain(config.chainId),
    };
  }
  if (isBridgeEvmChainRef(config.chain)) {
    return { chainId: config.chain.chainId, viemChain: config.chain.viem };
  }
  // Plain viem Chain
  return { chainId: config.chain.id, viemChain: config.chain };
}

export function makeEvmAdapter(config: EvmAdapterConfig): EvmChainAdapter {
  const { chainId, viemChain } = resolveChain(config);
  const chain: ChainRef = { id: `eip155:${chainId}` };

  const transport = http(config.rpcUrl);

  const publicClient = createPublicClient({
    chain: viemChain,
    transport,
  }) as PublicClient;

  let walletClient: WalletClient | undefined;
  let privateKey: Hex | undefined;

  const wallet = config.wallet ?? { type: "none" as const };
  if (wallet.type === "privateKey") {
    const account = privateKeyToAccount(wallet.key);
    walletClient = createWalletClient({
      chain: viemChain,
      transport,
      account,
    }) as WalletClient;
    privateKey = wallet.key;
  }

  return {
    kind: "evm",
    chain,
    chainId,
    rpcUrl: config.rpcUrl,
    viemChain,
    publicClient,
    walletClient,
    privateKey,
    async ping() {
      await publicClient.getBlockNumber();
    },
    async getTransactionReceipt(hash: Hash) {
      return await publicClient.getTransactionReceipt({ hash });
    },
  };
}
