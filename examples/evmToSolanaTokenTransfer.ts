import { createBridgeClient } from "../src";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";

// Example: Base (EVM) -> Solana token transfer (requires tokenMappings for ERC20->mint)
async function main() {
  const client = createBridgeClient({
    chains: {
      "eip155:8453": makeEvmAdapter({
        chainId: 8453,
        rpcUrl: "https://mainnet.base.org",
        wallet: { type: "privateKey", key: "0xYOUR_PRIVATE_KEY" },
      }),
      "solana:mainnet": await makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer: { type: "keypairPath", path: "~/.config/solana/id.json" },
        chain: { id: "solana:mainnet" },
      }),
    },
    bridgeConfig: {
      tokenMappings: {
        "eip155:8453->solana:mainnet": {
          // ERC20 -> Solana mint (base58)
          "0x0000000000000000000000000000000000000000":
            "So11111111111111111111111111111111111111112",
        },
      },
    },
  });

  const op = await client.transfer({
    route: { sourceChain: "eip155:8453", destinationChain: "solana:mainnet" },
    asset: {
      kind: "token",
      address: "0x0000000000000000000000000000000000000000",
    },
    amount: 1n,
    recipient: "11111111111111111111111111111111",
  });

  // Prove then execute if needed.
  await client.prove(op.messageRef);
  await client.execute(op.messageRef);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
