import { createBridgeClient } from "../src";
import { base, solanaMainnet } from "../src/chains";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";

// Example: Solana -> Base (EVM) transfer (native SOL)
async function main() {
  const client = createBridgeClient({
    chains: {
      solana: await makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer: { type: "keypairPath", path: "~/.config/solana/id.json" },
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
