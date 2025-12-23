import { address as solAddress, type Address as SolAddress } from "@solana/kit";
import type { Hex } from "viem";
import type { BridgeConfig } from "./router";
import type { ChainId } from "../types";

/**
 * Built-in bridge deployments bundled with the SDK.
 *
 * These defaults intentionally only cover networks we can confidently hardcode.
 * If you need additional networks (e.g. devnet, sepolia), pass `deployments`
 * overrides via `createBridgeClient({ bridgeConfig: { deployments: ... } })`.
 */
export const DEFAULT_BRIDGE_DEPLOYMENTS: BridgeConfig["deployments"] = {
  solana: {
    // Solana mainnet programs
    "solana:mainnet": {
      bridgeProgram: solAddress("HNCne2FkVaNghhjKXapxJzPaBvAKDG1Ge3gqhZyfVWLM"),
      relayerProgram: solAddress("g1et5VenhfJHJwsdJsDbxWZuotD5H4iELNG61kS4fb9"),
    },
  },
  base: {
    // Base mainnet bridge contract
    "eip155:8453": {
      bridgeContract: "0x3eff766C76a1be2Ce1aCF2B69c78bCae257D5188",
    },
  },
};

type Deployments = BridgeConfig["deployments"];

function mergeSolanaDeployments(
  base: Record<
    ChainId,
    { bridgeProgram: SolAddress; relayerProgram: SolAddress }
  >,
  override?:
    | Record<
        ChainId,
        Partial<{ bridgeProgram: SolAddress; relayerProgram: SolAddress }>
      >
    | undefined
): Record<ChainId, { bridgeProgram: SolAddress; relayerProgram: SolAddress }> {
  if (!override) return base;
  const out: Record<
    ChainId,
    { bridgeProgram: SolAddress; relayerProgram: SolAddress }
  > = { ...base };
  for (const [chainId, dep] of Object.entries(override)) {
    const existing = out[chainId];
    if (existing) {
      out[chainId] = {
        bridgeProgram: dep.bridgeProgram ?? existing.bridgeProgram,
        relayerProgram: dep.relayerProgram ?? existing.relayerProgram,
      };
    } else if (dep.bridgeProgram && dep.relayerProgram) {
      out[chainId] = {
        bridgeProgram: dep.bridgeProgram,
        relayerProgram: dep.relayerProgram,
      };
    }
  }
  return out;
}

function mergeEvmDeployments(
  base: Record<ChainId, { bridgeContract: Hex }>,
  override?: Record<ChainId, Partial<{ bridgeContract: Hex }>> | undefined
): Record<ChainId, { bridgeContract: Hex }> {
  if (!override) return base;
  const out: Record<ChainId, { bridgeContract: Hex }> = { ...base };
  for (const [chainId, dep] of Object.entries(override)) {
    const existing = out[chainId];
    if (existing) {
      out[chainId] = {
        bridgeContract: dep.bridgeContract ?? existing.bridgeContract,
      };
    } else if (dep.bridgeContract) {
      out[chainId] = { bridgeContract: dep.bridgeContract };
    }
  }
  return out;
}

export function mergeBridgeDeployments(
  overrides?: Partial<Deployments>
): Deployments {
  return {
    solana: mergeSolanaDeployments(
      DEFAULT_BRIDGE_DEPLOYMENTS.solana,
      overrides?.solana as any
    ),
    base: mergeEvmDeployments(
      DEFAULT_BRIDGE_DEPLOYMENTS.base,
      overrides?.base as any
    ),
  };
}
