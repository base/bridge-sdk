import { encodeAbiParameters, keccak256, type Hex } from "viem";
import type { fetchOutgoingMessage } from "../../clients/ts/src/bridge";
import {
  bytes32FromSolanaPubkey,
  encodeOutgoingMessagePayload,
  outgoingMessagePubkeyBytes32,
} from "./encoding";

export interface BaseMarketsEvmIncomingMessage {
  outgoingMessagePubkey: Hex;
  gasLimit: bigint;
  nonce: bigint;
  sender: Hex;
  ty: number;
  data: Hex;
}

/**
 * Pure derivation helper for Solana->EVM message identity + payload.
 */
export function buildEvmIncomingMessage(
  outgoing: Awaited<ReturnType<typeof fetchOutgoingMessage>>,
  args: { gasLimit: bigint }
): {
  innerHash: Hex;
  outerHash: Hex;
  evmMessage: BaseMarketsEvmIncomingMessage;
} {
  const nonce = BigInt(outgoing.data.nonce);
  const sender = bytes32FromSolanaPubkey(outgoing.data.sender);
  const { ty, data } = encodeOutgoingMessagePayload(outgoing.data.message);
  const outgoingMessagePubkey = outgoingMessagePubkeyBytes32(outgoing);

  const innerHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes" }],
      [sender, ty, data]
    )
  );

  const outerHash = keccak256(
    encodeAbiParameters(
      [{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
      [nonce, outgoingMessagePubkey, innerHash]
    )
  );

  return {
    innerHash,
    outerHash,
    evmMessage: {
      outgoingMessagePubkey,
      gasLimit: args.gasLimit,
      nonce,
      sender,
      ty,
      data,
    },
  };
}
