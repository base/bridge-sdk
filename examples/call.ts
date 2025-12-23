import { createBridgeClient } from "../src";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";

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
