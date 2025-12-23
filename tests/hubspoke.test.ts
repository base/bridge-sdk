import { test, expect } from "bun:test";
import { baseMarketsProtocol } from "../src/adapters/protocols/base-markets/protocol";
import { address as solAddress } from "@solana/kit";

test("base-markets protocol: supports only routes that include Base mainnet or Base Sepolia", () => {
  const proto = baseMarketsProtocol({
    deployments: {
      solana: {
        "solana:mainnet": {
          bridgeProgram: solAddress("11111111111111111111111111111111"),
          relayerProgram: solAddress("11111111111111111111111111111111"),
        },
      },
      evm: {
        "eip155:8453": {
          bridgeContract: "0x0000000000000000000000000000000000000000",
        },
        "eip155:84532": {
          bridgeContract: "0x0000000000000000000000000000000000000000",
        },
      },
    },
  });

  // Allowed (includes Base mainnet)
  expect(
    proto.supportsRoute({
      sourceChain: "solana:mainnet",
      destinationChain: "eip155:8453",
    })
  ).toBe(true);

  // Allowed (includes Base Sepolia)
  expect(
    proto.supportsRoute({
      sourceChain: "eip155:84532",
      destinationChain: "solana:mainnet",
    })
  ).toBe(true);

  // Disallowed: no Base in route
  expect(
    proto.supportsRoute({
      sourceChain: "solana:mainnet",
      destinationChain: "eip155:10",
    })
  ).toBe(false);
});
