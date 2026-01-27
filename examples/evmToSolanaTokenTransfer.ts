import { createBridgeClient } from "../src";
import {
  loadSolanaKeypair,
  makeSolanaAdapter,
} from "../src/adapters/chains/solana/adapter";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";
import { BASE_MAINNET_CHAIN_ID } from "../src/core/protocol/router";

// Example: Base (EVM) -> Solana token transfer (requires tokenMappings for ERC20->mint)
async function main() {
  const payer = await loadSolanaKeypair("~/.config/solana/id.json");

  const client = createBridgeClient({
    chains: {
      [BASE_MAINNET_CHAIN_ID]: makeEvmAdapter({
        chainId: 8453,
        rpcUrl: "https://mainnet.base.org",
        wallet: { type: "privateKey", key: "0xYOUR_PRIVATE_KEY" },
      }),
      "solana:mainnet": makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer: { type: "signer", signer: payer },
        chain: { id: "solana:mainnet" },
      }),
    },
    bridgeConfig: {
      tokenMappings: {
        [`${BASE_MAINNET_CHAIN_ID}->solana:mainnet`]: {
          // ERC20 -> Solana mint (base58)
          "0x0000000000000000000000000000000000000000":
            "So11111111111111111111111111111111111111112",
        },
      },
    },
  });

  const op = await client.transfer({
    route: { sourceChain: BASE_MAINNET_CHAIN_ID, destinationChain: "solana:mainnet" },
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
