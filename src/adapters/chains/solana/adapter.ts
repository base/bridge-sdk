import {
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  createSolanaRpc,
  type Account,
  type Address as SolAddress,
  type KeyPairSigner,
} from "@solana/kit";
import { readFile } from "node:fs/promises";
import type { ChainRef } from "../../../core/types";
import {
  fetchOutgoingMessage,
  type OutgoingMessage,
} from "../../../clients/ts/src/bridge";
import type { SolanaAdapterConfig, SolanaChainAdapter } from "./types";

function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    return `${home}/${path.slice(2)}`;
  }
  return path;
}

/**
 * Loads a Solana keypair from a JSON file and returns a KeyPairSigner.
 * Use this to pre-load your keypair before passing it to makeSolanaAdapter.
 *
 * @example
 * const payer = await loadSolanaKeypair("~/.config/solana/id.json");
 * const adapter = makeSolanaAdapter({
 *   rpcUrl: "https://api.mainnet-beta.solana.com",
 *   payer: { type: "signer", signer: payer },
 * });
 */
export async function loadSolanaKeypair(path: string): Promise<KeyPairSigner> {
  const expandedPath = expandHome(path);
  const keypairJson = await readFile(expandedPath, "utf8");
  const keypairBytes = new Uint8Array(JSON.parse(keypairJson));
  const keypair = await createKeyPairFromBytes(keypairBytes);
  return await createSignerFromKeyPair(keypair);
}

/**
 * Creates a Solana chain adapter synchronously.
 *
 * @param config - Adapter configuration. The payer must be provided as a pre-loaded signer.
 *                 Use `loadSolanaKeypair()` to load a keypair from a file path.
 *
 * @example
 * const payer = await loadSolanaKeypair("~/.config/solana/id.json");
 * const adapter = makeSolanaAdapter({
 *   rpcUrl: "https://api.mainnet-beta.solana.com",
 *   payer: { type: "signer", signer: payer },
 * });
 */
export function makeSolanaAdapter(
  config: SolanaAdapterConfig
): SolanaChainAdapter {
  const payer = config.payer.signer;
  const chain: ChainRef = config.chain ?? { id: "solana:mainnet" };
  const rpc = createSolanaRpc(config.rpcUrl);

  return {
    kind: "solana",
    chain,
    rpcUrl: config.rpcUrl,
    payer,
    async ping() {
      await rpc.getLatestBlockhash().send();
    },
    async fetchOutgoingMessage(
      address: SolAddress
    ): Promise<Account<OutgoingMessage, string>> {
      return await fetchOutgoingMessage(rpc, address);
    },
  };
}
