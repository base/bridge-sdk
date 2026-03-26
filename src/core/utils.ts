import type { ChainId, DestinationCall, EvmCall, SolanaCall } from "./types";

/**
 * Type guard for SolanaCall destination.
 */
export function isSolanaDestinationCall(
  call: DestinationCall,
): call is { kind: "solana"; call: SolanaCall } {
  return call.kind === "solana";
}

/**
 * Type guard for EVM destination call.
 */
export function isEvmDestinationCall(
  call: DestinationCall,
): call is { kind: "evm"; call: EvmCall } {
  return call.kind === "evm";
}

/**
 * Check if a chain ID represents a Solana chain.
 */
export function isSolanaChainId(chainId: ChainId): boolean {
  return chainId.startsWith("solana:");
}
