import { createBridgeSDK } from "..";

async function main() {
  const baseBridgeClient = createBridgeSDK({
    config: { solana: { payerKp: "examples/keypairs/tester.json" } },
  });

  const outgoing = await baseBridgeClient.bridgeWrapped({
    to: "0x644e3DedB0e4F83Bfcf8F9992964d240224B74dc",
    mint: "7qxnUBBmW8oiuz9skKkGQFvY1qRUP6zF3emA5bneyGaJ",
    amount: 1_000_000n, // 0.001 Token (assuming 9 decimals)
    payForRelay: true,
  });

  await baseBridgeClient.waitForMessageExecution(outgoing);
}

main().catch(console.error);
