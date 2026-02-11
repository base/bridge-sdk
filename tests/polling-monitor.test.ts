import { test, expect } from "bun:test";
import { pollingMonitor } from "../src/core/monitor/polling";
import type { ExecutionStatus } from "../src/core/types";

async function collect(
  iter: AsyncIterable<ExecutionStatus>
): Promise<ExecutionStatus[]> {
  const results: ExecutionStatus[] = [];
  for await (const s of iter) {
    results.push(s);
  }
  return results;
}

test("pollingMonitor: abort before iteration throws immediately", async () => {
  const ac = new AbortController();
  ac.abort();

  const getStatus = () =>
    Promise.resolve({ type: "Unknown", at: Date.now() } as ExecutionStatus);

  await expect(
    collect(pollingMonitor(getStatus, { signal: ac.signal }))
  ).rejects.toThrow();
});

test("pollingMonitor: abort during sleep cancels promptly", async () => {
  const ac = new AbortController();
  let callCount = 0;

  const getStatus = (): Promise<ExecutionStatus> => {
    callCount++;
    // After first poll, schedule an abort so it fires during sleep
    if (callCount === 1) {
      setTimeout(() => ac.abort(), 10);
    }
    return Promise.resolve({ type: "Unknown", at: Date.now() });
  };

  const results: ExecutionStatus[] = [];
  try {
    for await (const s of pollingMonitor(getStatus, {
      pollIntervalMs: 60_000,
      signal: ac.signal,
    })) {
      results.push(s);
    }
    throw new Error("should not reach here");
  } catch (err: unknown) {
    // Should be the standard abort reason (DOMException with name "AbortError")
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
  }

  expect(callCount).toBe(1);
  expect(results).toHaveLength(1);
});

test("pollingMonitor: abort reason is propagated", async () => {
  const reason = new Error("custom cancellation");
  const ac = new AbortController();
  ac.abort(reason);

  const getStatus = () =>
    Promise.resolve({ type: "Unknown", at: Date.now() } as ExecutionStatus);

  await expect(
    collect(pollingMonitor(getStatus, { signal: ac.signal }))
  ).rejects.toThrow("custom cancellation");
});

test("pollingMonitor: works normally without signal", async () => {
  let callCount = 0;
  const statuses: ExecutionStatus["type"][] = [
    "Unknown",
    "Initiated",
    "FinalizedOnSource",
    "Proven",
    "Executable",
    "Executed",
  ];

  const getStatus = (): Promise<ExecutionStatus> => {
    const type = statuses[callCount++] ?? "Executed";
    return Promise.resolve({ type, at: Date.now() } as ExecutionStatus);
  };

  const results = await collect(
    pollingMonitor(getStatus, { pollIntervalMs: 1 })
  );

  expect(results.map((r) => r.type)).toEqual([
    "Unknown",
    "Initiated",
    "FinalizedOnSource",
    "Proven",
    "Executable",
    "Executed",
  ]);
});
