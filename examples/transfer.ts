import { createBridgeClient } from "../src";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";
import { baseMarketsProtocol } from "../src/adapters/protocols/base-markets/protocol";
import { address as solAddress } from "@solana/kit";

// Example: Solana -> Base (EVM) transfer (native SOL)
async function main() {
  const client = createBridgeClient({
    chains: {
      "solana:mainnet": await makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer: { type: "keypairPath", path: "~/.config/solana/id.json" },
        chain: { id: "solana:mainnet" },
      }),
      "eip155:8453": makeEvmAdapter({
        chainId: 8453,
        rpcUrl: "https://mainnet.base.org",
        wallet: { type: "none" },
      }),
    },
    protocols: [
      baseMarketsProtocol({
        deployments: {
          solana: {
            "solana:mainnet": {
              bridgeProgram: solAddress(
                "HNCne2FkVaNghhjKXapxJzPaBvAKDG1Ge3gqhZyfVWLM"
              ),
              relayerProgram: solAddress(
                "g1et5VenhfJHJwsdJsDbxWZuotD5H4iELNG61kS4fb9"
              ),
            },
          },
          evm: {
            "eip155:8453": {
              bridgeContract: "0x3eff766C76a1be2Ce1aCF2B69c78bCae257D5188",
            },
          },
        },
      }),
    ],
  });

  const op = await client.transfer({
    route: { sourceChain: "solana:mainnet", destinationChain: "eip155:8453" },
    asset: { kind: "native" },
    amount: 1_000_000n,
    recipient: "0x644e3DedB0e4F83Bfcf8F9992964d240224B74dc",
    relay: { mode: "auto" },
  });

  // Monitor until terminal state (Executed/Failed/Expired) or timeout.
  for await (const s of client.monitor(op.messageRef, { timeoutMs: 60_000 })) {
    console.log(s.type, s.at);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
