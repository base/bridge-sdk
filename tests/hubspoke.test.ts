import { expect, test } from "bun:test";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  supportsBridgeRoute,
} from "../src/core/protocol/router";

test("bridge: supports only routes that include Base mainnet or Base Sepolia", () => {
  // Allowed (includes Base mainnet)
  expect(
    supportsBridgeRoute({
      sourceChain: "solana:mainnet",
      destinationChain: BASE_MAINNET_CHAIN_ID,
    }),
  ).toBe(true);

  // Allowed (includes Base Sepolia)
  expect(
    supportsBridgeRoute({
      sourceChain: BASE_SEPOLIA_CHAIN_ID,
      destinationChain: "solana:mainnet",
    }),
  ).toBe(true);

  // Disallowed: no Base in route
  expect(
    supportsBridgeRoute({
      sourceChain: "solana:mainnet",
      destinationChain: "eip155:10",
    }),
  ).toBe(false);
});
