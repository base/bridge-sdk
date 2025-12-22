import {
  getIxAccountEncoder,
  type Call,
  type Ix,
  type fetchOutgoingMessage,
  type OutgoingMessage,
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
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  keccak256,
  padHex,
  toHex,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_MONITOR_POLL_INTERVAL_MS,
  DEFAULT_MONITOR_TIMEOUT_MS,
} from "@/constants";
import { type Logger, NOOP_LOGGER } from "@/utils/logger";

export interface BaseEngineOpts {
  config: BridgeConfig;
  logger?: Logger;
}

export interface BaseBridgeCallOpts {
  ixs: Ix[];
}

export interface BaseBridgeTokenOpts {
  transfer: {
    localToken: Hex;
    remoteToken: Address;
    to: Address;
    amount: bigint;
  };
  ixs: Ix[];
}

export class BaseEngine {
  private readonly config: BridgeConfig;
  private readonly logger: Logger;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient | undefined;

  constructor(opts: BaseEngineOpts) {
    this.config = opts.config;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.publicClient = createPublicClient({
      chain: this.config.base.chain,
      transport: http(this.config.base.rpcUrl),
    }) as PublicClient;

    if (this.config.base.privateKey) {
      this.walletClient = createWalletClient({
        chain: this.config.base.chain,
        transport: http(this.config.base.rpcUrl),
      });
    }
  }

  async estimateGasForCall(call: CallParams): Promise<bigint> {
    return await this.publicClient.estimateGas({
      account: this.config.base.bridgeContract,
      to: call.to,
      data: call.data,
      value: call.value,
    });
  }

  async bridgeCall(opts: BaseBridgeCallOpts): Promise<Hash> {
    if (!this.walletClient || !this.config.base.privateKey) {
      throw new Error(
        "Base wallet client not initialized (missing privateKey)"
      );
    }

    const account = privateKeyToAccount(this.config.base.privateKey);

    const formattedIxs = this.formatIxs(opts.ixs);

    const { request } = await this.publicClient.simulateContract({
      address: this.config.base.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "bridgeCall",
      args: [formattedIxs],
      account,
      chain: this.config.base.chain,
    });

    return await this.walletClient.writeContract(request);
  }

  async bridgeToken(opts: BaseBridgeTokenOpts): Promise<Hash> {
    if (!this.walletClient || !this.config.base.privateKey) {
      throw new Error(
        "Base wallet client not initialized (missing privateKey)"
      );
    }

    const account = privateKeyToAccount(this.config.base.privateKey);

    const formattedIxs = this.formatIxs(opts.ixs);

    const transferStruct = {
      localToken: opts.transfer.localToken,
      remoteToken: this.bytes32FromPubkey(opts.transfer.remoteToken),
      to: this.bytes32FromPubkey(opts.transfer.to),
      remoteAmount: opts.transfer.amount,
    };

    const { request } = await this.publicClient.simulateContract({
      address: this.config.base.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "bridgeToken",
      args: [transferStruct, formattedIxs],
      account,
      chain: this.config.base.chain,
    });

    return await this.walletClient.writeContract(request);
  }

  async generateProof(transactionHash: Hash, blockNumber: bigint) {
    const txReceipt = await this.publicClient.getTransactionReceipt({
      hash: transactionHash,
    });

    if (txReceipt.status !== "success") {
      throw new Error(`Transaction reverted: ${transactionHash}`);
    }

    // Extract and decode MessageInitiated events
    const msgInitEvents = txReceipt.logs
      .map((log) => {
        if (blockNumber < log.blockNumber) {
          throw new Error(
            `Solana bridge state is stale (behind transaction block). Bridge state block: ${blockNumber}, Transaction block: ${log.blockNumber}`
          );
        }

        try {
          const decodedLog = decodeEventLog({
            abi: BRIDGE_ABI,
            data: log.data,
            topics: log.topics,
          });

          return decodedLog.eventName === "MessageInitiated"
            ? {
                messageHash: decodedLog.args.messageHash,
                mmrRoot: decodedLog.args.mmrRoot,
                message: decodedLog.args.message,
              }
            : null;
        } catch (error) {
          return null;
        }
      })
      .filter((event) => event !== null);

    this.logger.info(`Found ${msgInitEvents.length} MessageInitiated event(s)`);

    if (msgInitEvents.length === 0) {
      throw new Error("No MessageInitiated event found in transaction");
    }

    if (msgInitEvents.length > 1) {
      throw new Error("Multiple MessageInitiated events found (unsupported)");
    }

    const event = msgInitEvents[0]!;

    this.logger.info("Message Details:");
    this.logger.info(`  Hash: ${event.messageHash}`);
    this.logger.info(`  MMR Root: ${event.mmrRoot}`);
    this.logger.info(`  Nonce: ${event.message.nonce}`);
    this.logger.info(`  Sender: ${event.message.sender}`);
    this.logger.info(`  Data: ${event.message.data}`);

    const rawProof = await this.publicClient.readContract({
      address: this.config.base.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "generateProof",
      args: [event.message.nonce],
      blockNumber,
    });

    this.logger.info(`Proof generated at block ${blockNumber}`);
    this.logger.info(`  Leaf index: ${event.message.nonce}`);

    return { event, rawProof };
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

  private formatIxs(ixs: Ix[]) {
    return ixs.map((ix) => ({
      programId: this.bytes32FromPubkey(ix.programId),
      serializedAccounts: ix.accounts.map((acc) =>
        toHex(new Uint8Array(getIxAccountEncoder().encode(acc)))
      ),
      data: toHex(new Uint8Array(ix.data)),
    }));
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

    return { innerHash, outerHash };
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
