import type {
  BridgeBaseToSolanaStateIncomingMessageMessage,
  BridgeBaseToSolanaStateIncomingMessageTransfer,
  CallType,
} from "../../../clients/ts/src/bridge";
import type { Address, createSolanaRpc, KeyPairSigner } from "@solana/kit";
import type { Chain, Address as EvmAddress, Hex } from "viem";

export interface BaseConfig {
  rpcUrl: string;
  bridgeContract: EvmAddress;
  chain: Chain;
  privateKey?: Hex;
}

export interface CallParams {
  to: EvmAddress;
  value: bigint;
  data: Hex;
  ty?: CallType;
}

export interface SolanaConfig {
  rpcUrl: string;
  /** Pre-loaded KeyPairSigner for transaction signing */
  payer: KeyPairSigner;
  bridgeProgram: Address;
  relayerProgram: Address;
}

export interface EngineConfig {
  solana: SolanaConfig;
  base: BaseConfig;
}

export const MessageType = {
  Call: 0,
  Transfer: 1,
  TransferAndCall: 2,
} as const;

export type MessageCall = Extract<
  BridgeBaseToSolanaStateIncomingMessageMessage,
  { __kind: "Call" }
>;

export type MessageTransfer = Extract<
  BridgeBaseToSolanaStateIncomingMessageMessage,
  { __kind: "Transfer" }
>;

export type Rpc = ReturnType<typeof createSolanaRpc>;

export type MessageTransferSol = Extract<
  BridgeBaseToSolanaStateIncomingMessageTransfer,
  { __kind: "Sol" }
>;

export type MessageTransferSpl = Extract<
  BridgeBaseToSolanaStateIncomingMessageTransfer,
  { __kind: "Spl" }
>;

export type MessageTransferWrappedToken = Extract<
  BridgeBaseToSolanaStateIncomingMessageTransfer,
  { __kind: "WrappedToken" }
>;
