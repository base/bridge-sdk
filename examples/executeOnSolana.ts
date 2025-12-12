import { createBridgeSDK } from "..";

async function main() {
  const baseBridgeClient = createBridgeSDK({
    config: { solana: { payerKp: "examples/keypairs/tester.json" } },
  });

  const messageHash = "0x"; // Base -> Solana message hash

  const signature = await baseBridgeClient.executeOnSolana(messageHash);

  console.log(`Signature: ${signature}`);
}

main().catch(console.error);
