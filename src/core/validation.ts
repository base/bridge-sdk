import { BridgeValidationError } from "./errors";
import type { BridgeAction } from "./types";

/** Maximum uint64 value. */
const MAX_TRANSFER_AMOUNT = 2n ** 64n - 1n;

export function validateAction(action: BridgeAction): void {
  if (action.kind === "transfer") {
    validateAmount(action.amount);
  }
}

export function validateAmount(amount: bigint): void {
  if (amount <= 0n) {
    throw new BridgeValidationError("Amount must be greater than zero");
  }
  if (amount > MAX_TRANSFER_AMOUNT) {
    throw new BridgeValidationError(
      `Amount exceeds maximum transferable amount (${MAX_TRANSFER_AMOUNT})`,
    );
  }
}
