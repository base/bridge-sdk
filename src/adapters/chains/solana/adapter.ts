import {
  type Account,
  createSolanaRpc,
  type Address as SolAddress,
} from "@solana/kit";
import { solanaMainnet } from "../../../chains/solana";
import {
  fetchOutgoingMessage,
  type OutgoingMessage,
} from "../../../clients/ts/src/bridge";
import { validateRpcUrl } from "../../../core/validation";
import type { SolanaAdapterConfig, SolanaChainAdapter } from "./types";

/**
 * Creates a Solana chain adapter synchronously.
 *
 * @param config - Adapter configuration. The payer must be provided as a pre-loaded signer.
 *                 Use `loadSolanaKeypair()` from "bridge-sdk/node" to load a keypair from a file path.
 *
 * @example
 * import { loadSolanaKeypair } from "bridge-sdk/node";
 *
 * const payer = await loadSolanaKeypair("~/.config/solana/id.json");
 * const adapter = makeSolanaAdapter({
 *   rpcUrl: "https://api.mainnet-beta.solana.com",
 *   payer,
 * });
 */
export function makeSolanaAdapter(
  config: SolanaAdapterConfig,
): SolanaChainAdapter {
  validateRpcUrl(config.rpcUrl);

  const payer = config.payer;
  const chain = config.chain ?? solanaMainnet;
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
      address: SolAddress,
    ): Promise<Account<OutgoingMessage, string>> {
      return await fetchOutgoingMessage(rpc, address);
    },
  };
}
