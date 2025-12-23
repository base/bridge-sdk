import { test, expect } from "bun:test";
import { supportsBridgeRoute } from "../src/core/protocol/router";

test("bridge: supports only routes that include Base mainnet or Base Sepolia", () => {
  // Allowed (includes Base mainnet)
  expect(
    supportsBridgeRoute({
      sourceChain: "solana:mainnet",
      destinationChain: "eip155:8453",
    })
  ).toBe(true);

  // Allowed (includes Base Sepolia)
  expect(
    supportsBridgeRoute({
      sourceChain: "eip155:84532",
      destinationChain: "solana:mainnet",
    })
  ).toBe(true);

  // Disallowed: no Base in route
  expect(
    supportsBridgeRoute({
      sourceChain: "solana:mainnet",
      destinationChain: "eip155:10",
    })
  ).toBe(false);
});
