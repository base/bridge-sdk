import {
  type Account,
  type AccountMeta,
  AccountRole,
  address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  compileTransaction,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  Endian,
  generateKeyPairSigner,
  getBase58Codec,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getU8Codec,
  getU64Encoder,
  type Instruction,
  type KeyPairSigner,
  pipe,
  type Signature,
  type Address as SolAddress,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  fetchMaybeMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  type Mint,
} from "@solana-program/token";
import { type Address, type Hash, type Hex, keccak256, toBytes } from "viem";
import {
  fetchCfg,
  getPayForRelayInstruction,
} from "../../../clients/ts/src/base-relayer";
import type {
  BridgeBaseToSolanaStateIncomingMessageMessage,
  BridgeBaseToSolanaStateIncomingMessageTransfer,
} from "../../../clients/ts/src/bridge";
import {
  CallType,
  fetchBridge,
  fetchMaybeIncomingMessage,
  fetchMaybeOutgoingMessage,
  fetchOutgoingMessage,
  getAppendToCallBufferInstruction,
  getAppendToProveBufferDataInstruction,
  getAppendToProveBufferProofInstruction,
  getBridgeCallBufferedInstruction,
  getBridgeCallInstruction,
  getBridgeSolInstruction,
  getBridgeSolWithBufferedCallInstruction,
  getBridgeSplInstruction,
  getBridgeSplWithBufferedCallInstruction,
  getBridgeWrappedTokenInstruction,
  getBridgeWrappedTokenWithBufferedCallInstruction,
  getCloseCallBufferInstruction,
  getCloseProveBufferInstruction,
  getInitializeCallBufferInstruction,
  getInitializeProveBufferInstruction,
  getProveMessageBufferedInstruction,
  getProveMessageInstruction,
  getRelayMessageInstruction,
  getWrapTokenInstruction,
  type Ix,
  type OutgoingMessage,
  type WrapTokenInstructionDataArgs,
} from "../../../clients/ts/src/bridge";
import { getIdlConstant } from "../../../utils/bridge-idl.constants";
import type { Logger } from "../../../utils/logger";
import { NOOP_LOGGER } from "../../../utils/logger";
import { getRelayerIdlConstant } from "../../../utils/relayer-idl.constants";
import { sleep } from "../../../utils/time";
import {
  BridgeAlreadyExecutedError,
  BridgeInvariantViolationError,
  BridgeNotProvenError,
  BridgeValidationError,
} from "../../errors";
import type { EvmCall } from "../../types";
import { deriveIncomingMessagePda } from "../pda";
import {
  DEFAULT_MONITOR_POLL_INTERVAL_MS,
  DEFAULT_MONITOR_TIMEOUT_MS,
} from "./constants";

const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as SolAddress<"11111111111111111111111111111111">;
const TOKEN_2022_PROGRAM_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as SolAddress<"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb">;
const DEFAULT_RELAY_GAS_LIMIT = 200_000n;

interface SolanaEngineConfig {
  rpcUrl: string;
  payer: KeyPairSigner;
  bridgeProgram: SolAddress;
  relayerProgram: SolAddress;
}

type Rpc = ReturnType<typeof createSolanaRpc>;

type MessageCall = Extract<
  BridgeBaseToSolanaStateIncomingMessageMessage,
  { __kind: "Call" }
>;

type MessageTransfer = Extract<
  BridgeBaseToSolanaStateIncomingMessageMessage,
  { __kind: "Transfer" }
>;

type MessageTransferSol = Extract<
  BridgeBaseToSolanaStateIncomingMessageTransfer,
  { __kind: "Sol" }
>;

type MessageTransferSpl = Extract<
  BridgeBaseToSolanaStateIncomingMessageTransfer,
  { __kind: "Spl" }
>;

type MessageTransferWrappedToken = Extract<
  BridgeBaseToSolanaStateIncomingMessageTransfer,
  { __kind: "WrappedToken" }
>;

interface BridgeOpResult {
  outgoingPda: SolAddress;
  signature: Signature;
}

interface InitCallBufferResult {
  bufferAddress: SolAddress;
  signature: Signature;
}

interface InitializeCallBufferOpts {
  callType: CallType;
  to: Uint8Array;
  value: bigint;
  initialData: Uint8Array;
  maxDataLen: bigint;
}

interface AppendToCallBufferOpts {
  bufferAddress: SolAddress;
  data: Uint8Array;
}

interface CloseCallBufferOpts {
  bufferAddress: SolAddress;
}

interface BufferedBridgeCallOpts {
  bufferAddress: SolAddress;
  payForRelay?: boolean;
  gasLimit?: bigint;
  idempotencyKey?: string;
}

interface BufferedBridgeSolOpts extends BufferedBridgeCallOpts {
  to: Address;
  amount: bigint;
}

interface BufferedBridgeSplOpts extends BufferedBridgeCallOpts {
  to: Address;
  mint: string;
  remoteToken: string;
  amount: bigint;
}

interface BufferedBridgeWrappedOpts extends BufferedBridgeCallOpts {
  to: Address;
  mint: string;
  amount: bigint;
}

interface InitializeProveBufferOpts {
  maxDataLen: bigint;
  maxProofLen: bigint;
}

interface AppendToProveBufferDataOpts {
  bufferAddress: SolAddress;
  chunk: Uint8Array;
}

interface AppendToProveBufferProofOpts {
  bufferAddress: SolAddress;
  proofChunk: Uint8Array[];
}

interface ProveMessageBufferedOpts {
  bufferAddress: SolAddress;
  event: {
    messageHash: `0x${string}`;
    message: {
      nonce: bigint;
      sender: `0x${string}`;
    };
  };
  blockNumber: bigint;
}

interface SolanaEngineOpts {
  config: SolanaEngineConfig;
  logger?: Logger;
}

interface BridgeOpOpts {
  payForRelay?: boolean;
  call?: EvmCall;
  gasLimit?: bigint;
  idempotencyKey?: string;
}

interface BridgeSolOpts extends BridgeOpOpts {
  to: Address;
  amount: bigint;
}

interface BridgeSplOpts extends BridgeOpOpts {
  to: Address;
  mint: string;
  remoteToken: string;
  amount: bigint;
}

interface BridgeWrappedOpts extends BridgeOpOpts {
  to: Address;
  mint: string;
  amount: bigint;
}

interface FormattedCall {
  ty: CallType;
  to: Uint8Array;
  value: bigint;
  data: Buffer;
}

