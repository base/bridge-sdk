import type { Account, Address } from "@solana/kit";
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  type Address as EvmAddress,
  type Hash,
  type Hex,
  http,
  type PublicClient,
  toHex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  getIxAccountEncoder,
  type Ix,
  type OutgoingMessage,
} from "../../../clients/ts/src/bridge";
import { BRIDGE_ABI } from "../../../interfaces/abis/bridge.abi";
import { BRIDGE_VALIDATOR_ABI } from "../../../interfaces/abis/bridge-validator.abi";
import { sleep } from "../../../utils/time";
import type { EvmCall } from "../../types";
import { buildEvmIncomingMessage, bytes32FromSolanaPubkey } from "../encoding";
import { decodeMessageInitiatedEvents } from "../events";
import {
  DEFAULT_EVM_GAS_LIMIT,
  DEFAULT_MONITOR_POLL_INTERVAL_MS,
  DEFAULT_MONITOR_TIMEOUT_MS,
} from "./constants";

interface BaseEngineConfig {
  rpcUrl: string;
  bridgeContract: EvmAddress;
  chain: Chain;
  privateKey?: Hex;
}

interface BaseEngineOpts {
  config: BaseEngineConfig;
}

interface BaseBridgeCallOpts {
  ixs: Ix[];
}

interface BaseBridgeTokenOpts {
  transfer: {
    localToken: Hex;
    remoteToken: Address;
    to: Address;
    amount: bigint;
  };
  ixs: Ix[];
}

export class BaseEngine {
  private readonly config: BaseEngineConfig;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient | undefined;
  private readonly account: ReturnType<typeof privateKeyToAccount> | undefined;
  private validatorAddressPromise: Promise<Hex> | undefined;

  constructor(opts: BaseEngineOpts) {
    this.config = opts.config;
    this.publicClient = createPublicClient({
      chain: this.config.chain,
      transport: http(this.config.rpcUrl),
    }) as PublicClient;

    if (this.config.privateKey) {
      this.walletClient = createWalletClient({
        chain: this.config.chain,
        transport: http(this.config.rpcUrl),
      });
      this.account = privateKeyToAccount(this.config.privateKey);
    }
  }

  private async getValidatorAddress(): Promise<Hex> {
    if (!this.validatorAddressPromise) {
      this.validatorAddressPromise = this.publicClient.readContract({
        address: this.config.bridgeContract,
        abi: BRIDGE_ABI,
        functionName: "BRIDGE_VALIDATOR",
      });
    }
    return this.validatorAddressPromise;
  }

  private requireWallet() {
    if (!this.walletClient || !this.account) {
      throw new Error(
        "Base wallet client not initialized (missing privateKey)",
      );
    }
    return {
      walletClient: this.walletClient,
      account: this.account,
    };
  }

  async estimateGasForCall(call: EvmCall): Promise<bigint> {
    return await this.publicClient.estimateGas({
      account: this.config.bridgeContract,
      to: call.to,
      data: call.data,
      value: call.value,
    });
  }

  async bridgeCall(opts: BaseBridgeCallOpts): Promise<Hash> {
    const { walletClient, account } = this.requireWallet();
    const formattedIxs = this.formatIxs(opts.ixs);

    const { request } = await this.publicClient.simulateContract({
      address: this.config.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "bridgeCall",
      args: [formattedIxs],
      account,
      chain: this.config.chain,
    });

    return await walletClient.writeContract(request);
  }

  async bridgeToken(opts: BaseBridgeTokenOpts): Promise<Hash> {
    const { walletClient, account } = this.requireWallet();
    const formattedIxs = this.formatIxs(opts.ixs);

    const transferStruct = {
      localToken: opts.transfer.localToken,
      remoteToken: bytes32FromSolanaPubkey(opts.transfer.remoteToken),
      to: bytes32FromSolanaPubkey(opts.transfer.to),
      remoteAmount: opts.transfer.amount,
    };

    const { request } = await this.publicClient.simulateContract({
      address: this.config.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "bridgeToken",
      args: [transferStruct, formattedIxs],
      account,
      chain: this.config.chain,
    });

    return await walletClient.writeContract(request);
  }

