import { isAllowedTransition, isTerminalStatus } from "../capabilities";
import { BridgeInvariantViolationError, BridgeTimeoutError } from "../errors";
import type { ExecutionStatus, MonitorOptions } from "../types";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function stableStatusKey(s: ExecutionStatus): string {
  switch (s.type) {
    case "Unknown":
      return "Unknown";
    case "Initiated":
      return `Initiated:${s.sourceTx ?? ""}`;
    case "FinalizedOnSource":
      return `FinalizedOnSource:${s.sourceFinality ?? ""}`;
    case "Proven":
      return `Proven:${s.proofTx ?? ""}`;
    case "Executable":
      return "Executable";
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
  getStatus: () => Promise<ExecutionStatus>,
  opts: MonitorOptions = {}
): AsyncIterable<ExecutionStatus> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;

  const start = Date.now();

  let prev: ExecutionStatus | undefined;
  let prevKey: string | undefined;

  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new BridgeTimeoutError(`monitor timed out after ${timeoutMs}ms`, {
        stage: "monitor",
      });
    }

    const next = await getStatus();

    if (prev && !isAllowedTransition(prev.type, next.type)) {
      throw new BridgeInvariantViolationError(
        `Illegal status transition: ${prev.type} -> ${next.type}`,
        { stage: "monitor" }
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

    await sleep(pollIntervalMs);
  }
}
