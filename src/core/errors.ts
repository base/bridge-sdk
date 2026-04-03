import type { BridgeContext, BridgeRoute, ChainId, RouteStep } from "./types";

/**
 * Wrap an async call so errors always carry route/chain/stage context.
 * Preserves BridgeError subclass identity by patching missing fields
 * onto the original instance rather than re-wrapping.
 */
export async function wrapEngineError<T>(
  fn: () => Promise<T>,
  context: BridgeContext & { stage: RouteStep },
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BridgeError) {
      if (e.route && e.chain) throw e;
      // Patch missing context onto the original instance so that subclass
      // identity (instanceof) and the `name` property are preserved.
      // TypeScript `readonly` is compile-time only; plain assignment works.
      if (!e.route) {
        (e as { route: BridgeRoute }).route = context.route;
      }
      if (!e.chain) {
        (e as { chain: ChainId }).chain = context.chain;
      }
      throw e;
    }
    throw new BridgeError({
      message: e instanceof Error ? e.message : String(e),
      code: "RPC_ERROR",
      outcome: "retry",
      stage: context.stage,
      route: context.route,
      chain: context.chain,
      cause: e,
    });
  }
}

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
  readonly stage: RouteStep;
  readonly route?: BridgeRoute;
  readonly chain?: ChainId;

  constructor(args: {
    message: string;
    code: BridgeErrorCode;
    outcome: ActionableOutcome;
    stage: RouteStep;
    route?: BridgeRoute;
    chain?: ChainId;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = this.constructor.name;
    this.code = args.code;
    this.outcome = args.outcome;
    this.stage = args.stage;
    this.route = args.route;
    this.chain = args.chain;
  }
}

export type BridgeErrorCode =
  | "UNSUPPORTED_ROUTE"
  | "UNSUPPORTED_ACTION"
  | "UNSUPPORTED_STEP"
  | "CALL_TYPE_MISMATCH"
  | "CONFIG_ERROR"
  | "RPC_ERROR"
  | "TIMEOUT"
  | "TRANSACTION_DROPPED"
  | "NOT_FINAL"
  | "PROOF_NOT_AVAILABLE"
  | "ALREADY_PROVEN"
  | "NOT_PROVEN"
  | "ALREADY_EXECUTED"
  | "EXECUTION_REVERTED"
  | "MESSAGE_FAILED"
  | "INVARIANT_VIOLATION"
  | "VALIDATION";

export type ActionableOutcome = "retry" | "user_fix" | "fatal";

export class BridgeUnsupportedRouteError extends BridgeError {
  constructor(route: BridgeRoute, cause?: unknown) {
    super({
      message: `Unsupported route: ${route.sourceChain} -> ${route.destinationChain}`,
      code: "UNSUPPORTED_ROUTE",
      outcome: "user_fix",
      stage: "initiate",
      route,
      cause,
    });
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
      stage: args.step,
      route: args.route,
      cause: args.cause,
    });
  }
}

export class BridgeTimeoutError extends BridgeError {
  constructor(
    message: string,
    args: {
      stage: RouteStep;
      route?: BridgeRoute;
      chain?: ChainId;
      cause?: unknown;
    },
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
  }
}

export class BridgeProofNotAvailableError extends BridgeError {
  constructor(
    message: string,
    args: { route?: BridgeRoute; chain?: ChainId; cause?: unknown },
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
  }
}

export class BridgeNotProvenError extends BridgeError {
  constructor(
    message: string,
    args: { route?: BridgeRoute; chain?: ChainId; cause?: unknown },
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
  }
}

export class BridgeExecutionRevertedError extends BridgeError {
  constructor(
    message: string,
    args: {
      stage: RouteStep;
      route?: BridgeRoute;
      chain?: ChainId;
      cause?: unknown;
    },
  ) {
    super({
      message,
      code: "EXECUTION_REVERTED",
      outcome: "fatal",
      stage: args.stage,
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
  }
}

export class BridgeMessageFailedError extends BridgeError {
  constructor(
    message: string,
    args: { route?: BridgeRoute; chain?: ChainId; cause?: unknown },
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
  }
}

export class BridgeAlreadyExecutedError extends BridgeError {
  constructor(
    message: string,
    args: { route?: BridgeRoute; chain?: ChainId; cause?: unknown },
  ) {
    super({
      message,
      code: "ALREADY_EXECUTED",
      outcome: "fatal",
      stage: "execute",
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
  }
}

export class BridgeInvariantViolationError extends BridgeError {
  constructor(
    message: string,
    args?: {
      stage?: RouteStep;
      route?: BridgeRoute;
      chain?: ChainId;
      cause?: unknown;
    },
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
  }
}

export class BridgeValidationError extends BridgeError {
  constructor(
    message: string,
    args?: {
      stage?: RouteStep;
      route?: BridgeRoute;
      cause?: unknown;
    },
  ) {
    super({
      message,
      code: "VALIDATION",
      outcome: "user_fix",
      stage: args?.stage ?? "initiate",
      route: args?.route,
      cause: args?.cause,
    });
  }
}

export class BridgeTransactionDroppedError extends BridgeError {
  constructor(
    message: string,
    args: {
      stage: RouteStep;
      route?: BridgeRoute;
      chain?: ChainId;
      cause?: unknown;
    },
  ) {
    super({
      message,
      code: "TRANSACTION_DROPPED",
      outcome: "retry",
      stage: args.stage,
      route: args.route,
      chain: args.chain,
      cause: args.cause,
    });
  }
}
