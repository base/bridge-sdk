import { describe, expect, test } from "bun:test";
import { BridgeValidationError } from "../src/core/errors";
import { validateAmount } from "../src/core/validation";

describe("validateAmount", () => {
  describe("rejects invalid amounts", () => {
    test("throws for zero amount", () => {
      expect(() => validateAmount(0n)).toThrow(
        "Amount must be greater than zero",
      );
    });

    test("throws for negative amount", () => {
      expect(() => validateAmount(-1n)).toThrow(
        "Amount must be greater than zero",
      );
    });

    test("throws for amount exceeding uint64 max (2^64)", () => {
      expect(() => validateAmount(2n ** 64n)).toThrow(
        "Amount exceeds maximum transferable amount",
      );
    });
  });

  describe("accepts valid amounts", () => {
    test("accepts minimum valid amount (1)", () => {
      expect(() => validateAmount(1n)).not.toThrow();
    });

    test("accepts maximum valid amount (2^64 - 1)", () => {
      expect(() => validateAmount(2n ** 64n - 1n)).not.toThrow();
    });

    test("accepts typical SOL amount (1 SOL = 1e9 lamports)", () => {
      expect(() => validateAmount(1_000_000_000n)).not.toThrow();
    });

    test("accepts typical token amount", () => {
      expect(() => validateAmount(100_000_000n)).not.toThrow();
    });
  });

  describe("error properties", () => {
    test("thrown error is a BridgeValidationError with expected fields", () => {
      let error: BridgeValidationError | undefined;
      try {
        validateAmount(0n);
      } catch (e) {
        error = e as BridgeValidationError;
      }
      expect(error).toBeInstanceOf(BridgeValidationError);
      expect(error!.code).toBe("VALIDATION");
      expect(error!.outcome).toBe("user_fix");
      expect(error!.stage).toBe("initiate");
    });
  });
});
