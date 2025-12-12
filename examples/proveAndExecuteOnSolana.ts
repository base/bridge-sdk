import { createBridgeSDK } from "..";

async function main() {
  const baseBridgeClient = createBridgeSDK({
    config: { solana: { payerKp: "examples/keypairs/tester.json" } },
  });

  const transactionHash = "0x"; // Base -> Solana transaction hash of init tx on Base

  const { messageHash } = await baseBridgeClient.proveOnSolana(transactionHash);
  const signature = await baseBridgeClient.executeOnSolana(messageHash);
  console.log(`Signature: ${signature}`);
}

main().catch(console.error);
