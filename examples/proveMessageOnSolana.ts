import { createBridgeSDK } from "..";

async function main() {
  const baseBridgeClient = createBridgeSDK({
    config: { solana: { payerKp: "examples/keypairs/tester.json" } },
  });

  const transactionHash = "0x"; // Base -> Solana transaction hash of init tx on Base

  const { messageHash } = await baseBridgeClient.proveOnSolana(transactionHash);

  console.log(`Message hash: ${messageHash}`);
}

main().catch(console.error);
