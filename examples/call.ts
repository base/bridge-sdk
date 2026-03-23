import { createBridgeClient } from "../src";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { base, solanaMainnet } from "../src/chains";
import { loadSolanaKeypair } from "../src/node";

// Example: Solana -> Base (EVM) call
async function main() {
  const payer = await loadSolanaKeypair("~/.config/solana/id.json");

  const client = createBridgeClient({
    chains: {
      solana: makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer,
        chain: solanaMainnet,
      }),
      base: makeEvmAdapter({
        chain: base,
        rpcUrl: "https://mainnet.base.org",
        wallet: { type: "none" },
      }),
    },
  });

  const op = await client.call({
    route: {
      sourceChain: solanaMainnet.id,
      destinationChain: base.id,
    },
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

  // relay: "auto" means the relayer handles prove/execute in the background.
  // Monitor until a terminal state (Executed/Failed/Expired) or timeout.
  for await (const s of client.monitor(op.messageRef, { timeoutMs: 60_000 })) {
    console.log(s.type, s.at);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
