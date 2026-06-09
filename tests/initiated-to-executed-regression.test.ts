import { expect, test } from "bun:test";
import { isAllowedTransition } from "../src/core/capabilities";
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

// When the prove and execute Solana transactions both confirm within a single
// poll interval, status() returns "Initiated" on one poll (IncomingMessage PDA
// not yet present) and "Executed" on the next (PDA present, executed=true),
// skipping "Executable" entirely. This is a legitimate, successful bridge.
test("Initiated -> Executed is an allowed transition (prove+execute between polls)", () => {
  expect(isAllowedTransition("Initiated", "Executed")).toBe(true);
});

test("pollingMonitor yields Executed instead of throwing when Executable is skipped", async () => {
  let callCount = 0;
  const statuses: ExecutionStatus["type"][] = [
    "Initiated",
    "Executed",
  ];

  const getStatus = (): Promise<ExecutionStatus> => {
    const type = statuses[callCount++] ?? "Executed";
    return Promise.resolve({ type, at: Date.now() } as ExecutionStatus);
  };

  const results = await collect(
    pollingMonitor(getStatus, { pollIntervalMs: 1 }),
  );

  expect(results.map((r) => r.type)).toEqual(["Initiated", "Executed"]);
});
