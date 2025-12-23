import type { ExecutionStatus, RouteCapabilities, RouteStep } from "./types";

export function makeCapabilities(args: {
  steps: RouteStep[];
  autoRelay?: boolean;
  manualExecute?: boolean;
  prove?: boolean;
  constraints?: RouteCapabilities["constraints"];
}): RouteCapabilities {
  return {
    steps: args.steps,
    autoRelay: args.autoRelay,
    manualExecute: args.manualExecute,
    prove: args.prove,
    constraints: args.constraints,
  };
}

export function isTerminalStatus(s: ExecutionStatus): boolean {
  return s.type === "Executed" || s.type === "Failed" || s.type === "Expired";
}

export function isAllowedTransition(
  from: ExecutionStatus["type"],
  to: ExecutionStatus["type"]
): boolean {
  if (from === to) return true;
  if (to === "Failed" || to === "Expired") return true;

  switch (from) {
    case "Unknown":
      return to === "Initiated";
    case "Initiated":
      return to === "FinalizedOnSource" || to === "Executable";
    case "FinalizedOnSource":
      return to === "Proven" || to === "Executable";
    case "Proven":
      return to === "Executable";
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
