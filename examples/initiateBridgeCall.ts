import { createBridgeSDK } from "..";
import { address } from "@solana/kit";

async function main() {
  const bridgeClient = createBridgeSDK({
    config: {
      solana: { payerKp: "examples/keypairs/tester.json" },
      base: { privateKey: process.env.PRIVATE_KEY },
    },
  });

  // Example: Call the Memo program on Solana
  // Program ID: MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcQb
  const memoProgramId = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcQb");
  const message = "Hello from Base!";

  console.log("Initiating bridge call from Base...");
  const txHash = await bridgeClient.bridgeCallFromBase({
    ixs: [
      {
        programId: memoProgramId,
        accounts: [],
        data: new TextEncoder().encode(message),
      },
    ],
  });

  console.log(`Transaction sent: ${txHash}`);

  // Note: This process requires waiting for the Base block to be finalized and the state root to be available on Solana.
  // This typically takes ~15-25 minutes.
  // You should implement a polling mechanism or wait for this duration before attempting to prove the message.

  /*
  console.log("Waiting for message to be provable on Solana...");
  
  // Add waiting logic here...

  const { signature, messageHash } = await bridgeClient.proveOnSolana(txHash);
  console.log(`Proven. Message Hash: ${messageHash}`);

  if (signature) {
    console.log(`Proof Signature: ${signature}`);
  }

  const execSignature = await bridgeClient.executeOnSolana(messageHash);
  console.log(`Executed. Signature: ${execSignature}`);
  */
}

main().catch(console.error);
