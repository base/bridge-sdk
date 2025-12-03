import type { Address } from "@solana/kit";
import type { Chain, Address as EvmAddress } from "viem";

export interface BaseConfig {
  rpcUrl: string;
  bridgeContract: EvmAddress;
  chain: Chain;
}

export interface SolanaConfig {
  rpcUrl: string;
  payerKp: string;
  bridgeProgram: Address;
  relayerProgram: Address;
}

export interface BridgeConfig {
  solana: SolanaConfig;
  base: BaseConfig;
}

export interface BridgeConfigOverrides {
  solana?: Partial<SolanaConfig>;
  base?: Partial<BaseConfig>;
}

export const MessageType = {
  Call: 0,
  Transfer: 1,
  TransferAndCall: 2,
} as const;
