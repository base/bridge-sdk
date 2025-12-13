import { createBridgeSDK } from "..";
import { address } from "@solana/kit";
import { parseEther } from "viem";

async function main() {
  const bridgeClient = createBridgeSDK({
    config: {
      solana: { payerKp: "examples/keypairs/tester.json" },
      base: { privateKey: process.env.PRIVATE_KEY as `0x${string}` },
    },
  });

  // Example addresses
  // Local Token: ERC20 address on Base
  const localToken = "0x1234567890123456789012345678901234567890"; // Replace with actual token address
  // Remote Token: SPL Token Mint on Solana
  const remoteToken = address("So11111111111111111111111111111111111111112"); // Replace with actual mint address
  // To: Recipient on Solana
  const to = address("So11111111111111111111111111111111111111112"); // Replace with actual recipient address
  
  const amount = parseEther("1"); // 1 token

  console.log("Initiating bridge token transfer from Base...");
  const txHash = await bridgeClient.bridgeTokenFromBase({
    transfer: {
      localToken,
      remoteToken,
      to,
      amount,
    },
    ixs: [], // Optional additional instructions
  });

  console.log(`Transaction sent: ${txHash}`);

  // Note: This process requires waiting for the Base block to be finalized and the state root to be available on Solana.
  // This typically takes ~15-25 minutes.
  // You should implement a polling mechanism or wait for this duration before attempting to prove the message.
}

main().catch(console.error);

