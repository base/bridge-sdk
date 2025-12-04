import { createBridgeSDK } from "..";

async function main() {
  const baseBridgeClient = createBridgeSDK({
    config: { solana: { payerKp: "examples/keypairs/tester.json" } },
  });

  const outgoing = await baseBridgeClient.bridgeSpl({
    to: "0x644e3DedB0e4F83Bfcf8F9992964d240224B74dc",
    mint: "9YEGpFKedz7i8hMB7gDWQGuAfCRHUKBMCbTjnMi8vtUc",
    remoteToken: "0xcd9E97cf45BC53acC35A5aFb70458c47c214E7C7",
    amount: 1_000_000_000n, // 1 Token (assuming 9 decimals)
    payForRelay: true,
  });

  await baseBridgeClient.waitForMessageExecution(outgoing);
}

main().catch(console.error);
