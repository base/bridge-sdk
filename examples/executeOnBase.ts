import { createBridgeSDK } from "..";

async function main() {
  const bridgeClient = createBridgeSDK({
    config: {
      solana: { payerKp: "examples/keypairs/tester.json" },
      base: { privateKey: "0x..." }, // Base wallet private key for manual execution
    },
  });

  // Bridge SOL from Solana to Base without paying for automatic relay
  const outgoingMessagePubkey = await bridgeClient.bridgeSol({
    to: "0x644e3DedB0e4F83Bfcf8F9992964d240224B74dc",
    amount: 1_000_000n, // 0.001 SOL
  });

  console.log(`Outgoing message created: ${outgoingMessagePubkey}`);

  // Manually execute the message on Base - this will automatically wait for the message to be validated
  const txHash = await bridgeClient.executeOnBase(outgoingMessagePubkey);

  console.log(`Message executed on Base: ${txHash}`);
}

main().catch(console.error);
