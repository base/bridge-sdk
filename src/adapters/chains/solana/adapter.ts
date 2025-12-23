import {
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  createSolanaRpc,
  type Account,
  type Address as SolAddress,
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

export async function makeSolanaAdapter(
  config: SolanaAdapterConfig
): Promise<SolanaChainAdapter> {
  const payerPath = expandHome(config.payer.path);
  const keypairJson = await readFile(payerPath, "utf8");
  const keypairBytes = new Uint8Array(JSON.parse(keypairJson));
  const keypair = await createKeyPairFromBytes(keypairBytes);
  const payer = await createSignerFromKeyPair(keypair);

  const chain: ChainRef = config.chain ?? { id: "solana:mainnet" };

  const rpc = createSolanaRpc(config.rpcUrl);

  return {
    kind: "solana",
    chain,
    rpcUrl: config.rpcUrl,
    payerKeypairPath: payerPath,
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
