import { describe, expect, test } from "bun:test";

import { createBridgeSDK, DEFAULT_CONFIG } from "../src/index";

describe("BridgeSDK scaffolding", () => {
  test("instantiates with default config", () => {
    const sdk = createBridgeSDK();

    expect(sdk.getSupportedChains()).toHaveLength(
      DEFAULT_CONFIG.supportedChains.length
    );
  });

  test("returns mock quotes", async () => {
    const sdk = createBridgeSDK();
    const [defaultToken] = DEFAULT_CONFIG.supportedTokens;

    if (!defaultToken) {
      throw new Error("Default config lacks supported tokens");
    }

    const targetToken =
      DEFAULT_CONFIG.supportedTokens.find(
        (token) => token.chainId !== defaultToken.chainId
      ) ?? defaultToken;

    const quote = await sdk.getQuote({
      amount: "1",
      fromChainId: defaultToken.chainId,
      toChainId: targetToken.chainId,
      fromTokenAddress: defaultToken.address,
      toTokenAddress: targetToken.address,
      userAddress: "0x0000000000000000000000000000000000000000",
    });

    expect(quote.inputAmount).toBe("1");
    expect(quote.legs).toHaveLength(1);
  });
});
