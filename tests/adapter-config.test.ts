import { describe, expect, test } from "bun:test";
import type { KeyPairSigner } from "@solana/kit";
import { makeEvmAdapter } from "../src/adapters/chains/evm/adapter";
import type { EvmAdapterConfig } from "../src/adapters/chains/evm/types";
import { makeSolanaAdapter } from "../src/adapters/chains/solana/adapter";
import { BridgeValidationError } from "../src/core/errors";
import { validateRpcUrl } from "../src/core/validation";

/** Minimal mock that satisfies the KeyPairSigner interface shape at runtime. */
const mockPayer = {
  address: "11111111111111111111111111111111",
  keyPair: {},
} as unknown as KeyPairSigner;

const VALID_RPC = "https://api.mainnet-beta.solana.com";

describe("validateRpcUrl", () => {
  describe("rejects invalid URLs", () => {
    test("throws for empty string", () => {
      expect(() => validateRpcUrl("")).toThrow("Invalid RPC URL");
    });

    test("throws for whitespace-only string", () => {
      expect(() => validateRpcUrl("   ")).toThrow("Invalid RPC URL");
    });

    test("throws for non-URL string", () => {
      expect(() => validateRpcUrl("not-a-url")).toThrow("Invalid RPC URL");
    });

    test("throws for ws:// scheme", () => {
      expect(() => validateRpcUrl("ws://localhost:8900")).toThrow(
        "expected http: or https: scheme",
      );
    });

    test("throws for wss:// scheme", () => {
      expect(() => validateRpcUrl("wss://api.example.com")).toThrow(
        "expected http: or https: scheme",
      );
    });

    test("throws for ftp:// scheme", () => {
      expect(() => validateRpcUrl("ftp://files.example.com")).toThrow(
        "expected http: or https: scheme",
      );
    });
  });

  describe("accepts valid URLs", () => {
    test("accepts https:// URL", () => {
      expect(() =>
        validateRpcUrl("https://api.mainnet-beta.solana.com"),
      ).not.toThrow();
    });

    test("accepts http:// URL (localhost dev)", () => {
      expect(() => validateRpcUrl("http://localhost:8899")).not.toThrow();
    });

    test("accepts http:// URL with path", () => {
      expect(() =>
        validateRpcUrl("https://rpc.example.com/v1/mainnet"),
      ).not.toThrow();
    });
  });

  describe("error properties", () => {
    test("thrown error is a BridgeValidationError with expected fields", () => {
      let error: BridgeValidationError | undefined;
      try {
        validateRpcUrl("");
      } catch (e) {
        error = e as BridgeValidationError;
      }
      expect(error).toBeInstanceOf(BridgeValidationError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.outcome).toBe("user_fix");
      expect(error?.stage).toBe("initiate");
    });

    test("error message includes the invalid value", () => {
      expect(() => validateRpcUrl("bad-url")).toThrow('got "bad-url"');
    });
  });
});

describe("makeSolanaAdapter config validation", () => {
  test("throws for empty rpcUrl", () => {
    expect(() => makeSolanaAdapter({ rpcUrl: "", payer: mockPayer })).toThrow(
      "Invalid RPC URL",
    );
  });

  test("throws for invalid rpcUrl", () => {
    expect(() =>
      makeSolanaAdapter({ rpcUrl: "not-a-url", payer: mockPayer }),
    ).toThrow("Invalid RPC URL");
  });

  test("throws for ws:// rpcUrl", () => {
    expect(() =>
      makeSolanaAdapter({ rpcUrl: "ws://localhost:8900", payer: mockPayer }),
    ).toThrow("expected http: or https: scheme");
  });

  test("all thrown errors are BridgeValidationError", () => {
    let error: BridgeValidationError | undefined;
    try {
      makeSolanaAdapter({ rpcUrl: "", payer: mockPayer });
    } catch (e) {
      error = e as BridgeValidationError;
    }
    expect(error).toBeInstanceOf(BridgeValidationError);
    expect(error?.code).toBe("VALIDATION");
    expect(error?.outcome).toBe("user_fix");
  });

  test("accepts valid config", () => {
    expect(() =>
      makeSolanaAdapter({ rpcUrl: VALID_RPC, payer: mockPayer }),
    ).not.toThrow();
  });
});

