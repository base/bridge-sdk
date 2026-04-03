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
  type ReplacementReason,
  type TransactionReceipt,
  toHex,
  WaitForTransactionReceiptTimeoutError,
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
import { type Logger, NOOP_LOGGER } from "../../../utils/logger";
import { sleep } from "../../../utils/time";
import {
  BridgeExecutionRevertedError,
  BridgeInvariantViolationError,
  BridgeMessageFailedError,
  BridgeProofNotAvailableError,
  BridgeTimeoutError,
  BridgeTransactionDroppedError,
  BridgeValidationError,
} from "../../errors";
import type { BridgeContext, EvmCall, RouteStep } from "../../types";
import { buildEvmIncomingMessage, bytes32FromSolanaPubkey } from "../encoding";
import { decodeMessageInitiatedEvents } from "../events";
import {
  DEFAULT_EVM_GAS_LIMIT,
  DEFAULT_MONITOR_POLL_INTERVAL_MS,
  DEFAULT_MONITOR_TIMEOUT_MS,
  DEFAULT_TX_CONFIRMATION_COUNT,
  DEFAULT_TX_CONFIRMATION_POLL_INTERVAL_MS,
  DEFAULT_TX_CONFIRMATION_TIMEOUT_MS,
} from "./constants";

export interface TransactionConfirmationConfig {
  /** Number of block confirmations to wait for (default: 1). */
  confirmations?: number;
  /** Maximum time (ms) to wait for a receipt before treating the tx as dropped (default: 60 000). */
  timeoutMs?: number;
  /** Polling interval (ms) when waiting for a receipt (default: 2 000). */
  pollIntervalMs?: number;
}

interface BaseEngineConfig {
  rpcUrl: string;
  bridgeContract: EvmAddress;
  chain: Chain;
  privateKey?: Hex;
  /** Transaction confirmation settings applied after every EVM write. */
  confirmation?: TransactionConfirmationConfig;
}

interface BaseEngineOpts {
  config: BaseEngineConfig;
  logger?: Logger;
}

export interface ConfirmedTransaction {
  receipt?: TransactionReceipt;
  alreadyExecuted?: boolean;
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
  private readonly logger: Logger;
  private validatorAddressPromise: Promise<Hex> | undefined;

