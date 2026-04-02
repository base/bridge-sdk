import { isAddress as isSolanaAddress } from "@solana/kit";
import { isAddress as isEvmAddress, isHex, zeroAddress } from "viem";
import { BridgeValidationError } from "./errors";
import {
  type BridgeAction,
  type BridgeRoute,
  type DestinationCall,
  type EvmCall,
  EvmCallType,
} from "./types";
import {
  isEvmDestinationCall,
  isSolanaChainId,
  isSolanaDestinationCall,
} from "./utils";

const MAX_TRANSFER_AMOUNT = 2n ** 64n - 1n;

function validateUrlScheme(
  url: string,
  allowedProtocols: string[],
  label: string,
): void {
  if (url.trim() === "") {
    throw new BridgeValidationError(
      `Invalid ${label}: expected a non-empty URL, got "${truncate(String(url))}"`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BridgeValidationError(
      `Invalid ${label}: not a valid URL, got "${truncate(url)}"`,
    );
  }

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new BridgeValidationError(
      `Invalid ${label}: expected ${allowedProtocols.join(" or ")} scheme, got "${parsed.protocol}" in "${truncate(url)}"`,
    );
  }
}

export function validateRpcUrl(rpcUrl: string): void {
  validateUrlScheme(rpcUrl, ["http:", "https:"], "RPC URL");
}

export function validateWssUrl(wssUrl: string): void {
  validateUrlScheme(wssUrl, ["ws:", "wss:"], "WebSocket URL");
}

export function validateAction(action: BridgeAction, route: BridgeRoute): void {
  if (action.kind === "transfer") {
    validateAmount(action.amount);
    if (action.call) {
      validateDestinationCallFields(action.call, route);
    }
    validateRecipientAddress(action.recipient, route);
  } else {
    validateDestinationCallFields(action.call, route);
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

/** Does NOT enforce EIP-55 mixed-case checksum. */
export function validateEvmAddress(address: string): void {
  if (!isEvmAddress(address, { strict: false })) {
    throw new BridgeValidationError(
      `Invalid EVM address: expected 0x-prefixed 42-character hex string, got "${truncate(address)}"`,
    );
  }
}

export function validateSolanaAddress(address: string): void {
  if (!isSolanaAddress(address)) {
    throw new BridgeValidationError(
      `Invalid Solana address: expected base58-encoded 32-byte public key, got "${truncate(address)}"`,
    );
  }
}

export function validateEvmCallData(data: string): void {
  if (!isHex(data)) {
    throw new BridgeValidationError(
      `Invalid EVM call data: expected 0x-prefixed hex string, got "${truncate(data)}"`,
    );
  }
}

/** Uint8Array values are always valid; hex strings must be well-formed. */
export function validateSolanaInstructionData(
  data: Uint8Array | `0x${string}`,
): void {
  if (typeof data === "string" && !isHex(data)) {
    throw new BridgeValidationError(
      `Invalid Solana instruction data: expected Uint8Array or 0x-prefixed hex string, got "${truncate(data)}"`,
    );
  }
}

export function validateEvmCallValue(value: bigint): void {
  if (value < 0n) {
    throw new BridgeValidationError("EVM call value must not be negative");
  }
}

/**
 * Enforce cross-field constraints required by the on-chain bridge contract:
 * - `DelegateCall`: `value` must be 0.
 * - `Create` / `Create2`: `to` must be the zero address.
 */
export function validateEvmCallType(call: EvmCall): void {
  if (call.ty === undefined) {
    return;
  }

  if (call.ty < EvmCallType.Call || call.ty > EvmCallType.Create2) {
    throw new BridgeValidationError(
      `Invalid EVM call type: expected 0 (Call), 1 (DelegateCall), 2 (Create), or 3 (Create2), got ${call.ty}`,
    );
  }

  if (call.ty === EvmCallType.DelegateCall && call.value !== 0n) {
    throw new BridgeValidationError(
      "DelegateCall cannot have a non-zero value",
    );
  }

  if (
    (call.ty === EvmCallType.Create || call.ty === EvmCallType.Create2) &&
    call.to !== zeroAddress
  ) {
    throw new BridgeValidationError(
      `${EvmCallType[call.ty]} requires the \`to\` address to be the zero address`,
    );
  }
}

/**
 * Validate that a DestinationCall matches the route's destination chain.
 *
 * @throws BridgeValidationError if call type doesn't match destination chain
 */
export function validateDestinationCall(
  call: DestinationCall,
  route: BridgeRoute,
): void {
  const isSvmDestination = isSolanaChainId(route.destinationChain);

  if (isSvmDestination && !isSolanaDestinationCall(call)) {
    throw new BridgeValidationError(
      `Call type mismatch: route destination is Solana but call kind is "${call.kind}". ` +
        `Use { kind: "solana", call: SolanaCall } for Base -> SVM routes.`,
      { route },
    );
  }
  if (!isSvmDestination && !isEvmDestinationCall(call)) {
    throw new BridgeValidationError(
      `Call type mismatch: route destination is EVM but call kind is "${call.kind}". ` +
        `Use { kind: "evm", call: EvmCall } for SVM -> Base routes.`,
      { route },
    );
  }
}

export function validateDestinationCallFields(
  call: DestinationCall,
  route: BridgeRoute,
): void {
  validateDestinationCall(call, route);

  if (call.kind === "evm") {
    validateEvmAddress(call.call.to);
    validateEvmCallData(call.call.data);
    validateEvmCallValue(call.call.value);
    validateEvmCallType(call.call);
  } else {
    if (call.call.instructions.length === 0) {
      throw new BridgeValidationError(
        "Solana call must include at least one instruction",
      );
    }
    for (const ix of call.call.instructions) {
      validateSolanaAddress(ix.programId);
      for (const acct of ix.accounts) {
        validateSolanaAddress(acct.pubkey);
      }
      validateSolanaInstructionData(ix.data);
    }
  }
}

export function validateRecipientAddress(
  recipient: string,
  route: BridgeRoute,
): void {
  if (isSolanaChainId(route.destinationChain)) {
    validateSolanaAddress(recipient);
  } else {
    validateEvmAddress(recipient);
  }
}

function truncate(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