  async generateProof(transactionHash: Hash, blockNumber: bigint) {
    const txReceipt = await this.publicClient.getTransactionReceipt({
      hash: transactionHash,
    });

    if (txReceipt.status !== "success") {
      throw new Error(`Transaction reverted: ${transactionHash}`);
    }

    // Validate that bridge state is not behind the transaction
    for (const log of txReceipt.logs) {
      if (blockNumber < log.blockNumber) {
        throw new Error(
          `Solana bridge state is stale (behind transaction block). Bridge state block: ${blockNumber}, Transaction block: ${log.blockNumber}`,
        );
      }
    }

    // Extract and decode MessageInitiated events
    const msgInitEvents = decodeMessageInitiatedEvents(txReceipt.logs);

    if (msgInitEvents.length !== 1) {
      throw new Error(
        msgInitEvents.length === 0
          ? "No MessageInitiated event found in transaction"
          : "Multiple MessageInitiated events found (unsupported)",
      );
    }

    const [event] = msgInitEvents as [
      (typeof msgInitEvents)[number],
      ...unknown[],
    ];

    const rawProof = await this.publicClient.readContract({
      address: this.config.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "generateProof",
      args: [event.message.nonce],
      blockNumber,
    });

    return { event, rawProof };
  }

  async monitorMessageExecution(
    outgoingMessageAccount: Account<OutgoingMessage, string>,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_MONITOR_TIMEOUT_MS;
    const pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS;
    const startTime = Date.now();

    const { outerHash } = buildEvmIncomingMessage(outgoingMessageAccount, {
      gasLimit: DEFAULT_EVM_GAS_LIMIT,
    });

    while (Date.now() - startTime <= timeoutMs) {
      const isSuccessful = await this.publicClient.readContract({
        address: this.config.bridgeContract,
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
    } = {},
  ): Promise<Hash> {
    const { walletClient, account } = this.requireWallet();

    const { outerHash, evmMessage } = buildEvmIncomingMessage(
      outgoingMessageAccount,
      { gasLimit: options.gasLimit ?? DEFAULT_EVM_GAS_LIMIT },
    );

    // Batch all on-chain reads into a single multicall for performance
    const [successesResult, failuresResult, messageHashResult] =
      await this.publicClient.multicall({
        contracts: [
          {
            address: this.config.bridgeContract,
            abi: BRIDGE_ABI,
            functionName: "successes",
            args: [outerHash],
          },
          {
            address: this.config.bridgeContract,
            abi: BRIDGE_ABI,
            functionName: "failures",
            args: [outerHash],
          },
          {
            address: this.config.bridgeContract,
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
        `Message previously failed execution on Base. Hash: ${outerHash}`,
      );
    }

    // Assert Bridge.getMessageHash(message) equals expected hash
    if (
      (messageHashResult as string).toLowerCase() !== outerHash.toLowerCase()
    ) {
      throw new Error(
        `Hash mismatch: getMessageHash != expected. got=${messageHashResult}, expected=${outerHash}`,
      );
    }

    // Wait for validator approval of this exact message hash
    await this.waitForApproval(
      outerHash,
      options.timeoutMs,
      options.pollIntervalMs,
    );

    // Execute the message on Base
    const tx = await walletClient.writeContract({
      address: this.config.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "relayMessages",
      args: [[{ ...evmMessage }]],
      account,
      chain: this.config.chain,
    });

    return tx;
  }

  private async waitForApproval(
    messageHash: Hex,
    timeoutMs = DEFAULT_MONITOR_TIMEOUT_MS,
    intervalMs = DEFAULT_MONITOR_POLL_INTERVAL_MS,
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
        maxInterval,
      );
    }

    throw new Error(
      `Timed out waiting for BridgeValidator approval after ${timeoutMs}ms`,
    );
  }

  private formatIxs(ixs: Ix[]) {
    return ixs.map((ix) => ({
      programId: bytes32FromSolanaPubkey(ix.programId),
      serializedAccounts: ix.accounts.map((acc) =>
        toHex(new Uint8Array(getIxAccountEncoder().encode(acc))),
      ),
      data: toHex(new Uint8Array(ix.data)),
    }));
  }
}
