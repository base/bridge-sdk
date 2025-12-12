import type {
  Call,
  fetchOutgoingMessage,
  OutgoingMessage,
} from "@/clients/ts/src/bridge";
import { BRIDGE_ABI } from "@/interfaces/abis/bridge.abi";
import { MessageType, type BridgeConfig, type CallParams } from "@/types";
import {
  getBase58Codec,
  getBase58Encoder,
  type Account,
  type Address,
} from "@solana/kit";
import { sleep } from "@/utils/time";
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  padHex,
  toHex,
  type Hex,
  type PublicClient,
} from "viem";
import {
  DEFAULT_EVM_GAS_LIMIT,
  DEFAULT_MONITOR_POLL_INTERVAL_MS,
  DEFAULT_MONITOR_TIMEOUT_MS,
} from "@/constants";
import { type Logger, NOOP_LOGGER } from "@/utils/logger";

export interface BaseEngineOpts {
  config: BridgeConfig;
  logger?: Logger;
}

export class BaseEngine {
  private readonly config: BridgeConfig;
  private readonly logger: Logger;
  private readonly publicClient: PublicClient;

  constructor(opts: BaseEngineOpts) {
    this.config = opts.config;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.publicClient = createPublicClient({
      chain: this.config.base.chain,
      transport: http(),
    }) as PublicClient;
  }

  async estimateGasForCall(call: CallParams): Promise<bigint> {
    return await this.publicClient.estimateGas({
      account: this.config.base.bridgeContract,
      to: call.to,
      data: call.data,
      value: call.value,
    });
  }

  async monitorMessageExecution(
    outgoingMessageAccount: Account<OutgoingMessage, string>,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_MONITOR_TIMEOUT_MS;
    const pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS;
    const startTime = Date.now();

    this.logger.info("Monitoring message execution...");

    const { innerHash, outerHash } = this.buildEvmMessage(
      outgoingMessageAccount
    );
    this.logger.debug(`Computed inner hash: ${innerHash}`);
    this.logger.debug(`Computed outer hash: ${outerHash}`);

    while (Date.now() - startTime <= timeoutMs) {
      this.logger.debug(
        `Waiting for automatic relay of message ${outerHash}...`
      );

      const isSuccessful = await this.publicClient.readContract({
        address: this.config.base.bridgeContract,
        abi: BRIDGE_ABI,
        functionName: "successes",
        args: [outerHash],
      });

      if (isSuccessful) {
        this.logger.info("Message relayed successfully.");
        return;
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(`Monitor message execution timed out after ${timeoutMs}ms`);
  }

  private buildEvmMessage(
    outgoing: Awaited<ReturnType<typeof fetchOutgoingMessage>>
  ) {
    const nonce = BigInt(outgoing.data.nonce);
    const senderBytes32 = this.bytes32FromPubkey(outgoing.data.sender);
    const { ty, data } = this.buildIncomingPayload(outgoing);

    const innerHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes" }],
        [senderBytes32, ty, data]
      )
    );

    const pubkey = getBase58Codec().encode(outgoing.address);

    const outerHash = keccak256(
      encodeAbiParameters(
        [{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
        [nonce, `0x${pubkey.toHex()}`, innerHash]
      )
    );

    const evmMessage = {
      outgoingMessagePubkey: this.bytes32FromPubkey(outgoing.address),
      gasLimit: DEFAULT_EVM_GAS_LIMIT,
      nonce,
      sender: senderBytes32,
      ty,
      data,
    };

    return { innerHash, outerHash, evmMessage };
  }

  private bytes32FromPubkey(pubkey: Address): Hex {
    const bytes = getBase58Encoder().encode(pubkey);

    // toHex requires a mutable Uint8Array
    let hex = toHex(new Uint8Array(bytes));
    if (hex.length !== 66) {
      // left pad to 32 bytes if needed
      hex = padHex(hex, { size: 32 });
    }

    return hex;
  }

  private buildIncomingPayload(
    outgoing: Awaited<ReturnType<typeof fetchOutgoingMessage>>
  ) {
    const msg = outgoing.data.message;

    // Call
    if (msg.__kind === "Call") {
      const call = msg.fields[0];
      const ty = MessageType.Call;
      const data = this.encodeCallData(call);
      return { ty, data };
    }

    // Transfer (with optional call)
    if (msg.__kind === "Transfer") {
      const transfer = msg.fields[0];

      const transferTuple = {
        localToken: toHex(new Uint8Array(transfer.remoteToken)),
        remoteToken: this.bytes32FromPubkey(transfer.localToken),
        to: padHex(toHex(new Uint8Array(transfer.to)), {
          size: 32,
          // Bytes32 `to` expects the EVM address in the first 20 bytes.
          // Right-pad zeros so casting `bytes20(to)` yields the intended address.
          dir: "right",
        }),
        remoteAmount: BigInt(transfer.amount),
      } as const;

      const encodedTransfer = encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { name: "localToken", type: "address" },
              { name: "remoteToken", type: "bytes32" },
              { name: "to", type: "bytes32" },
              { name: "remoteAmount", type: "uint64" },
            ],
          },
        ],
        [transferTuple]
      );

      if (transfer.call.__option === "None") {
        const ty = MessageType.Transfer;
        return { ty, data: encodedTransfer, transferTuple };
      }

      const ty = MessageType.TransferAndCall;
      const call = transfer.call.value;
      const callTuple = this.callTupleObject(call);
      const data = encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { name: "localToken", type: "address" },
              { name: "remoteToken", type: "bytes32" },
              { name: "to", type: "bytes32" },
              { name: "remoteAmount", type: "uint64" },
            ],
          },
          {
            type: "tuple",
            components: [
              { name: "ty", type: "uint8" },
              { name: "to", type: "address" },
              { name: "value", type: "uint128" },
              { name: "data", type: "bytes" },
            ],
          },
        ],
        [transferTuple, callTuple]
      );

      return { ty, data, transferTuple, callTuple };
    }

    throw new Error("Unsupported outgoing message type");
  }

  private encodeCallData(call: Call): Hex {
    const evmTo = toHex(new Uint8Array(call.to));

    const encoded = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "ty", type: "uint8" },
            { name: "to", type: "address" },
            { name: "value", type: "uint128" },
            { name: "data", type: "bytes" },
          ],
        },
      ],
      [
        {
          ty: Number(call.ty),
          to: evmTo,
          value: BigInt(call.value),
          data: toHex(new Uint8Array(call.data)),
        },
      ]
    );
    return encoded;
  }

  private callTupleObject(call: Call) {
    const evmTo = toHex(new Uint8Array(call.to));

    return {
      ty: Number(call.ty),
      to: evmTo,
      value: BigInt(call.value),
      data: toHex(new Uint8Array(call.data)),
    };
  }
}
