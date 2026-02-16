import { createBridgeClient } from "../src";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { base, solanaMainnet } from "../src/chains";
import { loadSolanaKeypair } from "../src/node";

// Example: Solana -> Base (EVM) transfer (native SOL)
async function main() {
  const payer = await loadSolanaKeypair("~/.config/solana/id.json");

  const client = createBridgeClient({
    chains: {
      solana: makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer: { type: "signer", signer: payer },
        chain: solanaMainnet,
      }),
      base: makeEvmAdapter({
        chain: base,
        rpcUrl: "https://mainnet.base.org",
        wallet: { type: "none" },
      }),
    },
  });

  const op = await client.transfer({
    route: {
      sourceChain: solanaMainnet.id,
      destinationChain: base.id,
    },
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