interface BridgeCallOpts extends EvmCall, BridgeOpOpts {}

interface WrapTokenOpts {
  remoteToken: string;
  name: string;
  symbol: string;
  decimals: number;
  scalerExponent: number;
  payForRelay?: boolean;
  idempotencyKey?: string;
}

export class SolanaEngine {
  private readonly config: SolanaEngineConfig;
  private readonly rpc: Rpc;
  private readonly logger: Logger;
  private readonly sendAndConfirmTx: ReturnType<
    typeof sendAndConfirmTransactionFactory
  >;
  private bridgePdaPromise: Promise<SolAddress> | undefined;

  constructor(opts: SolanaEngineOpts) {
    this.config = opts.config;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.rpc = createSolanaRpc(this.config.rpcUrl);

    const url = new URL(this.config.rpcUrl);
    const wsScheme = url.protocol === "http:" ? "ws" : "wss";
    const wssUrl = `${wsScheme}://${url.host}${url.pathname}${url.search}`;
    const rpcSubscriptions = createSolanaRpcSubscriptions(wssUrl);
    this.sendAndConfirmTx = sendAndConfirmTransactionFactory({
      rpc: this.rpc,
      rpcSubscriptions,
    });
  }

  private getBridgePda(): Promise<SolAddress> {
    if (!this.bridgePdaPromise) {
      this.bridgePdaPromise = getProgramDerivedAddress({
        programAddress: this.config.bridgeProgram,
        seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
      }).then(([addr]) => addr);
    }
    return this.bridgePdaPromise;
  }

  private async getCfgAddress(): Promise<SolAddress> {
    const [cfgAddress] = await getProgramDerivedAddress({
      programAddress: this.config.relayerProgram,
      seeds: [Buffer.from(getRelayerIdlConstant("CFG_SEED"))],
    });
    return cfgAddress;
  }

  async getOutgoingMessage(
    pubkey: SolAddress,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<Account<OutgoingMessage, string>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_MONITOR_TIMEOUT_MS;
    const pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS;
    const startTime = Date.now();

    this.logger.debug(
      `solanaEngine.getOutgoingMessage: polling pubkey=${pubkey}, timeout=${timeoutMs}ms`,
    );

    while (Date.now() - startTime <= timeoutMs) {
      const maybeAccount = await fetchMaybeOutgoingMessage(this.rpc, pubkey);
      if (maybeAccount.exists) {
        this.logger.debug(
          `solanaEngine.getOutgoingMessage: found, pubkey=${pubkey}, elapsed=${Date.now() - startTime}ms`,
        );
        return maybeAccount as Account<OutgoingMessage, string>;
      }
      await sleep(pollIntervalMs);
    }

    this.logger.warn(
      `solanaEngine.getOutgoingMessage: not found after ${timeoutMs}ms, fetching directly, pubkey=${pubkey}`,
    );
    return await fetchOutgoingMessage(this.rpc, pubkey);
  }

  /**
   * Fetches gas configuration from both bridge and relayer programs.
   * Used for quote estimation.
   */
  async getGasConfigs(): Promise<{
    bridgeGasConfig: {
      gasCostScaler: bigint;
      gasCostScalerDp: bigint;
      gasPerCall: bigint;
    };
    relayerGasConfig: {
      minGasLimitPerMessage: bigint;
      maxGasLimitPerMessage: bigint;
      gasCostScaler: bigint;
      gasCostScalerDp: bigint;
    };
  }> {
    this.logger.debug(
      "solanaEngine.getGasConfigs: fetching bridge and relayer configs",
    );
    const bridgeAddress = await this.getBridgePda();

    const cfgAddress = await this.getCfgAddress();

    const [bridge, cfg] = await Promise.all([
      fetchBridge(this.rpc, bridgeAddress),
      fetchCfg(this.rpc, cfgAddress),
    ]);

    this.logger.debug(
      `solanaEngine.getGasConfigs: gasPerCall=${bridge.data.gasConfig.gasPerCall}, relayerMinGas=${cfg.data.gasConfig.minGasLimitPerMessage}, relayerMaxGas=${cfg.data.gasConfig.maxGasLimitPerMessage}`,
    );

    return {
      bridgeGasConfig: {
        gasCostScaler: bridge.data.gasConfig.gasCostScaler,
        gasCostScalerDp: bridge.data.gasConfig.gasCostScalerDp,
        gasPerCall: bridge.data.gasConfig.gasPerCall,
      },
      relayerGasConfig: {
        minGasLimitPerMessage: cfg.data.gasConfig.minGasLimitPerMessage,
        maxGasLimitPerMessage: cfg.data.gasConfig.maxGasLimitPerMessage,
        gasCostScaler: cfg.data.gasConfig.gasCostScaler,
        gasCostScalerDp: cfg.data.gasConfig.gasCostScalerDp,
      },
    };
  }

  /**
   * Simulates a list of instructions to estimate compute units consumed.
   * This is useful for quote estimation to get accurate fee predictions.
   *
   * Note: This simulates the instructions in isolation, not wrapped in the
   * bridge execute context. The actual execute will have additional overhead
   * from the bridge program's CPI calls.
   *
   * @param instructions - The Solana instructions to simulate
   * @returns The compute units consumed, or undefined if simulation fails
   */
  async simulateInstructions(
    instructions: Instruction[],
  ): Promise<bigint | undefined> {
    if (instructions.length === 0) {
      return 0n;
    }

    this.logger.debug(
      `solanaEngine.simulateInstructions: simulating ${instructions.length} instruction(s)`,
    );

    // Get a recent blockhash for the transaction
    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();

    // We need a fee payer for simulation - use the bridge program as a dummy
    // since we're using replaceRecentBlockhash which skips signature verification
    const feePayer = this.config.bridgeProgram;

    // Build the transaction message
    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(feePayer, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg),
    );

    // Compile to transaction (unsigned)
    const compiledTx = compileTransaction(txMessage);

    // Serialize to base64 wire format
    const base64Tx = getBase64EncodedWireTransaction(compiledTx);

