import { createBridgeSDK } from "..";

async function main() {
  const baseBridgeClient = createBridgeSDK({
    config: { solana: { payerKp: "examples/keypairs/tester.json" } },
  });

  const outgoing = await baseBridgeClient.bridgeSol({
    to: "0x644e3DedB0e4F83Bfcf8F9992964d240224B74dc",
    amount: 0.001,
    payForRelay: true,
  });

  await baseBridgeClient.waitForMessageExecution(outgoing);
}

main().catch(console.error);