describe("makeEvmAdapter config validation", () => {
  const validConfig: EvmAdapterConfig = {
    rpcUrl: "https://mainnet.base.org",
    chainId: 8453,
  };

  describe("rpcUrl validation", () => {
    test("throws for empty rpcUrl", () => {
      expect(() => makeEvmAdapter({ ...validConfig, rpcUrl: "" })).toThrow(
        "Invalid RPC URL",
      );
    });

    test("throws for invalid rpcUrl", () => {
      expect(() =>
        makeEvmAdapter({ ...validConfig, rpcUrl: "not-a-url" }),
      ).toThrow("Invalid RPC URL");
    });

    test("throws for ws:// rpcUrl", () => {
      expect(() =>
        makeEvmAdapter({ ...validConfig, rpcUrl: "ws://localhost:8545" }),
      ).toThrow("expected http: or https: scheme");
    });
  });

  describe("chainId validation", () => {
    test("throws for chainId = 0", () => {
      expect(() =>
        makeEvmAdapter({ rpcUrl: validConfig.rpcUrl, chainId: 0 }),
      ).toThrow("chainId must be a positive integer");
    });

    test("throws for negative chainId", () => {
      expect(() =>
        makeEvmAdapter({ rpcUrl: validConfig.rpcUrl, chainId: -1 }),
      ).toThrow("chainId must be a positive integer");
    });

    test("throws for non-integer chainId", () => {
      expect(() =>
        makeEvmAdapter({ rpcUrl: validConfig.rpcUrl, chainId: 1.5 }),
      ).toThrow("chainId must be a positive integer");
    });

    test("does not validate chainId when chain object is provided", () => {
      // When a chain object is provided, chainId comes from the chain
      expect(() =>
        makeEvmAdapter({
          rpcUrl: validConfig.rpcUrl,
          chain: {
            id: 8453,
            name: "Base",
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: [""] } },
          },
        }),
      ).not.toThrow();
    });
  });

  describe("wallet private key validation", () => {
    test("throws for invalid private key (not hex)", () => {
      expect(() =>
        makeEvmAdapter({
          ...validConfig,
          wallet: {
            type: "privateKey",
            key: "not-a-key" as `0x${string}`,
          },
        }),
      ).toThrow("wallet private key must be a 0x-prefixed 64-character hex");
    });

    test("throws for too-short private key", () => {
      expect(() =>
        makeEvmAdapter({
          ...validConfig,
          wallet: {
            type: "privateKey",
            key: "0x1234",
          },
        }),
      ).toThrow("wallet private key must be a 0x-prefixed 64-character hex");
    });

    test("accepts valid private key", () => {
      expect(() =>
        makeEvmAdapter({
          ...validConfig,
          wallet: {
            type: "privateKey",
            key: `0x${"a".repeat(64)}` as `0x${string}`,
          },
        }),
      ).not.toThrow();
    });

    test("does not validate key when wallet type is none", () => {
      expect(() =>
        makeEvmAdapter({
          ...validConfig,
          wallet: { type: "none" },
        }),
      ).not.toThrow();
    });
  });

  describe("error properties", () => {
    test("all thrown errors are BridgeValidationError", () => {
      let error: BridgeValidationError | undefined;
      try {
        makeEvmAdapter({ ...validConfig, rpcUrl: "" });
      } catch (e) {
        error = e as BridgeValidationError;
      }
      expect(error).toBeInstanceOf(BridgeValidationError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.outcome).toBe("user_fix");
    });
  });

  test("accepts valid config with chainId", () => {
    expect(() => makeEvmAdapter(validConfig)).not.toThrow();
  });
});
