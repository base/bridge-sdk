import { type BridgeConfig } from "@/types";
import { address } from "@solana/kit";

export const DEFAULT_CONFIG: BridgeConfig = {
  solRpcUrl: "",
  payerKp: "",
  bridgeProgram: address(""),
  relayerProgram: address(""),
};
