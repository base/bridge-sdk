import { describe, expect, test } from "bun:test";
import {
  type Hash,
  type TransactionReceipt,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import {
  BridgeExecutionRevertedError,
  BridgeTransactionDroppedError,
} from "../src/core/errors";
import { BaseEngine } from "../src/core/protocol/engines/base-engine";
import { NOOP_LOGGER } from "../src/utils/logger";
import { FAKE_TX_HASH, makeReceipt } from "./test-helpers";

const REPLACEMENT_TX_HASH =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hash;

/**
 * Build a BaseEngine with stubbed publicClient.waitForTransactionReceipt.
 * The `waitFn` receives the options passed by confirmTransaction and should
 * behave like viem's implementation (resolve with receipt, call onReplaced,
 * or throw).
 */
function buildEngine(
  waitFn: (opts: {
    hash: Hash;
    confirmations: number;
    timeout: number;
    pollingInterval: number;
    onReplaced: (replacement: {
      reason: string;
      transaction: { hash: Hash };
    }) => void;
  }) => Promise<TransactionReceipt>,
) {
  const engine = Object.create(BaseEngine.prototype) as BaseEngine;
  const stub = engine as unknown as Record<string, unknown>;

  stub.config = { confirmation: {} };
  stub.logger = NOOP_LOGGER;
  stub.publicClient = {
    waitForTransactionReceipt: waitFn,
  };

  return engine;
}

/**
 * Call the private confirmTransaction method via bracket-notation.
 */
function callConfirm(
  engine: BaseEngine,
  hash: Hash = FAKE_TX_HASH,
  stage: "initiate" | "execute" = "initiate",
) {
  return (
    engine as unknown as {
      confirmTransaction: (
        hash: Hash,
        stage: string,
      ) => Promise<TransactionReceipt>;
    }
  ).confirmTransaction(hash, stage);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseEngine.confirmTransaction", () => {
  test("returns receipt on successful confirmation", async () => {
    const expected = makeReceipt();
    const engine = buildEngine(async () => expected);

    const receipt = await callConfirm(engine);
    expect(receipt).toBe(expected);
  });

  test("throws BridgeExecutionRevertedError when receipt status is reverted", async () => {
    const engine = buildEngine(async () => makeReceipt({ status: "reverted" }));

    try {
      await callConfirm(engine);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeExecutionRevertedError);
      if (!(err instanceof BridgeExecutionRevertedError)) throw err;
      expect(err.code).toBe("EXECUTION_REVERTED");
      expect(err.stage).toBe("initiate");
      expect(err.message).toContain(FAKE_TX_HASH);
    }
  });

  test("throws BridgeTransactionDroppedError on timeout", async () => {
    const timeoutError = new WaitForTransactionReceiptTimeoutError({
      hash: FAKE_TX_HASH,
    });

    const engine = buildEngine(async () => {
      throw timeoutError;
    });

    try {
      await callConfirm(engine);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeTransactionDroppedError);
      if (!(err instanceof BridgeTransactionDroppedError)) throw err;
      expect(err.code).toBe("TRANSACTION_DROPPED");
      expect(err.stage).toBe("initiate");
      expect(err.message).toContain("dropped from the mempool");
    }
  });

  test("allows repriced replacement through (same intent, higher gas)", async () => {
    const repricedReceipt = makeReceipt({
      transactionHash: REPLACEMENT_TX_HASH,
    });

    const engine = buildEngine(async (opts) => {
      opts.onReplaced({
        reason: "repriced",
        transaction: { hash: REPLACEMENT_TX_HASH },
      });
      return repricedReceipt;
    });

    const receipt = await callConfirm(engine);
    expect(receipt).toBe(repricedReceipt);
  });

  test("throws BridgeTransactionDroppedError when transaction is cancelled", async () => {
    const engine = buildEngine(async (opts) => {
      opts.onReplaced({
        reason: "cancelled",
        transaction: { hash: REPLACEMENT_TX_HASH },
      });
      return makeReceipt({ transactionHash: REPLACEMENT_TX_HASH });
    });

    try {
      await callConfirm(engine);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeTransactionDroppedError);
      if (!(err instanceof BridgeTransactionDroppedError)) throw err;
      expect(err.code).toBe("TRANSACTION_DROPPED");
      expect(err.message).toContain("cancelled");
      expect(err.message).toContain(FAKE_TX_HASH);
      expect(err.message).toContain(REPLACEMENT_TX_HASH);
    }
  });

  test("throws BridgeTransactionDroppedError when transaction is replaced", async () => {
    const engine = buildEngine(async (opts) => {
      opts.onReplaced({
        reason: "replaced",
        transaction: { hash: REPLACEMENT_TX_HASH },
      });
      return makeReceipt({ transactionHash: REPLACEMENT_TX_HASH });
    });

    try {
      await callConfirm(engine);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeTransactionDroppedError);
      if (!(err instanceof BridgeTransactionDroppedError)) throw err;
      expect(err.code).toBe("TRANSACTION_DROPPED");
      expect(err.message).toContain("replaced");
    }
  });

  test("propagates unknown errors directly", async () => {
    const engine = buildEngine(async () => {
      throw new Error("RPC connection failed");
    });

    try {
      await callConfirm(engine);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(BridgeTransactionDroppedError);
      expect((err as Error).message).toBe("RPC connection failed");
    }
  });

  test("uses correct stage in error context", async () => {
    const engine = buildEngine(async () => makeReceipt({ status: "reverted" }));

    try {
      await callConfirm(engine, FAKE_TX_HASH, "execute");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeExecutionRevertedError);
      if (!(err instanceof BridgeExecutionRevertedError)) throw err;
      expect(err.stage).toBe("execute");
    }
  });
});