  constructor(opts: BaseEngineOpts) {
    this.config = opts.config;
    this.logger = opts.logger ?? NOOP_LOGGER;
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

  private requireWallet(stage: RouteStep = "initiate") {
    if (!this.walletClient || !this.account) {
      throw new BridgeValidationError(
        "Base wallet client not initialized (missing privateKey)",
        { stage },
      );
    }
    return {
      walletClient: this.walletClient,
      account: this.account,
    };
  }

  private async confirmTransaction(
    hash: Hash,
    stage: RouteStep,
  ): Promise<TransactionReceipt> {
    const {
      confirmations = DEFAULT_TX_CONFIRMATION_COUNT,
      timeoutMs = DEFAULT_TX_CONFIRMATION_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_TX_CONFIRMATION_POLL_INTERVAL_MS,
    } = this.config.confirmation ?? {};

    this.logger.debug(
      `baseEngine.confirmTransaction: waiting for receipt, hash=${hash}, confirmations=${confirmations}, timeout=${timeoutMs}ms`,
    );

    // Capture replacement info outside the callback so we can check it
    // reliably after the promise resolves.  Throwing from `onReplaced` is
    // unreliable because viem treats it as a notification callback and may
    // leave the promise in an unresolved state.
    let droppedReason: { reason: ReplacementReason; newHash: Hash } | undefined;

    let receipt: TransactionReceipt;
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        confirmations,
        timeout: timeoutMs,
        pollingInterval: pollIntervalMs,
        onReplaced: (replacement) => {
          // "repriced" means gas price changed but same to/value/data — the
          // bridge call was still executed successfully.  Log and allow the
          // replacement receipt to resolve normally.
          if (replacement.reason === "repriced") {
            this.logger.info(
              `baseEngine.confirmTransaction: transaction repriced, hash=${hash}, newHash=${replacement.transaction.hash}`,
            );
            return;
          }

          // "cancelled" or "replaced" means the original intent was
          // superseded — the bridge call was NOT executed.  Record the
          // reason and let the promise resolve; we check below.
          this.logger.warn(
            `baseEngine.confirmTransaction: transaction ${replacement.reason}, hash=${hash}, newHash=${replacement.transaction.hash}`,
          );
          droppedReason = {
            reason: replacement.reason,
            newHash: replacement.transaction.hash,
          };
        },
      });
    } catch (e) {
      if (e instanceof WaitForTransactionReceiptTimeoutError) {
        this.logger.warn(
          `baseEngine.confirmTransaction: timed out waiting for receipt, hash=${hash}`,
        );
        throw new BridgeTransactionDroppedError(
          `Transaction receipt not found within ${timeoutMs}ms — the transaction may have been dropped from the mempool: ${hash}`,
          { stage, cause: e },
        );
      }

      throw e;
    }

    // Check if the transaction was cancelled or replaced after the promise
    // resolved.  viem resolves with the *replacement* receipt regardless, so
    // the receipt itself is valid but represents a different intent.
    if (droppedReason) {
      throw new BridgeTransactionDroppedError(
        `Transaction was ${droppedReason.reason}: original=${hash}, replacement=${droppedReason.newHash}`,
        { stage },
      );
    }

    if (receipt.status === "reverted") {
      this.logger.error(
        `baseEngine.confirmTransaction: transaction reverted, hash=${hash}, gasUsed=${receipt.gasUsed}`,
      );
      throw new BridgeExecutionRevertedError(
        `Transaction reverted on-chain: ${hash}`,
        { stage },
      );
    }

    this.logger.info(
      `baseEngine.confirmTransaction: confirmed, hash=${receipt.transactionHash}, block=${receipt.blockNumber}, gasUsed=${receipt.gasUsed}`,
    );
    return receipt;
  }

  async estimateGasForCall(call: EvmCall): Promise<bigint> {
    this.logger.debug(
      `baseEngine.estimateGas: to=${call.to}, value=${call.value ?? 0n}`,
    );
    const gas = await this.publicClient.estimateGas({
      account: this.config.bridgeContract,
      to: call.to,
      data: call.data,
      value: call.value,
    });
    this.logger.debug(`baseEngine.estimateGas: result=${gas}`);
    return gas;
  }

  async bridgeCall(opts: BaseBridgeCallOpts): Promise<ConfirmedTransaction> {
    const { walletClient, account } = this.requireWallet();
    const formattedIxs = this.formatIxs(opts.ixs);

    this.logger.debug(
      `baseEngine.bridgeCall: simulating with ${opts.ixs.length} instruction(s)`,
    );
    const { request } = await this.publicClient.simulateContract({
      address: this.config.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "bridgeCall",
      args: [formattedIxs],
      account,
      chain: this.config.chain,
    });
    this.logger.debug("baseEngine.bridgeCall: simulation succeeded");

    this.logger.info("baseEngine.bridgeCall: submitting transaction");
    const txHash = await walletClient.writeContract(request);
    this.logger.info(`baseEngine.bridgeCall: submitted txHash=${txHash}`);

    const receipt = await this.confirmTransaction(txHash, "initiate");
    return { receipt };
  }

  async bridgeToken(opts: BaseBridgeTokenOpts): Promise<ConfirmedTransaction> {
    const { walletClient, account } = this.requireWallet();
    const formattedIxs = this.formatIxs(opts.ixs);

    const transferStruct = {
      localToken: opts.transfer.localToken,
      remoteToken: bytes32FromSolanaPubkey(opts.transfer.remoteToken),
      to: bytes32FromSolanaPubkey(opts.transfer.to),
      remoteAmount: opts.transfer.amount,
    };

    this.logger.debug(
      `baseEngine.bridgeToken: simulating localToken=${opts.transfer.localToken}, amount=${opts.transfer.amount}, ixs=${opts.ixs.length}`,
    );
    const { request } = await this.publicClient.simulateContract({
      address: this.config.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "bridgeToken",
      args: [transferStruct, formattedIxs],
      account,
      chain: this.config.chain,
    });
    this.logger.debug("baseEngine.bridgeToken: simulation succeeded");

    this.logger.info("baseEngine.bridgeToken: submitting transaction");
    const txHash = await walletClient.writeContract(request);
    this.logger.info(`baseEngine.bridgeToken: submitted txHash=${txHash}`);

    const receipt = await this.confirmTransaction(txHash, "initiate");
    return { receipt };
  }

  async generateProof(
    transactionHash: Hash,
    blockNumber: bigint,
    context: BridgeContext,
  ) {
    this.logger.debug(
      `baseEngine.generateProof: fetching receipt for txHash=${transactionHash}`,
    );
    const txReceipt = await this.publicClient.getTransactionReceipt({
      hash: transactionHash,
    });

    if (txReceipt.status !== "success") {
      this.logger.error(
        `baseEngine.generateProof: transaction reverted, txHash=${transactionHash}, status=${txReceipt.status}`,
      );
      throw new BridgeExecutionRevertedError(
        `Transaction reverted: ${transactionHash}`,
        { stage: "prove", ...context },
      );
    }

    this.logger.debug(
      `baseEngine.generateProof: receipt confirmed, blockNumber=${txReceipt.blockNumber}, gasUsed=${txReceipt.gasUsed}`,
    );

    // Validate that bridge state is not behind the transaction
    for (const log of txReceipt.logs) {
      if (blockNumber < log.blockNumber) {
        this.logger.error(
          `baseEngine.generateProof: bridge state stale, bridgeBlock=${blockNumber}, txBlock=${log.blockNumber}`,
        );
        throw new BridgeProofNotAvailableError(
          `Solana bridge state is stale (behind transaction block). Bridge state block: ${blockNumber}, Transaction block: ${log.blockNumber}`,
          context,
        );
      }
    }

    // Extract and decode MessageInitiated events
    const msgInitEvents = decodeMessageInitiatedEvents(txReceipt.logs);

    if (msgInitEvents.length !== 1) {
      this.logger.error(
        `baseEngine.generateProof: unexpected event count=${msgInitEvents.length}, txHash=${transactionHash}`,
      );
      throw new BridgeInvariantViolationError(
        msgInitEvents.length === 0
          ? "No MessageInitiated event found in transaction"
          : "Multiple MessageInitiated events found (unsupported)",
        { stage: "prove", ...context },
      );
    }

    const event = msgInitEvents[0]!;
    this.logger.info(
      `baseEngine.generateProof: decoded MessageInitiated event, nonce=${event.message.nonce}`,
    );

    const rawProof = await this.publicClient.readContract({
      address: this.config.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "generateProof",
      args: [event.message.nonce],
      blockNumber,
    });

    this.logger.info(
      `baseEngine.generateProof: proof generated for nonce=${event.message.nonce}, blockNumber=${blockNumber}`,
    );
    return { event, rawProof };
  }

  async monitorMessageExecution(
    outgoingMessageAccount: Account<OutgoingMessage, string>,
    context: BridgeContext,
    options: {
      gasLimit?: bigint;
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_MONITOR_TIMEOUT_MS;
    const pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS;
    const startTime = Date.now();

    const { outerHash } = buildEvmIncomingMessage(outgoingMessageAccount, {
      gasLimit: options.gasLimit ?? DEFAULT_EVM_GAS_LIMIT,
    });

    this.logger.debug(
      `baseEngine.monitorExecution: polling outerHash=${outerHash}, timeout=${timeoutMs}ms`,
    );

    const contracts = [
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
    ] as const;

    let pollCount = 0;
    let halfwayWarned = false;

    while (Date.now() - startTime <= timeoutMs) {
      pollCount++;
      const [isSuccessful, isFailed] = await this.publicClient.multicall({
        contracts,
        allowFailure: false,
      });

      if (isSuccessful) {
        this.logger.info(
          `baseEngine.monitorExecution: message succeeded, outerHash=${outerHash}, elapsed=${Date.now() - startTime}ms, polls=${pollCount}`,
        );
        return;
      }

      if (isFailed) {
        this.logger.warn(
          `baseEngine.monitorExecution: message failed on Base, outerHash=${outerHash}`,
        );
        throw new BridgeMessageFailedError(
          `Message execution failed on Base. Hash: ${outerHash}`,
          context,
        );
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs / 2 && !halfwayWarned) {
        halfwayWarned = true;
        this.logger.warn(
          `baseEngine.monitorExecution: still pending after ${elapsed}ms (${pollCount} polls), outerHash=${outerHash}`,
        );
      }

      await sleep(pollIntervalMs);
    }

    this.logger.warn(
      `baseEngine.monitorExecution: timed out after ${timeoutMs}ms (${pollCount} polls), outerHash=${outerHash}`,
    );
    throw new BridgeTimeoutError(
      `Monitor message execution timed out after ${timeoutMs}ms`,
      { stage: "monitor", ...context },
    );
  }

  async executeMessage(
    outgoingMessageAccount: Account<OutgoingMessage, string>,
    context: BridgeContext,
    options: {
      gasLimit?: bigint;
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): Promise<ConfirmedTransaction> {
    const { walletClient, account } = this.requireWallet("execute");

    const { outerHash, evmMessage } = buildEvmIncomingMessage(
      outgoingMessageAccount,
      { gasLimit: options.gasLimit ?? DEFAULT_EVM_GAS_LIMIT },
    );

    this.logger.debug(
      `baseEngine.executeMessage: checking state for outerHash=${outerHash}`,
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

    if (successesResult) {
      this.logger.info(
        `baseEngine.executeMessage: already succeeded, outerHash=${outerHash}`,
      );
      return { alreadyExecuted: true };
    }

    // Check if message previously failed
    if (failuresResult) {
      this.logger.warn(
        `baseEngine.executeMessage: previously failed, outerHash=${outerHash}`,
      );
      throw new BridgeMessageFailedError(
        `Message previously failed execution on Base. Hash: ${outerHash}`,
        context,
      );
    }

    // Assert Bridge.getMessageHash(message) equals expected hash
    if (messageHashResult.toLowerCase() !== outerHash.toLowerCase()) {
      this.logger.error(
        `baseEngine.executeMessage: hash mismatch, got=${messageHashResult}, expected=${outerHash}`,
      );
      throw new BridgeInvariantViolationError(
        `Hash mismatch: getMessageHash != expected. got=${messageHashResult}, expected=${outerHash}`,
        { stage: "execute", ...context },
      );
    }

    this.logger.debug(
      `baseEngine.executeMessage: hash verified, waiting for validator approval`,
    );

    // Wait for validator approval of this exact message hash
    await this.waitForApproval(
      outerHash,
      context,
      options.timeoutMs,
      options.pollIntervalMs,
    );

    // Execute the message on Base
    this.logger.info(
      `baseEngine.executeMessage: submitting relayMessages, outerHash=${outerHash}`,
    );
    const txHash = await walletClient.writeContract({
      address: this.config.bridgeContract,
      abi: BRIDGE_ABI,
      functionName: "relayMessages",
      args: [[{ ...evmMessage }]],
      account,
      chain: this.config.chain,
    });

    this.logger.info(
      `baseEngine.executeMessage: submitted txHash=${txHash}, awaiting confirmation`,
    );

    const receipt = await this.confirmTransaction(txHash, "execute");
    return { receipt };
  }

  private async waitForApproval(
    messageHash: Hex,
    context: BridgeContext,
    timeoutMs = DEFAULT_MONITOR_TIMEOUT_MS,
    intervalMs = DEFAULT_MONITOR_POLL_INTERVAL_MS,
  ) {
    const validatorAddress = await this.getValidatorAddress();

    this.logger.debug(
      `baseEngine.waitForApproval: polling validator=${validatorAddress}, messageHash=${messageHash}, timeout=${timeoutMs}ms`,
    );

    const start = Date.now();
    let currentInterval = intervalMs;
    const maxInterval = 30_000;
    let pollCount = 0;
    let halfwayWarned = false;

    while (Date.now() - start <= timeoutMs) {
      pollCount++;
      const approved = await this.publicClient.readContract({
        address: validatorAddress,
        abi: BRIDGE_VALIDATOR_ABI,
        functionName: "validMessages",
        args: [messageHash],
      });

      if (approved) {
        this.logger.info(
          `baseEngine.waitForApproval: approved, messageHash=${messageHash}, elapsed=${Date.now() - start}ms, polls=${pollCount}`,
        );
        return;
      }

      const elapsed = Date.now() - start;
      if (elapsed > timeoutMs / 2 && !halfwayWarned) {
        halfwayWarned = true;
        this.logger.warn(
          `baseEngine.waitForApproval: still waiting after ${elapsed}ms (${pollCount} polls, interval=${currentInterval}ms), messageHash=${messageHash}`,
        );
      }

      await sleep(currentInterval);
      currentInterval = Math.min(
        Math.floor(currentInterval * 1.5),
        maxInterval,
      );
    }

    this.logger.warn(
      `baseEngine.waitForApproval: timed out after ${timeoutMs}ms (${pollCount} polls), messageHash=${messageHash}`,
    );
    throw new BridgeTimeoutError(
      `Timed out waiting for BridgeValidator approval after ${timeoutMs}ms`,
      { stage: "execute", ...context },
    );
  }

  private formatIxs(ixs: Ix[]) {
    const encoder = getIxAccountEncoder();
    return ixs.map((ix) => ({
      programId: bytes32FromSolanaPubkey(ix.programId),
      serializedAccounts: ix.accounts.map((acc) =>
        toHex(new Uint8Array(encoder.encode(acc))),
      ),
      data: toHex(new Uint8Array(ix.data)),
    }));
  }
}
