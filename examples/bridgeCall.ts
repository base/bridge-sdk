import { createBridgeSDK } from "..";

async function main() {
  const baseBridgeClient = createBridgeSDK({
    config: { solana: { payerKp: "examples/keypairs/tester.json" } },
  });

  const outgoing = await baseBridgeClient.bridgeCall({
    to: "0x5d3eB988Daa06151b68369cf957e917B4371d35d",
    value: 0,
    data: "0xd09de08a", // increment()
    payForRelay: true,
  });

  await baseBridgeClient.waitForMessageExecution(outgoing);
}

main().catch(console.error);
