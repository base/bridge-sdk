import type { ExecutionStatus } from "./types";

export function isTerminalStatus(s: ExecutionStatus): boolean {
  return s.type === "Executed" || s.type === "Failed" || s.type === "Expired";
}

export function isAllowedTransition(
  from: ExecutionStatus["type"],
  to: ExecutionStatus["type"],
): boolean {
  if (from === to) return true;
  if (to === "Failed" || to === "Expired") return true;

  switch (from) {
    case "Unknown":
      return to === "Initiated";
    case "Initiated":
      // Prove and execute can both land within a single poll interval, so the
      // monitor may observe Initiated then Executing/Executed without ever
      // seeing Executable. Allow those forward skips.
      return to === "Executable" || to === "Executing" || to === "Executed";
    case "Executable":
      return to === "Executing" || to === "Executed";
    case "Executing":
      return to === "Executed";
    case "Executed":
      return false;
    case "Failed":
      return false;
    case "Expired":
      return false;
    default: {
      const _exhaustive: never = from;
      return _exhaustive;
    }
  }
}
