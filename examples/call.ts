import { createBridgeClient } from "../src";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";
import { BASE_MAINNET_CHAIN_ID } from "../src/core/protocol/router";
import { loadSolanaKeypair } from "../src/node";

// Example: Solana -> Base (EVM) call
async function main() {
  const payer = await loadSolanaKeypair("~/.config/solana/id.json");

  const client = createBridgeClient({
    chains: {
      "solana:mainnet": makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer: { type: "signer", signer: payer },
        chain: { id: "solana:mainnet" },
      }),
      [BASE_MAINNET_CHAIN_ID]: makeEvmAdapter({
        chainId: 8453,
        rpcUrl: "https://mainnet.base.org",
        wallet: { type: "none" },
      }),
    },
  });

  const op = await client.call({
    route: { sourceChain: "solana:mainnet", destinationChain: BASE_MAINNET_CHAIN_ID },
    call: {
      kind: "evm",
      call: {
        to: "0x5d3eB988Daa06151b68369cf957e917B4371d35d",
        value: 0n,
        data: "0xd09de08a",
      },
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
