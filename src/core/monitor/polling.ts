import { raceAbort, sleep } from "../../utils/time";
import { isAllowedTransition, isTerminalStatus } from "../capabilities";
import { BridgeInvariantViolationError, BridgeTimeoutError } from "../errors";
import type { ExecutionStatus, MonitorOptions } from "../types";

function stableStatusKey(s: ExecutionStatus): string {
  switch (s.type) {
    case "Unknown":
      return "Unknown";
    case "Initiated":
      return `Initiated:${s.sourceTx ?? ""}`;
    case "Executable":
      return `Executable:${s.proofTx ?? ""}`;
    case "Executing":
      return `Executing:${s.executionTx ?? ""}`;
    case "Executed":
      return `Executed:${s.executionTx ?? ""}`;
    case "Failed":
      return `Failed:${s.reason}:${s.executionTx ?? ""}`;
    case "Expired":
      return `Expired:${s.reason ?? ""}`;
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

/**
 * Generic polling monitor used by route adapters when they don't have a better
 * subscription/indexer implementation.
 */
export async function* pollingMonitor(
  getStatus: (signal?: AbortSignal) => Promise<ExecutionStatus>,
  opts: MonitorOptions = {},
): AsyncIterable<ExecutionStatus> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const signal = opts.signal;

  signal?.throwIfAborted();

  const start = Date.now();

  let prev: ExecutionStatus | undefined;
  let prevKey: string | undefined;

  while (true) {
    signal?.throwIfAborted();

    const next = await raceAbort(getStatus(signal), signal);

    if (prev && !isAllowedTransition(prev.type, next.type)) {
      throw new BridgeInvariantViolationError(
        `Illegal status transition: ${prev.type} -> ${next.type}`,
        { stage: "monitor" },
      );
    }

    const nextKey = stableStatusKey(next);
    if (prevKey !== nextKey) {
      yield next;
      prevKey = nextKey;
      prev = next;
    }

    if (isTerminalStatus(next)) {
      return;
    }

    if (Date.now() - start > timeoutMs) {
      throw new BridgeTimeoutError(`monitor timed out after ${timeoutMs}ms`, {
        stage: "monitor",
      });
    }

    await sleep(pollIntervalMs, signal);
  }
}
