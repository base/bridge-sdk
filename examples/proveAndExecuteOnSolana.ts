import { createBridgeSDK } from "..";

async function main() {
  const baseBridgeClient = createBridgeSDK({
    config: { solana: { payerKp: "examples/keypairs/tester.json" } },
  });

  const transactionHash = "0x"; // Base -> Solana transaction hash of init tx on Base

  const { proveSignature, executeSignature, messageHash } =
    await baseBridgeClient.proveAndExecuteOnSolana(transactionHash);

  console.log(`Message hash: ${messageHash}`);
  console.log(`Prove signature: ${proveSignature}`);
  console.log(`Execute signature: ${executeSignature}`);
}

main().catch(console.error);
