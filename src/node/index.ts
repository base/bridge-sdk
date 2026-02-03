import { readFile } from "node:fs/promises";
import {
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  type KeyPairSigner,
} from "@solana/kit";

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
 * This function requires Node.js and is not available in browser environments.
 * Import from "bridge-sdk/node" to use this utility.
 *
 * @example
 * import { loadSolanaKeypair } from "bridge-sdk/node";
 * import { makeSolanaAdapter } from "bridge-sdk/chains";
 *
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

export { expandHome };
