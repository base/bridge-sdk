import { createBridgeClient } from "../src";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";

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
