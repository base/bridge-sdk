import { createBridgeClient } from "../src";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { base, solanaMainnet } from "../src/chains";
import { loadSolanaKeypair } from "../src/node";

// Example: Base (EVM) -> Solana token transfer (requires tokenMappings for ERC20->mint)
async function main() {
  const payer = await loadSolanaKeypair("~/.config/solana/id.json");

  const client = createBridgeClient({
    chains: {
      base: makeEvmAdapter({
        chain: base,
        rpcUrl: "https://mainnet.base.org",
        wallet: { type: "privateKey", key: "0xYOUR_PRIVATE_KEY" },
      }),
      solana: makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer,
        chain: solanaMainnet,
      }),
    },
    bridgeConfig: {
      tokenMappings: {
        [`${base.id}->${solanaMainnet.id}`]: {
          // ERC20 -> Solana mint (base58)
          "0x0000000000000000000000000000000000000000":
            "So11111111111111111111111111111111111111112",
        },
      },
    },
  });

  const op = await client.transfer({
    route: {
      sourceChain: base.id,
      destinationChain: solanaMainnet.id,
    },
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
