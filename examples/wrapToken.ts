import { createBridgeSDK } from "..";

async function main() {
  const baseBridgeClient = createBridgeSDK({
    config: { solana: { payerKp: "examples/keypairs/tester.json" } },
  });

  const outgoing = await baseBridgeClient.wrapToken({
    remoteToken: "0xcd9E97cf45BC53acC35A5aFb70458c47c214E7C7",
    name: "MyToken",
    symbol: "MT",
    decimals: 9,
    scalerExponent: 9,
    payForRelay: true,
  });

  await baseBridgeClient.waitForMessageExecution(outgoing);
}

main().catch(console.error);
