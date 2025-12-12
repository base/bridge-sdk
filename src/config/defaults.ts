import {
  BASE_BRIDGE_CONTRACT_ADDRESS,
  BASE_MAINNET_RPC,
  SOLANA_BRIDGE_PROGRAM_ID,
  SOLANA_MAINNET_RPC,
  SOLANA_RELAYER_PROGRAM_ID,
} from "@/constants";
import { type BridgeConfig, type BridgeConfigOverrides } from "@/types";
import { address } from "@solana/kit";
import { base } from "viem/chains";

const DEFAULT_CONFIG: BridgeConfig = {
  solana: {
    rpcUrl: SOLANA_MAINNET_RPC,
    payerKp: "~/.config/solana/id.json",
    bridgeProgram: address(SOLANA_BRIDGE_PROGRAM_ID),
    relayerProgram: address(SOLANA_RELAYER_PROGRAM_ID),
  },
  base: {
    rpcUrl: BASE_MAINNET_RPC,
    bridgeContract: BASE_BRIDGE_CONTRACT_ADDRESS,
    chain: base,
  },
};

function isObject(item: unknown): item is Record<string, unknown> {
  return Boolean(item && typeof item === "object" && !Array.isArray(item));
}

function deepMerge<T extends object>(target: T, source: unknown): T {
  if (!isObject(source)) {
    return target;
  }

  const output = { ...target };

  Object.keys(source).forEach((key) => {
    const sourceValue = source[key];
    const targetValue = (output as Record<string, unknown>)[key];

    if (isObject(sourceValue) && isObject(targetValue)) {
      (output as Record<string, unknown>)[key] = deepMerge(
        targetValue,
        sourceValue
      );
    } else if (sourceValue !== undefined) {
      (output as Record<string, unknown>)[key] = sourceValue;
    }
  });

  return output;
}

export const mergeConfig = (
  overrides?: BridgeConfigOverrides
): BridgeConfig => {
  if (!overrides) return DEFAULT_CONFIG;
  return deepMerge(DEFAULT_CONFIG, overrides);
};
