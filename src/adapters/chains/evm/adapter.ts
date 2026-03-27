import {
  type Chain,
  createPublicClient,
  createWalletClient,
  type Hash,
  type Hex,
  http,
  isHex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BridgeValidationError } from "../../../core/errors";
import type { ChainRef } from "../../../core/types";
import { validateRpcUrl } from "../../../core/validation";
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
  validateRpcUrl(config.rpcUrl);

  if (config.chain == null) {
    if (
      config.chainId == null ||
      !Number.isInteger(config.chainId) ||
      config.chainId < 1
    ) {
      throw new BridgeValidationError(
        `Invalid EVM adapter config: chainId must be a positive integer, got ${String(config.chainId)}`,
      );
    }
  }

  const wallet = config.wallet ?? { type: "none" as const };
  if (wallet.type === "privateKey") {
    if (!isHex(wallet.key) || wallet.key.length !== 66) {
      throw new BridgeValidationError(
        "Invalid EVM adapter config: wallet private key must be a 0x-prefixed 64-character hex string",
      );
    }
  }

  const { chainId, viemChain } = resolveChain(config);
  const chain: ChainRef = { id: `eip155:${chainId}` };

  const transport = http(config.rpcUrl);

  const publicClient = createPublicClient({
    chain: viemChain,
    transport,
  }) as PublicClient;

  let walletClient: WalletClient | undefined;
  let privateKey: Hex | undefined;

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
