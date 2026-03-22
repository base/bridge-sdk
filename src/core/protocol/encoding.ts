import { getBase58Encoder, type Address as SolAddress } from "@solana/kit";
import { encodeAbiParameters, type Hex, keccak256, padHex, toHex } from "viem";
import type {
  BridgeSolanaToBaseStateOutgoingMessageMessage,
  Call,
  fetchOutgoingMessage,
} from "../../clients/ts/src/bridge";

/** Bridge-level message type discriminant (Call=0, Transfer=1, TransferAndCall=2). */
type MessageTypeValue = 0 | 1 | 2;

interface EvmIncomingMessage {
  outgoingMessagePubkey: Hex;
  gasLimit: bigint;
  nonce: bigint;
  sender: Hex;
  ty: MessageTypeValue;
  data: Hex;
}

export const MESSAGE_TYPE = {
  Call: 0,
  Transfer: 1,
  TransferAndCall: 2,
} as const satisfies Record<string, MessageTypeValue>;

const base58Encoder = getBase58Encoder();

const TRANSFER_TUPLE_ABI = {
  type: "tuple",
  components: [
    { name: "localToken", type: "address" },
    { name: "remoteToken", type: "bytes32" },
    { name: "to", type: "bytes32" },
    { name: "remoteAmount", type: "uint64" },
  ],
} as const;

const CALL_TUPLE_ABI = {
  type: "tuple",
  components: [
    { name: "ty", type: "uint8" },
    { name: "to", type: "address" },
    { name: "value", type: "uint128" },
    { name: "data", type: "bytes" },
  ],
} as const;

export function bytes32FromSolanaPubkey(pubkey: SolAddress): Hex {
  const bytes = base58Encoder.encode(pubkey);
  let hex = toHex(new Uint8Array(bytes));
  if (hex.length !== 66) hex = padHex(hex, { size: 32 });
  return hex;
}

export function encodeOutgoingMessagePayload(
  msg: BridgeSolanaToBaseStateOutgoingMessageMessage,
): { ty: MessageTypeValue; data: Hex } {
  // Call
  if (msg.__kind === "Call") {
    const call = msg.fields[0];
    return { ty: MESSAGE_TYPE.Call, data: encodeCallData(call) };
  }

  // Transfer (with optional call)
  if (msg.__kind === "Transfer") {
    const transfer = msg.fields[0];

    const transferTuple = {
      localToken: toHex(new Uint8Array(transfer.remoteToken)),
      remoteToken: bytes32FromSolanaPubkey(transfer.localToken),
      to: padHex(toHex(new Uint8Array(transfer.to)), {
        size: 32,
        // Bytes32 `to` expects the EVM address in the first 20 bytes.
        // Right-pad zeros so casting `bytes20(to)` yields the intended address.
        dir: "right",
      }),
      remoteAmount: BigInt(transfer.amount),
    } as const;

    if (transfer.call.__option === "None") {
      const data = encodeAbiParameters([TRANSFER_TUPLE_ABI], [transferTuple]);
      return { ty: MESSAGE_TYPE.Transfer, data };
    }

    const callTuple = callTupleObject(transfer.call.value);
    const data = encodeAbiParameters(
      [TRANSFER_TUPLE_ABI, CALL_TUPLE_ABI],
      [transferTuple, callTuple],
    );

    return { ty: MESSAGE_TYPE.TransferAndCall, data };
  }

  // Exhaustive guard.
  const _never: never = msg;
  return _never;
}

export function encodeCallData(call: Call): Hex {
  return encodeAbiParameters([CALL_TUPLE_ABI], [callTupleObject(call)]);
}

export function callTupleObject(call: Call) {
  const evmTo = toHex(new Uint8Array(call.to));
  return {
    ty: Number(call.ty),
    to: evmTo,
    value: BigInt(call.value),
    data: toHex(new Uint8Array(call.data)),
  } as const;
}

export function outgoingMessagePubkeyBytes32(
  outgoing: Awaited<ReturnType<typeof fetchOutgoingMessage>>,
): Hex {
  return bytes32FromSolanaPubkey(outgoing.address);
}

const INNER_HASH_ABI = [
  { type: "bytes32" },
  { type: "uint8" },
  { type: "bytes" },
] as const;

const OUTER_HASH_ABI = [
  { type: "uint64" },
  { type: "bytes32" },
  { type: "bytes32" },
] as const;

/**
 * Pure derivation helper for Solana->EVM message identity + payload.
 */
export function buildEvmIncomingMessage(
  outgoing: Awaited<ReturnType<typeof fetchOutgoingMessage>>,
  args: { gasLimit: bigint },
): {
  innerHash: Hex;
  outerHash: Hex;
  evmMessage: EvmIncomingMessage;
} {
  const nonce = outgoing.data.nonce;
  const sender = bytes32FromSolanaPubkey(outgoing.data.sender);
  const { ty, data } = encodeOutgoingMessagePayload(outgoing.data.message);
  const outgoingMessagePubkey = outgoingMessagePubkeyBytes32(outgoing);

  const innerHash = keccak256(
    encodeAbiParameters(INNER_HASH_ABI, [sender, ty, data]),
  );

  const outerHash = keccak256(
    encodeAbiParameters(OUTER_HASH_ABI, [
      nonce,
      outgoingMessagePubkey,
      innerHash,
    ]),
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
