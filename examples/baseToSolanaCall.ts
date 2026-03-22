import { createBridgeClient } from "../src";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { base, solanaMainnet } from "../src/chains";
import { loadSolanaKeypair } from "../src/node";

/**
 * Example: Base -> Solana call
 *
 * This demonstrates how to execute Solana program instructions from Base
 * using the SolanaCall type. The instructions will be executed via CPI
 * by the bridge program on Solana.
 */
async function main() {
  const payer = await loadSolanaKeypair("~/.config/solana/id.json");

  const client = createBridgeClient({
    chains: {
      base: makeEvmAdapter({
        chain: base,
        rpcUrl: "https://mainnet.base.org",
        wallet: { type: "privateKey", key: "0xYOUR_PRIVATE_KEY" },
      }),
      solana: makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer: { type: "signer", signer: payer },
        chain: solanaMainnet,
      }),
    },
  });

  // Example: Call a Solana program from Base
  // The SolanaCall contains instructions that will be executed via CPI
  const op = await client.call({
    route: {
      sourceChain: base.id,
      destinationChain: solanaMainnet.id,
    },
    call: {
      kind: "solana",
      call: {
        instructions: [
          {
            // Example program ID (replace with your actual program)
            programId: "YourProgramId111111111111111111111111111111",
            accounts: [
              {
                // Example account that the instruction will interact with
                pubkey: "AccountPubkey11111111111111111111111111111111",
                isWritable: true,
                isSigner: false, // Bridge CPI authority signs, not this account
              },
              // Add more accounts as needed by your program
            ],
            // Instruction data (e.g., serialized with Borsh or custom format)
            data: new Uint8Array([
              /* your instruction discriminator and args */
            ]),
          },
        ],
      },
    },
  });

  console.log("Message initiated:", op.messageRef.source.id.value);
  console.log("Transaction hash:", op.initiationTx);

  // Base -> SVM requires proving and executing
  console.log("Proving message...");
  const proveResult = await client.prove(op.messageRef);
  console.log("Message proven:", proveResult.proofTx);

  console.log("Executing message...");
  const execResult = await client.execute(op.messageRef);
  console.log("Message executed:", execResult.executionTx);

  // Check final status
  const status = await client.status(op.messageRef);
  console.log("Final status:", status.type);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
