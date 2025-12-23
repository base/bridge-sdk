import { createBridgeClient } from "../src";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";
import { baseMarketsProtocol } from "../src/adapters/protocols/base-markets/protocol";
import { address as solAddress } from "@solana/kit";

// Example: Solana -> Base (EVM) call
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

  const op = await client.call({
    route: { sourceChain: "solana:mainnet", destinationChain: "eip155:8453" },
    call: {
      to: "0x5d3eB988Daa06151b68369cf957e917B4371d35d",
      value: 0n,
      data: "0xd09de08a",
    },
    relay: { mode: "auto" },
  });

  const final = await client.status(op.messageRef);
  console.log(final);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
