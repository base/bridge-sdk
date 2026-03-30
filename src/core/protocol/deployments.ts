import { address as solAddress } from "@solana/kit";
import type { BridgeConfig, ChainId } from "../types";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
} from "./router";

/**
 * Built-in bridge deployments bundled with the SDK.
 *
 * Includes mainnet and devnet/testnet defaults so that the exported chain
 * objects (`solanaDevnet`, `baseSepolia`) work out-of-the-box. To override
 * any address, pass `deployments` overrides via
 * `createBridgeClient({ bridgeConfig: { deployments: ... } })`.
 */
export const DEFAULT_BRIDGE_DEPLOYMENTS: BridgeConfig["deployments"] = {
  solana: {
    [SOLANA_MAINNET_CHAIN_ID]: {
      bridgeProgram: solAddress("HNCne2FkVaNghhjKXapxJzPaBvAKDG1Ge3gqhZyfVWLM"),
      relayerProgram: solAddress("g1et5VenhfJHJwsdJsDbxWZuotD5H4iELNG61kS4fb9"),
    },
    [SOLANA_DEVNET_CHAIN_ID]: {
      bridgeProgram: solAddress("7c6mteAcTXaQ1MFBCrnuzoZVTTAEfZwa6wgy4bqX3KXC"),
      relayerProgram: solAddress(
        "56MBBEYAtQAdjT4e1NzHD8XaoyRSTvfgbSVVcEcHj51H",
      ),
    },
  },
  base: {
    [BASE_MAINNET_CHAIN_ID]: {
      bridgeContract: "0x3eff766C76a1be2Ce1aCF2B69c78bCae257D5188",
    },
    [BASE_SEPOLIA_CHAIN_ID]: {
      bridgeContract: "0x01824a90d32A69022DdAEcC6C5C14Ed08dB4EB9B",
    },
  },
};

type Deployments = BridgeConfig["deployments"];

function mergeRecords<T extends Record<string, unknown>>(
  base: Record<ChainId, T>,
  override?: Record<ChainId, Partial<T>>,
): Record<ChainId, T> {
  if (!override) return base;
  const out: Record<ChainId, T> = { ...base };

  // Derive the set of required keys from an existing complete record.
  const sample = Object.values(base)[0];
  if (!sample) return out;
  const requiredKeys = Object.keys(sample);

  for (const [chainId, dep] of Object.entries(override)) {
    const existing = out[chainId];
    if (existing) {
      const merged: Record<string, unknown> = { ...existing };
      for (const [key, value] of Object.entries(dep)) {
        if (value != null) merged[key] = value;
      }
      out[chainId] = merged as T;
    } else if (
      requiredKeys.every((key) => (dep as Record<string, unknown>)[key] != null)
    ) {
      out[chainId] = dep as T;
    }
  }
  return out;
}

export function mergeBridgeDeployments(
  overrides?: Partial<Deployments>,
): Deployments {
  return {
    solana: mergeRecords(DEFAULT_BRIDGE_DEPLOYMENTS.solana, overrides?.solana),
    base: mergeRecords(DEFAULT_BRIDGE_DEPLOYMENTS.base, overrides?.base),
  };
}
