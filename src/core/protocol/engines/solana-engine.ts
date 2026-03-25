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
  getBridgeCallBufferedInstruction,
  getBridgeCallInstruction,
  getBridgeSolInstruction,
  getBridgeSolWithBufferedCallInstruction,
  getBridgeSplInstruction,
  getBridgeSplWithBufferedCallInstruction,
  getBridgeWrappedTokenInstruction,
  getBridgeWrappedTokenWithBufferedCallInstruction,
  getCloseCallBufferInstruction,
  getInitializeCallBufferInstruction,
  getProveMessageInstruction,
  getRelayMessageInstruction,
  getWrapTokenInstruction,
  type Ix,
  type OutgoingMessage,
  type WrapTokenInstructionDataArgs,
} from "../../../clients/ts/src/bridge";
import { getIdlConstant } from "../../../utils/bridge-idl.constants";
import { getRelayerIdlConstant } from "../../../utils/relayer-idl.constants";
import { sleep } from "../../../utils/time";
import { BridgeAlreadyExecutedError, BridgeNotProvenError } from "../../errors";
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

interface SolanaEngineOpts {
  config: SolanaEngineConfig;
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
  private readonly sendAndConfirmTx: ReturnType<
    typeof sendAndConfirmTransactionFactory
  >;
  private bridgePdaPromise: Promise<SolAddress> | undefined;

  constructor(opts: SolanaEngineOpts) {
    this.config = opts.config;
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

    while (Date.now() - startTime <= timeoutMs) {
      const maybeAccount = await fetchMaybeOutgoingMessage(this.rpc, pubkey);
      if (maybeAccount.exists) {
        return maybeAccount as Account<OutgoingMessage, string>;
      }
      await sleep(pollIntervalMs);
    }

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
    const bridgeAddress = await this.getBridgePda();

    const cfgAddress = await this.getCfgAddress();

    const [bridge, cfg] = await Promise.all([
      fetchBridge(this.rpc, bridgeAddress),
      fetchCfg(this.rpc, cfgAddress),
    ]);

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
        return undefined;
      }

      return result.value.unitsConsumed;
    } catch {
      // RPC error or other failure
      return undefined;
    }
  }

  async bridgeSol(opts: BridgeSolOpts): Promise<BridgeOpResult> {
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
    );
  }

  async bridgeSpl(opts: BridgeSplOpts): Promise<BridgeOpResult> {
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
    );
  }

  async bridgeWrapped(opts: BridgeWrappedOpts): Promise<BridgeOpResult> {
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
    );
  }

  async bridgeCall(opts: BridgeCallOpts): Promise<BridgeOpResult> {
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
    );
  }

  async wrapToken(opts: WrapTokenOpts): Promise<BridgeOpResult> {
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
    );
  }

  async getLatestBaseBlockNumber(): Promise<bigint> {
    const bridgeAddress = await this.getBridgePda();

    const bridge = await fetchBridge(this.rpc, bridgeAddress);
    return bridge.data.baseBlockNumber;
  }

  async handleProveMessage(
    event: {
      messageHash: `0x${string}`;
      mmrRoot: `0x${string}`;
      message: {
        nonce: bigint;
        sender: `0x${string}`;
        data: `0x${string}`;
      };
    },
    rawProof: readonly `0x${string}`[],
    blockNumber: bigint,
  ): Promise<{ signature?: Signature; messageHash: Hash }> {
    const payer = this.config.payer;

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
        deriveIncomingMessagePda(this.config.bridgeProgram, event.messageHash),
      ]);

    const maybeMessage = await fetchMaybeIncomingMessage(
      this.rpc,
      messageAddress,
    );
    if (maybeMessage.exists) {
      return { messageHash: event.messageHash };
    }

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
    return { signature, messageHash: event.messageHash };
  }

  async handleExecuteMessage(messageHash: Hex): Promise<Signature> {
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
      throw new BridgeNotProvenError(
        `Message not found at ${messagePda}. Ensure it has been proven on Solana first.`,
        {},
      );
    }
    if (maybeIncomingMessage.data.executed) {
      throw new BridgeAlreadyExecutedError(
        "Message has already been executed",
        {},
      );
    }

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

    const signature = await this.buildAndSendTransaction(
      [relayMessageIxWithRemainingAccounts],
      payer,
    );
    return signature;
  }

  private messageCallAccounts(message: MessageCall) {
    const ixs = message.fields[0];
    if (ixs.length === 0) {
      throw new Error("Zero instructions in call message");
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
      throw new Error("Mint not found");
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

    return { bufferAddress: callBufferKeypair.address, signature };
  }

  /**
   * Appends data to an existing call buffer. Can be called multiple times
   * to fill the buffer in chunks that each fit within a single transaction.
   */
  async appendToCallBuffer(
    opts: AppendToCallBufferOpts,
  ): Promise<{ signature: Signature }> {
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
    return { signature };
  }

  /**
   * Closes a call buffer account and recovers the rent to the owner.
   * Use this to clean up if the bridge operation is aborted.
   */
  async closeCallBuffer(
    opts: CloseCallBufferOpts,
  ): Promise<{ signature: Signature }> {
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
    );
  }

  /**
   * Bridges SOL to Base with a call whose data comes from a pre-filled
   * call buffer. The call buffer is consumed (closed) by this operation.
   */
  async bridgeSolWithBufferedCall(
    opts: BufferedBridgeSolOpts,
  ): Promise<BridgeOpResult> {
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
    );
  }

  /**
   * Bridges SPL tokens to Base with a call whose data comes from a pre-filled
   * call buffer. The call buffer is consumed (closed) by this operation.
   */
  async bridgeSplWithBufferedCall(
    opts: BufferedBridgeSplOpts,
  ): Promise<BridgeOpResult> {
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
    );
  }

  private formatCall(call: EvmCall): FormattedCall;
  private formatCall(call?: EvmCall): FormattedCall | null;
  private formatCall(call?: EvmCall): FormattedCall | null {
    if (!call) return null;

    const callData = call.data.startsWith("0x")
      ? call.data.slice(2)
      : call.data;

    return {
      ty: call.ty ?? CallType.Call,
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
  ): Promise<BridgeOpResult> {
    const { payer, bridge, outgoingMessage, salt } =
      await this.setupMessage(idempotencyKey);
    const ixs = await builder({ payer, bridge, outgoingMessage, salt });
    return await this.submitMessage(
      ixs,
      outgoingMessage,
      payer,
      !!payForRelay,
      gasLimit,
    );
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
      throw new Error("Mint not found");
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
      ixs.push(
        await this.buildPayForRelayInstruction(
          outgoingMessage,
          payer,
          gasLimit,
        ),
      );
    }

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

    assertIsSendableTransaction(signedTransaction);
    assertIsTransactionWithBlockhashLifetime(signedTransaction);

    await this.sendAndConfirmTx(signedTransaction, {
      commitment: "confirmed",
    });

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
      throw new Error("ATA does not exist");
    }

    return maybeAta.address;
  }
}
