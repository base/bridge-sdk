import type { Address } from "@solana/kit";

export interface BridgeConfig {
  solRpcUrl: string;
  payerKp: string;
  bridgeProgram: Address;
  relayerProgram: Address;
}

export interface BridgeExecutionParams {
  quoteId: string;
  userAddress: string;
  dryRun?: boolean;
}

export interface BridgeExecutionResult {
  requestId: string;
  status: "submitted" | "confirmed" | "failed";
  txHash?: string;
  error?: string;
}
