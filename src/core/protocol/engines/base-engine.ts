import {
  getIxAccountEncoder,
  type Call,
  type Ix,
  type fetchOutgoingMessage,
  type OutgoingMessage,
} from "../../../clients/ts/src/bridge";
import { BRIDGE_ABI } from "../../../interfaces/abis/bridge.abi";
import { MessageType, type EngineConfig, type CallParams } from "./types";
import {
  getBase58Codec,
  getBase58Encoder,
  type Account,
  type Address,
} from "@solana/kit";
import { sleep } from "../../../utils/time";
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
  DEFAULT_EVM_GAS_LIMIT,
  DEFAULT_MONITOR_POLL_INTERVAL_MS,
  DEFAULT_MONITOR_TIMEOUT_MS,
} from "./constants";
import { type Logger, NOOP_LOGGER } from "../../../utils/logger";
import { BRIDGE_VALIDATOR_ABI } from "../../../interfaces/abis/bridge-validator.abi";

export interface BaseEngineOpts {
  config: EngineConfig;
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
  private readonly config: EngineConfig;
  private readonly logger: Logger;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient | undefined;
  private validatorAddressPromise: Promise<Hex> | undefined;

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

  private async getValidatorAddress(): Promise<Hex> {
    if (!this.validatorAddressPromise) {
      this.validatorAddressPromise = this.publicClient.readContract({
        address: this.config.base.bridgeContract,
        abi: BRIDGE_ABI,
        functionName: "BRIDGE_VALIDATOR",
      });
    }
    return this.validatorAddressPromise;
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
        } catch {
          return null;
        }
      })
      .filter((event) => event !== null);

    if (msgInitEvents.length === 0) {
      throw new Error("No MessageInitiated event found in transaction");
    }
    if (msgInitEvents.length > 1) {
      throw new Error("Multiple MessageInitiated events found (unsupported)");
    }

    const event = msgInitEvents[0]!;

    const rawProof = await this.publicClient.readContract({
      address: this.config.base.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "generateProof",
      args: [event.message.nonce],
      blockNumber,
    });

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

    const { outerHash } = this.buildEvmMessage(outgoingMessageAccount);

    while (Date.now() - startTime <= timeoutMs) {
      const isSuccessful = await this.publicClient.readContract({
        address: this.config.base.bridgeContract,
        abi: BRIDGE_ABI,
        functionName: "successes",
        args: [outerHash],
      });

      if (isSuccessful) {
        return;
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(`Monitor message execution timed out after ${timeoutMs}ms`);
  }

  async executeMessage(
    outgoingMessageAccount: Account<OutgoingMessage, string>,
    options: {
      gasLimit?: bigint;
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {}
  ): Promise<Hash> {
    if (!this.walletClient || !this.config.base.privateKey) {
      throw new Error(
        "Base wallet client not initialized (missing privateKey)"
      );
    }

    const account = privateKeyToAccount(this.config.base.privateKey);

    // Compute inner message hash as Base contracts do
    const { outerHash, evmMessage } = this.buildEvmMessage(
      outgoingMessageAccount,
      options.gasLimit
    );

    // Batch all on-chain reads into a single multicall for performance
    const [successesResult, failuresResult, messageHashResult] =
      await this.publicClient.multicall({
        contracts: [
          {
            address: this.config.base.bridgeContract,
            abi: BRIDGE_ABI,
            functionName: "successes",
            args: [outerHash],
          },
          {
            address: this.config.base.bridgeContract,
            abi: BRIDGE_ABI,
            functionName: "failures",
            args: [outerHash],
          },
          {
            address: this.config.base.bridgeContract,
            abi: BRIDGE_ABI,
            functionName: "getMessageHash",
            args: [evmMessage],
          },
        ],
        allowFailure: false,
      });

    // Check if message was already executed
    if (successesResult) {
      return outerHash;
    }

    // Check if message previously failed
    if (failuresResult) {
      throw new Error(
        `Message previously failed execution on Base. Hash: ${outerHash}`
      );
    }

    // Assert Bridge.getMessageHash(message) equals expected hash
    if (this.sanitizeHex(messageHashResult) !== this.sanitizeHex(outerHash)) {
      throw new Error(
        `Hash mismatch: getMessageHash != expected. got=${messageHashResult}, expected=${outerHash}`
      );
    }

    // Wait for validator approval of this exact message hash
    await this.waitForApproval(
      outerHash,
      options.timeoutMs,
      options.pollIntervalMs
    );

    // Execute the message on Base
    const tx = await this.walletClient.writeContract({
      address: this.config.base.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "relayMessages",
      args: [[evmMessage]],
      account,
      chain: this.config.base.chain,
    });

    return tx;
  }

  private async waitForApproval(
    messageHash: Hex,
    timeoutMs = DEFAULT_MONITOR_TIMEOUT_MS,
    intervalMs = DEFAULT_MONITOR_POLL_INTERVAL_MS
  ) {
    const validatorAddress = await this.getValidatorAddress();

    const start = Date.now();
    let currentInterval = intervalMs;
    const maxInterval = 30_000;

    while (Date.now() - start <= timeoutMs) {
      const approved = await this.publicClient.readContract({
        address: validatorAddress,
        abi: BRIDGE_VALIDATOR_ABI,
        functionName: "validMessages",
        args: [messageHash],
      });

      if (approved) {
        return;
      }

      await sleep(currentInterval);
      currentInterval = Math.min(
        Math.floor(currentInterval * 1.5),
        maxInterval
      );
    }

    throw new Error(
      `Timed out waiting for BridgeValidator approval after ${timeoutMs}ms`
    );
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

  buildEvmMessage(
    outgoing: Awaited<ReturnType<typeof fetchOutgoingMessage>>,
    gasLimit: bigint = DEFAULT_EVM_GAS_LIMIT
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
      gasLimit,
      nonce,
      sender: senderBytes32,
      ty,
      data,
    };

    return { innerHash, outerHash, evmMessage };
  }

  private bytes32FromPubkey(pubkey: Address): Hex {
    const bytes = getBase58Encoder().encode(pubkey);
    let hex = toHex(new Uint8Array(bytes));
    if (hex.length !== 66) hex = padHex(hex, { size: 32 });
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

    return encodeAbiParameters(
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

  private sanitizeHex(h: string): string {
    return h.toLowerCase();
  }
}
