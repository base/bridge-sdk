import type { BridgeRoute, ChainId } from "./types";

/**
 * Core error base class.
 *
 * Design notes:
 * - Typed code + outcome for UX decisions.
 * - Optional route/chain context.
 * - Optional cause passthrough.
 */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly outcome: ActionableOutcome;
  readonly stage: "initiate" | "prove" | "execute" | "monitor";
  readonly route?: BridgeRoute;
  readonly chain?: ChainId;
  override readonly cause?: unknown;

  constructor(args: {
    message: string;
    code: BridgeErrorCode;
    outcome: ActionableOutcome;
    stage: BridgeError["stage"];
    route?: BridgeRoute;
    chain?: ChainId;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause } : undefined);
    this.name = "BridgeError";
    this.code = args.code;
    this.outcome = args.outcome;
    this.stage = args.stage;
    this.route = args.route;
    this.chain = args.chain;
    this.cause = args.cause;
  }
}

export type BridgeErrorCode =
  | "UNSUPPORTED_ROUTE"
  | "UNSUPPORTED_ACTION"
  | "UNSUPPORTED_STEP"
  | "CONFIG_ERROR"
  | "RPC_ERROR"
  | "TIMEOUT"
  | "NOT_FINAL"
  | "PROOF_NOT_AVAILABLE"
  | "ALREADY_PROVEN"
  | "NOT_PROVEN"
  | "ALREADY_EXECUTED"
  | "EXECUTION_REVERTED"
  | "MESSAGE_FAILED"
  | "INVARIANT_VIOLATION";

export type ActionableOutcome = "retry" | "user_fix" | "fatal";

export class BridgeUnsupportedRouteError extends BridgeError {
  constructor(route: BridgeRoute, cause?: unknown) {
    super({
      message: `Unsupported route: ${route.sourceChain} -> ${
        route.destinationChain
      }${route.protocol ? ` (protocol=${route.protocol})` : ""}`,
      code: "UNSUPPORTED_ROUTE",
      outcome: "user_fix",
      stage: "initiate",
      route,
      cause,
    });
    this.name = "BridgeUnsupportedRouteError";
  }
}

export class BridgeUnsupportedActionError extends BridgeError {
  constructor(args: {
    route: BridgeRoute;
    actionKind: string;
    cause?: unknown;
  }) {
    super({
      message: `Unsupported action for route: ${args.actionKind}`,
      code: "UNSUPPORTED_ACTION",
      outcome: "user_fix",
      stage: "initiate",
      route: args.route,
      cause: args.cause,
    });
    this.name = "BridgeUnsupportedActionError";
  }
}

export class BridgeUnsupportedStepError extends BridgeError {
  constructor(args: {
    route: BridgeRoute;
    step: "prove" | "execute" | "monitor";
    cause?: unknown;
  }) {
    super({
      message: `Unsupported step for route: ${args.step}`,
      code: "UNSUPPORTED_STEP",
      outcome: "user_fix",
      stage:
        args.step === "prove"
          ? "prove"
          : args.step === "execute"
          ? "execute"
          : "monitor",
      route: args.route,
      cause: args.cause,
    });
    this.name = "BridgeUnsupportedStepError";
  }
}

export class BridgeConfigError extends BridgeError {
  constructor(
    message: string,
    args?: {
      stage?: BridgeError["stage"];
      route?: BridgeRoute;
      chain?: ChainId;
      cause?: unknown;
    }
  ) {
    super({
      message,
      code: "CONFIG_ERROR",
      outcome: "user_fix",
      stage: args?.stage ?? "initiate",
      route: args?.route,
      chain: args?.chain,
      cause: args?.cause,
    });
    this.name = "BridgeConfigError";
  }
}

export class BridgeRpcError extends BridgeError {
  constructor(
    message: string,
    args: {
      stage: BridgeError["stage"];
      route?: BridgeRoute;
      chain?: ChainId;
      cause?: unknown;
    }
  ) {
    super({
      message,
      code: "RPC_ERROR",
      outcome: "retry",
      stage: args.stage,
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
    this.name = "BridgeRpcError";
  }
}

export class BridgeTimeoutError extends BridgeError {
  constructor(
    message: string,
    args: {
      stage: BridgeError["stage"];
      route?: BridgeRoute;
      chain?: ChainId;
      cause?: unknown;
    }
  ) {
    super({
      message,
      code: "TIMEOUT",
      outcome: "retry",
      stage: args.stage,
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
    this.name = "BridgeTimeoutError";
  }
}

export class BridgeNotFinalError extends BridgeError {
  constructor(
    message: string,
    args: {
      stage: BridgeError["stage"];
      route?: BridgeRoute;
      chain?: ChainId;
      cause?: unknown;
    }
  ) {
    super({
      message,
      code: "NOT_FINAL",
      outcome: "retry",
      stage: args.stage,
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
    this.name = "BridgeNotFinalError";
  }
}

export class BridgeProofNotAvailableError extends BridgeError {
  constructor(
    message: string,
    args: { route?: BridgeRoute; chain?: ChainId; cause?: unknown }
  ) {
    super({
      message,
      code: "PROOF_NOT_AVAILABLE",
      outcome: "retry",
      stage: "prove",
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
    this.name = "BridgeProofNotAvailableError";
  }
}

export class BridgeAlreadyProvenError extends BridgeError {
  constructor(
    message: string,
    args: { route?: BridgeRoute; chain?: ChainId; cause?: unknown }
  ) {
    super({
      message,
      code: "ALREADY_PROVEN",
      outcome: "retry",
      stage: "prove",
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
    this.name = "BridgeAlreadyProvenError";
  }
}

export class BridgeNotProvenError extends BridgeError {
  constructor(
    message: string,
    args: { route?: BridgeRoute; chain?: ChainId; cause?: unknown }
  ) {
    super({
      message,
      code: "NOT_PROVEN",
      outcome: "user_fix",
      stage: "execute",
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
    this.name = "BridgeNotProvenError";
  }
}

export class BridgeAlreadyExecutedError extends BridgeError {
  constructor(
    message: string,
    args: { route?: BridgeRoute; chain?: ChainId; cause?: unknown }
  ) {
    super({
      message,
      code: "ALREADY_EXECUTED",
      outcome: "retry",
      stage: "execute",
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
    this.name = "BridgeAlreadyExecutedError";
  }
}

export class BridgeExecutionRevertedError extends BridgeError {
  constructor(
    message: string,
    args: { route?: BridgeRoute; chain?: ChainId; cause?: unknown }
  ) {
    super({
      message,
      code: "EXECUTION_REVERTED",
      outcome: "user_fix",
      stage: "execute",
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
    this.name = "BridgeExecutionRevertedError";
  }
}

export class BridgeMessageFailedError extends BridgeError {
  constructor(
    message: string,
    args: { route?: BridgeRoute; chain?: ChainId; cause?: unknown }
  ) {
    super({
      message,
      code: "MESSAGE_FAILED",
      outcome: "fatal",
      stage: "execute",
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
    this.name = "BridgeMessageFailedError";
  }
}

export class BridgeInvariantViolationError extends BridgeError {
  constructor(
    message: string,
    args?: {
      stage?: BridgeError["stage"];
      route?: BridgeRoute;
      chain?: ChainId;
      cause?: unknown;
    }
  ) {
    super({
      message,
      code: "INVARIANT_VIOLATION",
      outcome: "fatal",
      stage: args?.stage ?? "initiate",
      route: args?.route,
      chain: args?.chain,
      cause: args?.cause,
    });
    this.name = "BridgeInvariantViolationError";
  }
}
