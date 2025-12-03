import {
  BASE_BRIDGE_CONTRACT_ADDRESS,
  BASE_MAINNET_RPC,
  SOLANA_BRIDGE_PROGRAM_ID,
  SOLANA_MAINNET_RPC,
  SOLANA_RELAYER_PROGRAM_ID,
} from "@/constants";
import { type BridgeConfig } from "@/types";
import { address } from "@solana/kit";
import { base } from "viem/chains";

export const DEFAULT_CONFIG: BridgeConfig = {
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