    try {
      // Simulate with replaceRecentBlockhash to avoid signature verification
      const result = await this.rpc
        .simulateTransaction(base64Tx, {
          encoding: "base64",
          replaceRecentBlockhash: true,
          commitment: "confirmed",
        })
        .send();

      if (result.value.err) {
        // Simulation failed (e.g., instruction would revert)
        // Return undefined to indicate we couldn't get an accurate estimate
        this.logger.warn(
          `solanaEngine.simulateInstructions: simulation failed, err=${JSON.stringify(result.value.err)}`,
        );
        return undefined;
      }

      this.logger.debug(
        `solanaEngine.simulateInstructions: success, unitsConsumed=${result.value.unitsConsumed}`,
      );
      return result.value.unitsConsumed;
    } catch (err) {
      // RPC error or other failure
      this.logger.warn(
        `solanaEngine.simulateInstructions: RPC error, ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  async bridgeSol(opts: BridgeSolOpts): Promise<BridgeOpResult> {
    this.logger.debug(
      `solanaEngine.bridgeSol: to=${opts.to}, amount=${opts.amount}, payForRelay=${!!opts.payForRelay}, hasCall=${!!opts.call}`,
    );
    return await this.executeBridgeOp(
      opts.payForRelay,
      opts.gasLimit,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const solVaultAddress = await this.solVaultPubkey();

        return [
          getBridgeSolInstruction(
            {
              payer,
              from: payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              solVault: solVaultAddress,
              bridge: bridge.address,
              outgoingMessage,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,

              outgoingMessageSalt: salt,
              to: toBytes(opts.to),
              amount: opts.amount,
              call: this.formatCall(opts.call),
            },
            { programAddress: this.config.bridgeProgram },
          ),
        ];
      },
      opts.idempotencyKey,
      "bridgeSol",
    );
  }

  async bridgeSpl(opts: BridgeSplOpts): Promise<BridgeOpResult> {
    this.logger.debug(
      `solanaEngine.bridgeSpl: to=${opts.to}, mint=${opts.mint}, remoteToken=${opts.remoteToken}, amount=${opts.amount}, payForRelay=${!!opts.payForRelay}`,
    );
    return await this.executeBridgeOp(
      opts.payForRelay,
      opts.gasLimit,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const { mint, fromTokenAccount, amount, tokenProgram } =
          await this.setupSpl(opts, payer);

        const remoteTokenBytes = toBytes(opts.remoteToken);
        const mintBytes = getBase58Encoder().encode(mint);

        const [tokenVaultAddress] = await getProgramDerivedAddress({
          programAddress: this.config.bridgeProgram,
          seeds: [
            Buffer.from(getIdlConstant("TOKEN_VAULT_SEED")),
            mintBytes,
            Buffer.from(remoteTokenBytes),
          ],
        });

        return [
          getBridgeSplInstruction(
            {
              payer,
              from: payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              mint,
              fromTokenAccount,
              tokenVault: tokenVaultAddress,
              bridge: bridge.address,
              outgoingMessage,
              tokenProgram,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,

              outgoingMessageSalt: salt,
              to: toBytes(opts.to),
              remoteToken: remoteTokenBytes,
              amount,
              call: this.formatCall(opts.call),
            },
            { programAddress: this.config.bridgeProgram },
          ),
        ];
      },
      opts.idempotencyKey,
      "bridgeSpl",
    );
  }

  async bridgeWrapped(opts: BridgeWrappedOpts): Promise<BridgeOpResult> {
    this.logger.debug(
      `solanaEngine.bridgeWrapped: to=${opts.to}, mint=${opts.mint}, amount=${opts.amount}, payForRelay=${!!opts.payForRelay}`,
    );
    return await this.executeBridgeOp(
      opts.payForRelay,
      opts.gasLimit,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const { mint, fromTokenAccount, amount, tokenProgram } =
          await this.setupSpl(opts, payer);

        return [
          getBridgeWrappedTokenInstruction(
            {
              payer,
              from: payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              mint,
              fromTokenAccount,
              bridge: bridge.address,
              outgoingMessage,
              tokenProgram,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,

              outgoingMessageSalt: salt,
              to: toBytes(opts.to),
              amount,
              call: this.formatCall(opts.call),
            },
            { programAddress: this.config.bridgeProgram },
          ),
        ];
      },
      opts.idempotencyKey,
      "bridgeWrapped",
    );
  }

  async bridgeCall(opts: BridgeCallOpts): Promise<BridgeOpResult> {
    this.logger.debug(
      `solanaEngine.bridgeCall: to=${opts.to}, value=${opts.value}, dataLen=${(opts.data.length - 2) / 2}, payForRelay=${!!opts.payForRelay}`,
    );
    return await this.executeBridgeOp(
      opts.payForRelay,
      opts.gasLimit,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        return [
          getBridgeCallInstruction(
            {
              payer,
              from: payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              bridge: bridge.address,
              outgoingMessage,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,

              outgoingMessageSalt: salt,
              call: this.formatCall(opts),
            },
            { programAddress: this.config.bridgeProgram },
          ),
        ];
      },
      opts.idempotencyKey,
      "bridgeCall",
    );
  }

  async wrapToken(opts: WrapTokenOpts): Promise<BridgeOpResult> {
    this.logger.debug(
      `solanaEngine.wrapToken: remoteToken=${opts.remoteToken}, symbol=${opts.symbol}, decimals=${opts.decimals}, scalerExponent=${opts.scalerExponent}`,
    );
    return await this.executeBridgeOp(
      opts.payForRelay,
      undefined,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const instructionArgs: WrapTokenInstructionDataArgs = {
          outgoingMessageSalt: salt,
          decimals: opts.decimals,
          name: opts.name,
          symbol: opts.symbol,
          remoteToken: toBytes(opts.remoteToken),
          scalerExponent: opts.scalerExponent,
        };

        const encodedName = Buffer.from(instructionArgs.name);
        const encodedSymbol = Buffer.from(instructionArgs.symbol);

        const nameLengthLeBytes = getU64Encoder({
          endian: Endian.Little,
        }).encode(encodedName.length);

        const symbolLengthLeBytes = getU64Encoder({
          endian: Endian.Little,
        }).encode(encodedSymbol.length);

        const metadataHash = keccak256(
          Buffer.concat([
            Buffer.from(nameLengthLeBytes),
            encodedName,
            Buffer.from(symbolLengthLeBytes),
            encodedSymbol,
            Buffer.from(instructionArgs.remoteToken),
            Buffer.from(getU8Codec().encode(instructionArgs.scalerExponent)),
          ]),
        );

        const decimalsSeed = Buffer.from(
          getU8Codec().encode(instructionArgs.decimals),
        );

        const [mintAddress] = await getProgramDerivedAddress({
          programAddress: this.config.bridgeProgram,
          seeds: [
            Buffer.from(getIdlConstant("WRAPPED_TOKEN_SEED")),
            decimalsSeed,
            Buffer.from(toBytes(metadataHash)),
          ],
        });

        return [
          getWrapTokenInstruction(
            {
              payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              mint: mintAddress,
              bridge: bridge.address,
              outgoingMessage,
              tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,

              ...instructionArgs,
            },
            { programAddress: this.config.bridgeProgram },
          ),
        ];
      },
      opts.idempotencyKey,
      "wrapToken",
    );
  }

  async getLatestBaseBlockNumber(): Promise<bigint> {
    const bridgeAddress = await this.getBridgePda();

    const bridge = await fetchBridge(this.rpc, bridgeAddress);
    this.logger.debug(
      `solanaEngine.getLatestBaseBlockNumber: blockNumber=${bridge.data.baseBlockNumber}`,
    );
    return bridge.data.baseBlockNumber;
  }

  async isMessageAlreadyProven(messageHash: `0x${string}`): Promise<boolean> {
    const messageAddress = await deriveIncomingMessagePda(
      this.config.bridgeProgram,
      messageHash,
    );
    const maybeMessage = await fetchMaybeIncomingMessage(
      this.rpc,
      messageAddress,
    );
    this.logger.debug(
      `solanaEngine.isMessageAlreadyProven: messageHash=${messageHash}, exists=${maybeMessage.exists}`,
    );
    return maybeMessage.exists;
  }

  async handleProveMessage(
    event: {
      messageHash: `0x${string}`;
      message: {
        nonce: bigint;
        sender: `0x${string}`;
        data: `0x${string}`;
      };
    },
    rawProof: readonly `0x${string}`[],
    blockNumber: bigint,
  ): Promise<{ signature?: Signature; messageHash: Hash }> {
    this.logger.debug(
      `solanaEngine.handleProveMessage: messageHash=${event.messageHash}, nonce=${event.message.nonce}, blockNumber=${blockNumber}, proofNodes=${rawProof.length}`,
    );
    const payer = this.config.payer;

    const { bridgeAddress, outputRootAddress, messageAddress } =
      await this.resolveProveAccounts(blockNumber, event.messageHash);

    const maybeMessage = await fetchMaybeIncomingMessage(
      this.rpc,
      messageAddress,
    );
    if (maybeMessage.exists) {
      this.logger.info(
        `solanaEngine.handleProveMessage: already proven, messageHash=${event.messageHash}`,
      );
      return { messageHash: event.messageHash };
    }

    this.logger.debug(
      `solanaEngine.handleProveMessage: submitting prove transaction, messageHash=${event.messageHash}`,
    );
    const ix = getProveMessageInstruction(
      {
        payer,
        outputRoot: outputRootAddress,
        message: messageAddress,
        bridge: bridgeAddress,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,

        nonce: event.message.nonce,
        sender: toBytes(event.message.sender),
        data: toBytes(event.message.data),
        proof: rawProof.map((e: string) => toBytes(e)),
        messageHash: toBytes(event.messageHash),
      },
      { programAddress: this.config.bridgeProgram },
    );

    const signature = await this.buildAndSendTransaction([ix], payer);
    this.logger.info(
      `solanaEngine.handleProveMessage: proved successfully, messageHash=${event.messageHash}, signature=${signature}`,
    );
    return { signature, messageHash: event.messageHash };
  }

  async handleExecuteMessage(messageHash: Hex): Promise<Signature> {
    this.logger.debug(
      `solanaEngine.handleExecuteMessage: messageHash=${messageHash}`,
    );
    const payer = this.config.payer;

    const messagePda = await deriveIncomingMessagePda(
      this.config.bridgeProgram,
      messageHash,
    );

    const maybeIncomingMessage = await fetchMaybeIncomingMessage(
      this.rpc,
      messagePda,
    );
    if (!maybeIncomingMessage.exists) {
      this.logger.debug(
        `solanaEngine.handleExecuteMessage: message not proven, messageHash=${messageHash}, pda=${messagePda}`,
      );
      throw new BridgeNotProvenError(
        `Message not found at ${messagePda}. Ensure it has been proven on Solana first.`,
        {},
      );
    }
    if (maybeIncomingMessage.data.executed) {
      this.logger.info(
        `solanaEngine.handleExecuteMessage: already executed, messageHash=${messageHash}`,
      );
      throw new BridgeAlreadyExecutedError(
        "Message has already been executed",
        {},
      );
    }

    this.logger.debug(
      `solanaEngine.handleExecuteMessage: resolving accounts, messageKind=${maybeIncomingMessage.data.message.__kind}`,
    );

    const [bridgeCpiAuthorityPda] = await getProgramDerivedAddress({
      programAddress: this.config.bridgeProgram,
      seeds: [
        Buffer.from(getIdlConstant("BRIDGE_CPI_AUTHORITY_SEED")),
        Buffer.from(maybeIncomingMessage.data.sender),
      ],
    });

    const message = maybeIncomingMessage.data.message;

    let remainingAccounts =
      message.__kind === "Call"
        ? this.messageCallAccounts(message)
        : await this.messageTransferAccounts(message);

    remainingAccounts = remainingAccounts.map((acct) => {
      if (acct.address === bridgeCpiAuthorityPda) {
        if (
          acct.role === AccountRole.WRITABLE ||
          acct.role === AccountRole.WRITABLE_SIGNER
        ) {
          return { ...acct, role: AccountRole.WRITABLE };
        }
        return { ...acct, role: AccountRole.READONLY };
      }
      return acct;
    });

    const bridgeAccountAddress = await this.getBridgePda();

    const relayMessageIx = getRelayMessageInstruction(
      { message: messagePda, bridge: bridgeAccountAddress },
      { programAddress: this.config.bridgeProgram },
    );

    const relayMessageIxWithRemainingAccounts: Instruction = {
      programAddress: relayMessageIx.programAddress,
      accounts: [...relayMessageIx.accounts, ...remainingAccounts],
      data: relayMessageIx.data,
    };

    this.logger.debug(
      `solanaEngine.handleExecuteMessage: submitting relay transaction, messageHash=${messageHash}, remainingAccounts=${remainingAccounts.length}`,
    );
    const signature = await this.buildAndSendTransaction(
      [relayMessageIxWithRemainingAccounts],
      payer,
    );
    this.logger.info(
      `solanaEngine.handleExecuteMessage: executed successfully, messageHash=${messageHash}, signature=${signature}`,
    );
    return signature;
  }

  private messageCallAccounts(message: MessageCall) {
    const ixs = message.fields[0];
    if (ixs.length === 0) {
      this.logger.error(
        `solanaEngine.messageCallAccounts: zero instructions in call message`,
      );
      throw new BridgeInvariantViolationError(
        "Zero instructions in call message",
        { stage: "execute" },
      );
    }

    return [
      ...this.getIxAccounts(ixs),
      ...ixs.map((i: Ix) => ({
        address: i.programId,
        role: AccountRole.READONLY,
      })),
    ];
  }

  private async messageTransferAccounts(message: MessageTransfer) {
    const remainingAccounts: Array<AccountMeta> =
      message.transfer.__kind === "Sol"
        ? await this.messageTransferSolAccounts(message.transfer)
        : message.transfer.__kind === "Spl"
          ? await this.messageTransferSplAccounts(message.transfer)
          : await this.messageTransferWrappedTokenAccounts(message.transfer);

    const ixs = message.ixs;

    remainingAccounts.push(
      ...this.getIxAccounts(ixs),
      ...ixs.map((i: Ix) => ({
        address: i.programId,
        role: AccountRole.READONLY,
      })),
    );

    return remainingAccounts;
  }

  private async messageTransferSolAccounts(message: MessageTransferSol) {
    const { to } = message.fields[0];
    const solVaultPda = await this.solVaultPubkey();

    return [
      { address: solVaultPda, role: AccountRole.WRITABLE },
      { address: to, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ];
  }

  private async messageTransferSplAccounts(message: MessageTransferSpl) {
    const { remoteToken, localToken, to } = message.fields[0];

    const [tokenVaultPda] = await getProgramDerivedAddress({
      programAddress: this.config.bridgeProgram,
      seeds: [
        Buffer.from(getIdlConstant("TOKEN_VAULT_SEED")),
        getBase58Codec().encode(localToken),
        Buffer.from(remoteToken),
      ],
    });

    const mint = await this.rpc.getAccountInfo(localToken).send();
    const mintInfo = mint.value;
    if (!mintInfo) {
      this.logger.error(
        `solanaEngine.messageTransferSplAccounts: mint not found, token=${localToken}`,
      );
      throw new BridgeInvariantViolationError(
        `Mint not found for token address: ${localToken}`,
        { stage: "execute" },
      );
    }

    return [
      { address: localToken, role: AccountRole.READONLY },
      { address: tokenVaultPda, role: AccountRole.WRITABLE },
      { address: to, role: AccountRole.WRITABLE },
      { address: mintInfo.owner, role: AccountRole.READONLY },
    ];
  }

  private async messageTransferWrappedTokenAccounts(
    message: MessageTransferWrappedToken,
  ) {
    const { localToken, to } = message.fields[0];

    return [
      { address: localToken, role: AccountRole.WRITABLE },
      { address: to, role: AccountRole.WRITABLE },
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ];
  }

  private getIxAccounts(ixs: Ix[]) {
    const allIxsAccounts = [];

    for (const ix of ixs) {
      for (const acc of ix.accounts) {
        allIxsAccounts.push({
          address: acc.pubkey,
          role: acc.isWritable
            ? acc.isSigner
              ? AccountRole.WRITABLE_SIGNER
              : AccountRole.WRITABLE
            : acc.isSigner
              ? AccountRole.READONLY_SIGNER
              : AccountRole.READONLY,
        });
      }
    }

    return allIxsAccounts;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Call buffer lifecycle methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a new call buffer account to hold large call data that exceeds
   * Solana's single-transaction size limit.
   *
   * The payer becomes the buffer owner and is the only account authorized
   * to append, close, or consume the buffer.
   */
  async initializeCallBuffer(
    opts: InitializeCallBufferOpts,
  ): Promise<InitCallBufferResult> {
    this.logger.debug(
      `solanaEngine.initializeCallBuffer: callType=${opts.callType}, maxDataLen=${opts.maxDataLen}, initialDataLen=${opts.initialData.length}`,
    );
    const callBufferKeypair = await generateKeyPairSigner();
    const bridgeAddress = await this.getBridgePda();

    const ix = getInitializeCallBufferInstruction(
      {
        payer: this.config.payer,
        bridge: bridgeAddress,
        callBuffer: callBufferKeypair,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
        ty: opts.callType,
        to: opts.to,
        value: opts.value,
        initialData: opts.initialData,
        maxDataLen: opts.maxDataLen,
      },
      { programAddress: this.config.bridgeProgram },
    );

    const signature = await this.buildAndSendTransaction(
      [ix],
      this.config.payer,
      [callBufferKeypair],
    );

    this.logger.info(
      `solanaEngine.initializeCallBuffer: initialized, bufferAddress=${callBufferKeypair.address}, signature=${signature}`,
    );
    return { bufferAddress: callBufferKeypair.address, signature };
  }

  /**
   * Appends data to an existing call buffer. Can be called multiple times
   * to fill the buffer in chunks that each fit within a single transaction.
   */
  async appendToCallBuffer(
    opts: AppendToCallBufferOpts,
  ): Promise<{ signature: Signature }> {
    this.logger.debug(
      `solanaEngine.appendToCallBuffer: bufferAddress=${opts.bufferAddress}, chunkSize=${opts.data.length}`,
    );
    const ix = getAppendToCallBufferInstruction(
      {
        owner: this.config.payer,
        callBuffer: opts.bufferAddress,
        data: opts.data,
      },
      { programAddress: this.config.bridgeProgram },
    );

    const signature = await this.buildAndSendTransaction(
      [ix],
      this.config.payer,
    );
    this.logger.debug(
      `solanaEngine.appendToCallBuffer: appended, bufferAddress=${opts.bufferAddress}, signature=${signature}`,
    );
    return { signature };
  }

  /**
   * Closes a call buffer account and recovers the rent to the owner.
   * Use this to clean up if the bridge operation is aborted.
   */
  async closeCallBuffer(
    opts: CloseCallBufferOpts,
  ): Promise<{ signature: Signature }> {
    this.logger.debug(
      `solanaEngine.closeCallBuffer: bufferAddress=${opts.bufferAddress}`,
    );
    const ix = getCloseCallBufferInstruction(
      {
        owner: this.config.payer,
        callBuffer: opts.bufferAddress,
      },
      { programAddress: this.config.bridgeProgram },
    );

    const signature = await this.buildAndSendTransaction(
      [ix],
      this.config.payer,
    );
    this.logger.debug(
      `solanaEngine.closeCallBuffer: closed, bufferAddress=${opts.bufferAddress}, signature=${signature}`,
    );
    return { signature };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Buffered bridge methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Bridges a call to Base using call data from a pre-filled call buffer.
   * The call buffer is consumed (closed) by this operation.
   */
  async bridgeCallBuffered(
    opts: BufferedBridgeCallOpts,
  ): Promise<BridgeOpResult> {
    this.logger.debug(
      `solanaEngine.bridgeCallBuffered: bufferAddress=${opts.bufferAddress}, payForRelay=${!!opts.payForRelay}`,
    );
    return await this.executeBridgeOp(
      opts.payForRelay,
      opts.gasLimit,
      async ({ payer, bridge, outgoingMessage, salt }) => [
        getBridgeCallBufferedInstruction(
          {
            payer,
            from: payer,
            gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
            bridge: bridge.address,
            owner: payer,
            callBuffer: opts.bufferAddress,
            outgoingMessage,
            systemProgram: SYSTEM_PROGRAM_ADDRESS,
            outgoingMessageSalt: salt,
          },
          { programAddress: this.config.bridgeProgram },
        ),
      ],
      opts.idempotencyKey,
      "bridgeCallBuffered",
    );
  }

  /**
   * Bridges SOL to Base with a call whose data comes from a pre-filled
   * call buffer. The call buffer is consumed (closed) by this operation.
   */
  async bridgeSolWithBufferedCall(
    opts: BufferedBridgeSolOpts,
  ): Promise<BridgeOpResult> {
    this.logger.debug(
      `solanaEngine.bridgeSolWithBufferedCall: to=${opts.to}, amount=${opts.amount}, bufferAddress=${opts.bufferAddress}`,
    );
    return await this.executeBridgeOp(
      opts.payForRelay,
      opts.gasLimit,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const solVaultAddress = await this.solVaultPubkey();
        return [
          getBridgeSolWithBufferedCallInstruction(
            {
              payer,
              from: payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              solVault: solVaultAddress,
              bridge: bridge.address,
              owner: payer,
              callBuffer: opts.bufferAddress,
              outgoingMessage,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,
              outgoingMessageSalt: salt,
              to: toBytes(opts.to),
              amount: opts.amount,
            },
            { programAddress: this.config.bridgeProgram },
          ),
        ];
      },
      opts.idempotencyKey,
      "bridgeSolWithBufferedCall",
    );
  }

  /**
   * Bridges SPL tokens to Base with a call whose data comes from a pre-filled
   * call buffer. The call buffer is consumed (closed) by this operation.
   */
  async bridgeSplWithBufferedCall(
    opts: BufferedBridgeSplOpts,
  ): Promise<BridgeOpResult> {
    this.logger.debug(
      `solanaEngine.bridgeSplWithBufferedCall: to=${opts.to}, mint=${opts.mint}, amount=${opts.amount}, bufferAddress=${opts.bufferAddress}`,
    );
    return await this.executeBridgeOp(
      opts.payForRelay,
      opts.gasLimit,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const { mint, fromTokenAccount, amount, tokenProgram } =
          await this.setupSpl(opts, payer);

        const remoteTokenBytes = toBytes(opts.remoteToken);
        const mintBytes = getBase58Encoder().encode(mint);

        const [tokenVaultAddress] = await getProgramDerivedAddress({
          programAddress: this.config.bridgeProgram,
          seeds: [
            Buffer.from(getIdlConstant("TOKEN_VAULT_SEED")),
            mintBytes,
            Buffer.from(remoteTokenBytes),
          ],
        });

        return [
          getBridgeSplWithBufferedCallInstruction(
            {
              payer,
              from: payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              mint,
              fromTokenAccount,
              bridge: bridge.address,
              tokenVault: tokenVaultAddress,
              owner: payer,
              callBuffer: opts.bufferAddress,
              outgoingMessage,
              tokenProgram,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,
              outgoingMessageSalt: salt,
              to: toBytes(opts.to),
              remoteToken: remoteTokenBytes,
              amount,
            },
            { programAddress: this.config.bridgeProgram },
          ),
        ];
      },
      opts.idempotencyKey,
      "bridgeSplWithBufferedCall",
    );
  }

  /**
   * Bridges wrapped tokens back to Base with a call whose data comes from
   * a pre-filled call buffer. The call buffer is consumed (closed) by this
   * operation.
   */
  async bridgeWrappedTokenWithBufferedCall(
    opts: BufferedBridgeWrappedOpts,
  ): Promise<BridgeOpResult> {
    this.logger.debug(
      `solanaEngine.bridgeWrappedTokenWithBufferedCall: to=${opts.to}, mint=${opts.mint}, amount=${opts.amount}, bufferAddress=${opts.bufferAddress}`,
    );
    return await this.executeBridgeOp(
      opts.payForRelay,
      opts.gasLimit,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const { mint, fromTokenAccount, amount, tokenProgram } =
          await this.setupSpl(opts, payer);

        return [
          getBridgeWrappedTokenWithBufferedCallInstruction(
            {
              payer,
              from: payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              mint,
              fromTokenAccount,
              bridge: bridge.address,
              owner: payer,
              callBuffer: opts.bufferAddress,
              outgoingMessage,
              tokenProgram,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,
              outgoingMessageSalt: salt,
              to: toBytes(opts.to),
              amount,
            },
            { programAddress: this.config.bridgeProgram },
          ),
        ];
      },
      opts.idempotencyKey,
      "bridgeWrappedTokenWithBufferedCall",
    );
  }

  async initializeProveBuffer(
    opts: InitializeProveBufferOpts,
  ): Promise<InitCallBufferResult> {
    this.logger.debug(
      `solanaEngine.initializeProveBuffer: maxDataLen=${opts.maxDataLen}, maxProofLen=${opts.maxProofLen}`,
    );
    const [proveBufferKeypair, bridgeAddress] = await Promise.all([
      generateKeyPairSigner(),
      this.getBridgePda(),
    ]);

    const ix = getInitializeProveBufferInstruction(
      {
        payer: this.config.payer,
        bridge: bridgeAddress,
        proveBuffer: proveBufferKeypair,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
        maxDataLen: opts.maxDataLen,
        maxProofLen: opts.maxProofLen,
      },
      { programAddress: this.config.bridgeProgram },
    );

    const signature = await this.buildAndSendTransaction(
      [ix],
      this.config.payer,
      [proveBufferKeypair],
    );

    this.logger.info(
      `solanaEngine.initializeProveBuffer: initialized, bufferAddress=${proveBufferKeypair.address}, signature=${signature}`,
    );
    return { bufferAddress: proveBufferKeypair.address, signature };
  }

  async appendToProveBufferData(
    opts: AppendToProveBufferDataOpts,
  ): Promise<{ signature: Signature }> {
    this.logger.debug(
      `solanaEngine.appendToProveBufferData: bufferAddress=${opts.bufferAddress}, chunkSize=${opts.chunk.length}`,
    );
    const ix = getAppendToProveBufferDataInstruction(
      {
        owner: this.config.payer,
        proveBuffer: opts.bufferAddress,
        chunk: opts.chunk,
      },
      { programAddress: this.config.bridgeProgram },
    );

    const signature = await this.buildAndSendTransaction(
      [ix],
      this.config.payer,
    );
    this.logger.debug(
      `solanaEngine.appendToProveBufferData: appended, bufferAddress=${opts.bufferAddress}, signature=${signature}`,
    );
    return { signature };
  }

  async appendToProveBufferProof(
    opts: AppendToProveBufferProofOpts,
  ): Promise<{ signature: Signature }> {
    this.logger.debug(
      `solanaEngine.appendToProveBufferProof: bufferAddress=${opts.bufferAddress}, proofNodes=${opts.proofChunk.length}`,
    );
    const ix = getAppendToProveBufferProofInstruction(
      {
        owner: this.config.payer,
        proveBuffer: opts.bufferAddress,
        proofChunk: opts.proofChunk,
      },
      { programAddress: this.config.bridgeProgram },
    );

    const signature = await this.buildAndSendTransaction(
      [ix],
      this.config.payer,
    );
    this.logger.debug(
      `solanaEngine.appendToProveBufferProof: appended, bufferAddress=${opts.bufferAddress}, signature=${signature}`,
    );
    return { signature };
  }

  async proveMessageBuffered(
    opts: ProveMessageBufferedOpts,
  ): Promise<{ signature?: Signature; messageHash: Hash }> {
    this.logger.debug(
      `solanaEngine.proveMessageBuffered: messageHash=${opts.event.messageHash}, nonce=${opts.event.message.nonce}, blockNumber=${opts.blockNumber}, bufferAddress=${opts.bufferAddress}`,
    );
    const payer = this.config.payer;

    const { bridgeAddress, outputRootAddress, messageAddress } =
      await this.resolveProveAccounts(opts.blockNumber, opts.event.messageHash);

    const maybeMessage = await fetchMaybeIncomingMessage(
      this.rpc,
      messageAddress,
    );
    if (maybeMessage.exists) {
      this.logger.info(
        `solanaEngine.proveMessageBuffered: already proven, messageHash=${opts.event.messageHash}`,
      );
      return { messageHash: opts.event.messageHash };
    }

    const ix = getProveMessageBufferedInstruction(
      {
        payer,
        outputRoot: outputRootAddress,
        message: messageAddress,
        bridge: bridgeAddress,
        owner: payer,
        proveBuffer: opts.bufferAddress,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,

        nonce: opts.event.message.nonce,
        sender: toBytes(opts.event.message.sender),
        messageHash: toBytes(opts.event.messageHash),
      },
      { programAddress: this.config.bridgeProgram },
    );

    const signature = await this.buildAndSendTransaction([ix], payer);
    this.logger.info(
      `solanaEngine.proveMessageBuffered: proved successfully, messageHash=${opts.event.messageHash}, signature=${signature}`,
    );
    return { signature, messageHash: opts.event.messageHash };
  }

  async closeProveBuffer(
    opts: CloseCallBufferOpts,
  ): Promise<{ signature: Signature }> {
    this.logger.debug(
      `solanaEngine.closeProveBuffer: bufferAddress=${opts.bufferAddress}`,
    );
    const ix = getCloseProveBufferInstruction(
      {
        owner: this.config.payer,
        proveBuffer: opts.bufferAddress,
      },
      { programAddress: this.config.bridgeProgram },
    );

    const signature = await this.buildAndSendTransaction(
      [ix],
      this.config.payer,
    );
    this.logger.debug(
      `solanaEngine.closeProveBuffer: closed, bufferAddress=${opts.bufferAddress}, signature=${signature}`,
    );
    return { signature };
  }

  private async resolveProveAccounts(
    blockNumber: bigint,
    messageHash: `0x${string}`,
  ): Promise<{
    bridgeAddress: SolAddress;
    outputRootAddress: SolAddress;
    messageAddress: SolAddress;
  }> {
    const [bridgeAddress, [outputRootAddress], messageAddress] =
      await Promise.all([
        this.getBridgePda(),
        getProgramDerivedAddress({
          programAddress: this.config.bridgeProgram,
          seeds: [
            Buffer.from(getIdlConstant("OUTPUT_ROOT_SEED")),
            getU64Encoder({ endian: Endian.Little }).encode(blockNumber),
          ],
        }),
        deriveIncomingMessagePda(this.config.bridgeProgram, messageHash),
      ]);
    return { bridgeAddress, outputRootAddress, messageAddress };
  }

  private formatCall(call: EvmCall): FormattedCall;
  private formatCall(call?: EvmCall): FormattedCall | null;
  private formatCall(call?: EvmCall): FormattedCall | null {
    if (!call) return null;

    const callData = call.data.startsWith("0x")
      ? call.data.slice(2)
      : call.data;

    return {
      ty: (call.ty as CallType | undefined) ?? CallType.Call,
      to: toBytes(call.to),
      value: call.value,
      data: Buffer.from(callData, "hex"),
    };
  }

  private async executeBridgeOp(
    payForRelay: boolean | undefined,
    gasLimit: bigint | undefined,
    builder: (ctx: {
      payer: KeyPairSigner;
      bridge: Awaited<ReturnType<typeof fetchBridge>>;
      outgoingMessage: SolAddress;
      salt: Uint8Array;
    }) => Promise<Instruction[]>,
    idempotencyKey?: string,
    opLabel?: string,
  ): Promise<BridgeOpResult> {
    this.logger.debug(
      `solanaEngine.executeBridgeOp: resolving message accounts, payForRelay=${!!payForRelay}`,
    );
    const { payer, bridge, outgoingMessage, salt } =
      await this.setupMessage(idempotencyKey);
    const ixs = await builder({ payer, bridge, outgoingMessage, salt });
    this.logger.debug(
      `solanaEngine.executeBridgeOp: built ${ixs.length} instruction(s), outgoingMessage=${outgoingMessage}`,
    );
    const result = await this.submitMessage(
      ixs,
      outgoingMessage,
      payer,
      !!payForRelay,
      gasLimit,
    );
    this.logger.info(
      `solanaEngine.${opLabel ?? "executeBridgeOp"}: success, signature=${result.signature}, outgoingPda=${result.outgoingPda}`,
    );
    return result;
  }

  private async setupMessage(idempotencyKey?: string) {
    const payer = this.config.payer;

    const bridgeAccountAddress = await this.getBridgePda();

    const bridge = await fetchBridge(this.rpc, bridgeAccountAddress);

    const { salt, pubkey: outgoingMessage } =
      await this.outgoingMessagePubkey(idempotencyKey);
    return { payer, bridge, outgoingMessage, salt };
  }

  private async setupSpl(
    opts: { mint: string; amount: bigint },
    payer: KeyPairSigner,
  ) {
    const mint = address(opts.mint);
    const maybeMint = await fetchMaybeMint(this.rpc, mint);
    if (!maybeMint.exists) {
      this.logger.warn(
        `solanaEngine.setupSpl: mint not found, token=${opts.mint}`,
      );
      throw new BridgeValidationError(
        `Mint not found for token address: ${opts.mint}`,
        { stage: "initiate" },
      );
    }

    const amount = opts.amount;

    const fromTokenAccount = await this.resolvePayerTokenAccount(
      payer.address,
      maybeMint,
    );
    const tokenProgram = maybeMint.programAddress;

    return { mint, fromTokenAccount, amount, tokenProgram };
  }

  private async submitMessage(
    ixs: Instruction[],
    outgoingMessage: SolAddress,
    payer: KeyPairSigner,
    payForRelay: boolean,
    gasLimit?: bigint,
  ): Promise<BridgeOpResult> {
    if (payForRelay) {
      this.logger.debug(
        `solanaEngine.submitMessage: adding relay payment, gasLimit=${gasLimit ?? DEFAULT_RELAY_GAS_LIMIT}`,
      );
      ixs.push(
        await this.buildPayForRelayInstruction(
          outgoingMessage,
          payer,
          gasLimit,
        ),
      );
    }

    this.logger.debug(
      `solanaEngine.submitMessage: sending ${ixs.length} instruction(s)`,
    );
    const signature = await this.buildAndSendTransaction(ixs, payer);
    return { outgoingPda: outgoingMessage, signature };
  }

  private async solVaultPubkey() {
    const [pubkey] = await getProgramDerivedAddress({
      programAddress: this.config.bridgeProgram,
      seeds: [Buffer.from(getIdlConstant("SOL_VAULT_SEED"))],
    });

    return pubkey;
  }

  private async outgoingMessagePubkey(idempotencyKey?: string) {
    const salt =
      idempotencyKey !== undefined
        ? toBytes(keccak256(toBytes(idempotencyKey)))
        : crypto.getRandomValues(new Uint8Array(32));

    const [pubkey] = await getProgramDerivedAddress({
      programAddress: this.config.bridgeProgram,
      seeds: [
        Buffer.from(getIdlConstant("OUTGOING_MESSAGE_SEED")),
        Buffer.from(salt),
      ],
    });

    return { salt, pubkey };
  }

  private async buildAndSendTransaction(
    instructions: Instruction[],
    payer: TransactionSigner,
    additionalSigners?: TransactionSigner[],
  ) {
    this.logger.debug(
      `solanaEngine.buildAndSendTransaction: building tx with ${instructions.length} instruction(s), signers=${1 + (additionalSigners?.length ?? 0)}`,
    );
    const blockhash = await this.rpc.getLatestBlockhash().send();

    const allSigners = [payer, ...(additionalSigners ?? [])];
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(payer.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash.value, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
      (tx) => addSignersToTransactionMessage(allSigners, tx),
    );

    const signedTransaction =
      await signTransactionMessageWithSigners(transactionMessage);
    const signature = getSignatureFromTransaction(signedTransaction);

    this.logger.debug(
      `solanaEngine.buildAndSendTransaction: signed, signature=${signature}, sending...`,
    );

    assertIsSendableTransaction(signedTransaction);
    assertIsTransactionWithBlockhashLifetime(signedTransaction);

    await this.sendAndConfirmTx(signedTransaction, {
      commitment: "confirmed",
    });

    this.logger.debug(
      `solanaEngine.buildAndSendTransaction: confirmed, signature=${signature}`,
    );

    return signature;
  }

  private async buildPayForRelayInstruction(
    outgoingMessage: SolAddress,
    payer: KeyPairSigner<string>,
    gasLimit?: bigint,
  ) {
    const cfgAddress = await this.getCfgAddress();
    const cfg = await fetchCfg(this.rpc, cfgAddress);

    const { salt, pubkey: messageToRelay } = await this.mtrPubkey();

    return getPayForRelayInstruction(
      {
        payer,
        cfg: cfgAddress,
        gasFeeReceiver: cfg.data.gasConfig.gasFeeReceiver,
        messageToRelay,
        mtrSalt: salt,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,

        outgoingMessage: outgoingMessage,
        gasLimit: gasLimit ?? DEFAULT_RELAY_GAS_LIMIT,
      },
      { programAddress: this.config.relayerProgram },
    );
  }

  private async mtrPubkey(salt?: Uint8Array) {
    const s = salt ?? crypto.getRandomValues(new Uint8Array(32));

    const [pubkey] = await getProgramDerivedAddress({
      programAddress: this.config.relayerProgram,
      seeds: [Buffer.from(getRelayerIdlConstant("MTR_SEED")), Buffer.from(s)],
    });

    return { salt: s, pubkey };
  }

  private async resolvePayerTokenAccount(
    payerAddress: SolAddress,
    mint: Account<Mint>,
  ) {
    const [ataAddress] = await findAssociatedTokenPda(
      {
        owner: payerAddress,
        tokenProgram: mint.programAddress,
        mint: mint.address,
      },
      { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
    );

    const maybeAta = await fetchMaybeToken(this.rpc, ataAddress);
    if (!maybeAta.exists) {
      this.logger.warn(
        `solanaEngine.resolvePayerTokenAccount: ATA not found, payer=${payerAddress}, mint=${mint.address}`,
      );
      throw new BridgeValidationError(
        `Associated token account does not exist for payer ${payerAddress}, mint ${mint.address}`,
        { stage: "initiate" },
      );
    }

    return maybeAta.address;
  }
}
