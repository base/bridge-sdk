import { expect, test } from "bun:test";
import { pollingMonitor } from "../src/core/monitor/polling";
import type { ExecutionStatus } from "../src/core/types";

async function collect(
  iter: AsyncIterable<ExecutionStatus>,
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
    collect(pollingMonitor(getStatus, { signal: ac.signal })),
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
    collect(pollingMonitor(getStatus, { signal: ac.signal })),
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
    pollingMonitor(getStatus, { pollIntervalMs: 1 }),
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

test("pollingMonitor: abort during slow getStatus rejects promptly", async () => {
  const ac = new AbortController();

  const getStatus = (): Promise<ExecutionStatus> =>
    new Promise((resolve) => {
      // Simulate a 30-second RPC call
      setTimeout(() => resolve({ type: "Unknown", at: Date.now() }), 30_000);
    });

  const start = Date.now();
  setTimeout(() => ac.abort(), 50);

  await expect(
    collect(
      pollingMonitor(getStatus, { signal: ac.signal, pollIntervalMs: 1 }),
    ),
  ).rejects.toThrow();

  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(1000);
});

test("pollingMonitor: timeout fires with signal present", async () => {
  const ac = new AbortController();

  const getStatus = (): Promise<ExecutionStatus> =>
    Promise.resolve({ type: "Unknown", at: Date.now() });

  await expect(
    collect(
      pollingMonitor(getStatus, {
        signal: ac.signal,
        timeoutMs: 100,
        pollIntervalMs: 10,
      }),
    ),
  ).rejects.toThrow("monitor timed out");
});

test("pollingMonitor: signal present but never aborted runs to completion", async () => {
  const ac = new AbortController();
  let callCount = 0;
  const statuses: ExecutionStatus["type"][] = [
    "Unknown",
    "Initiated",
    "Executable",
    "Executed",
  ];

  const getStatus = (): Promise<ExecutionStatus> => {
    const type = statuses[callCount++] ?? "Executed";
    return Promise.resolve({ type, at: Date.now() } as ExecutionStatus);
  };

  const results = await collect(
    pollingMonitor(getStatus, { signal: ac.signal, pollIntervalMs: 1 }),
  );

  expect(results.map((r) => r.type)).toEqual([
    "Unknown",
    "Initiated",
    "Executable",
    "Executed",
  ]);
});

test("pollingMonitor: abort after multiple yields collects partial results", async () => {
  const ac = new AbortController();
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
    const type = statuses[callCount++] ?? "Executable";
    return Promise.resolve({ type, at: Date.now() } as ExecutionStatus);
  };

  const results: ExecutionStatus[] = [];
  try {
    for await (const s of pollingMonitor(getStatus, {
      signal: ac.signal,
      pollIntervalMs: 1,
    })) {
      results.push(s);
      if (results.length === 3) {
        ac.abort();
      }
    }
    throw new Error("should not reach here");
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(DOMException);
  }

  expect(results.map((r) => r.type)).toEqual([
    "Unknown",
    "Initiated",
    "FinalizedOnSource",
  ]);
});

test("pollingMonitor: sleep cleanup — abort after completion causes no unhandled rejection", async () => {
  const ac = new AbortController();
  let callCount = 0;
  const statuses: ExecutionStatus["type"][] = [
    "Unknown",
    "Initiated",
    "Executable",
    "Executed",
  ];

  const getStatus = (): Promise<ExecutionStatus> => {
    const type = statuses[callCount++] ?? "Executed";
    return Promise.resolve({ type, at: Date.now() } as ExecutionStatus);
  };

  const results = await collect(
    pollingMonitor(getStatus, { signal: ac.signal, pollIntervalMs: 1 }),
  );

  expect(results.map((r) => r.type)).toEqual([
    "Unknown",
    "Initiated",
    "Executable",
    "Executed",
  ]);

  // Abort after completion — should NOT cause an unhandled rejection
  ac.abort();

  // Give the event loop a tick to surface any unhandled rejection
  await new Promise((r) => setTimeout(r, 50));
});

test("pollingMonitor: getStatus receives the signal argument", async () => {
  const ac = new AbortController();
  let receivedSignal: AbortSignal | undefined;

  const getStatus = (signal?: AbortSignal): Promise<ExecutionStatus> => {
    receivedSignal = signal;
    return Promise.resolve({ type: "Executed", at: Date.now() });
  };

  await collect(
    pollingMonitor(getStatus, { signal: ac.signal, pollIntervalMs: 1 }),
  );

  expect(receivedSignal).toBe(ac.signal);
});
