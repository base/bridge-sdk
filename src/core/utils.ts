import type {
  BridgeRoute,
  ChainId,
  DestinationCall,
  EvmCall,
  SolanaCall,
} from "./types";

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

/**
 * Validate that a DestinationCall matches the route's destination chain.
 *
 * @throws Error if call type doesn't match destination chain
 */
export function validateDestinationCall(
  call: DestinationCall,
  route: BridgeRoute,
): void {
  const isSvmDestination = isSolanaChainId(route.destinationChain);

  if (isSvmDestination && call.kind !== "solana") {
    throw new Error(
      `Call type mismatch: route destination is Solana but call kind is "${call.kind}". ` +
        `Use { kind: "solana", call: SolanaCall } for Base -> SVM routes.`,
    );
  }
  if (!isSvmDestination && call.kind !== "evm") {
    throw new Error(
      `Call type mismatch: route destination is EVM but call kind is "${call.kind}". ` +
        `Use { kind: "evm", call: EvmCall } for SVM -> Base routes.`,
    );
  }
}
