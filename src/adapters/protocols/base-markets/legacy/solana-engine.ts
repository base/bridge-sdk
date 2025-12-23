import { existsSync } from "fs";
import {
  CallType,
  fetchBridge,
  fetchMaybeIncomingMessage,
  fetchMaybeOutgoingMessage,
  fetchOutgoingMessage,
  getBridgeCallInstruction,
  getBridgeSolInstruction,
  getBridgeSplInstruction,
  getBridgeWrappedTokenInstruction,
  getProveMessageInstruction,
  getRelayMessageInstruction,
  getWrapTokenInstruction,
  type Ix,
  type OutgoingMessage,
  type WrapTokenInstructionDataArgs,
} from "../../../../clients/ts/src/bridge";
import type {
  BridgeConfig,
  MessageCall,
  MessageTransfer,
  MessageTransferSol,
  MessageTransferSpl,
  MessageTransferWrappedToken,
  Rpc,
} from "./types";
import { getIdlConstant } from "../../../../utils/bridge-idl.constants";
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
  type Address as SolAddress,
  type Account,
  address,
  getBase58Encoder,
  getU8Codec,
  getU64Encoder,
  Endian,
  AccountRole,
  type AccountMeta,
  getBase58Codec,
  type Signature,
} from "@solana/kit";
import {
  keccak256,
  toBytes,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { homedir } from "os";
import { join } from "path";
import {
  fetchCfg,
  getPayForRelayInstruction,
} from "../../../../clients/ts/src/base-relayer";
import { getRelayerIdlConstant } from "../../../../utils/relayer-idl.constants";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  fetchMaybeMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  type Mint,
} from "@solana-program/token";
import {
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  DEFAULT_RELAY_GAS_LIMIT,
  DEFAULT_MONITOR_POLL_INTERVAL_MS,
  DEFAULT_MONITOR_TIMEOUT_MS,
} from "./constants";
import { sleep } from "../../../../utils/time";
import type { CallParams } from "./types";

export interface SolanaEngineOpts {
  config: BridgeConfig;
}

export interface BridgeSolOpts {
  to: Address;
  amount: bigint;
  payForRelay?: boolean;
  call?: CallParams;
  gasLimit?: bigint;
  idempotencyKey?: string;
}

export interface BridgeSplOpts {
  to: Address;
  mint: string;
  remoteToken: string;
  amount: bigint;
  payForRelay?: boolean;
  call?: CallParams;
  gasLimit?: bigint;
  idempotencyKey?: string;
}

export interface BridgeWrappedOpts {
  to: Address;
  mint: string;
  amount: bigint;
  payForRelay?: boolean;
  call?: CallParams;
  gasLimit?: bigint;
  idempotencyKey?: string;
}

export interface BridgeCallOpts extends CallParams {
  payForRelay?: boolean;
  gasLimit?: bigint;
  idempotencyKey?: string;
}

export interface WrapTokenOpts {
  remoteToken: string;
  name: string;
  symbol: string;
  decimals: number;
  scalerExponent: number;
  payForRelay?: boolean;
  idempotencyKey?: string;
}

export class SolanaEngine {
  private readonly config: BridgeConfig;
  private keypairSignerCache = new Map<string, KeyPairSigner>();
  private signer: KeyPairSigner | null = null;

  constructor(opts: SolanaEngineOpts) {
    this.config = opts.config;
  }

  async getOutgoingMessage(
    pubkey: SolAddress,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<Account<OutgoingMessage, string>> {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);
    const timeoutMs = options.timeoutMs ?? DEFAULT_MONITOR_TIMEOUT_MS;
    const pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS;
    const startTime = Date.now();

    while (Date.now() - startTime <= timeoutMs) {
      const maybeAccount = await fetchMaybeOutgoingMessage(rpc, pubkey);
      if (maybeAccount.exists) {
        return maybeAccount as Account<OutgoingMessage, string>;
      }
      await sleep(pollIntervalMs);
    }

    return await fetchOutgoingMessage(rpc, pubkey);
  }

  async bridgeSol(opts: BridgeSolOpts): Promise<SolAddress> {
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
            { programAddress: this.config.solana.bridgeProgram }
          ),
        ];
      },
      opts.idempotencyKey
    );
  }

  async bridgeSpl(opts: BridgeSplOpts): Promise<SolAddress> {
    return await this.executeBridgeOp(
      opts.payForRelay,
      opts.gasLimit,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const { mint, fromTokenAccount, amount, tokenProgram } =
          await this.setupSpl(opts, payer);

        const remoteTokenBytes = toBytes(opts.remoteToken);
        const mintBytes = getBase58Encoder().encode(mint);

        const [tokenVaultAddress] = await getProgramDerivedAddress({
          programAddress: this.config.solana.bridgeProgram,
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
            { programAddress: this.config.solana.bridgeProgram }
          ),
        ];
      },
      opts.idempotencyKey
    );
  }

  async bridgeWrapped(opts: BridgeWrappedOpts): Promise<SolAddress> {
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
            { programAddress: this.config.solana.bridgeProgram }
          ),
        ];
      },
      opts.idempotencyKey
    );
  }

  async bridgeCall(opts: BridgeCallOpts): Promise<SolAddress> {
    return await this.executeBridgeOp(
      opts.payForRelay,
      opts.gasLimit,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const callData = opts.data.startsWith("0x")
          ? opts.data.slice(2)
          : opts.data;

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
              call: {
                ty: opts.ty ?? CallType.Call,
                to: toBytes(opts.to),
                value: opts.value,
                data: Buffer.from(callData, "hex"),
              },
            },
            { programAddress: this.config.solana.bridgeProgram }
          ),
        ];
      },
      opts.idempotencyKey
    );
  }

  async wrapToken(opts: WrapTokenOpts): Promise<SolAddress> {
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
          ])
        );

        const decimalsSeed = Buffer.from(
          getU8Codec().encode(instructionArgs.decimals)
        );

        const [mintAddress] = await getProgramDerivedAddress({
          programAddress: this.config.solana.bridgeProgram,
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
            { programAddress: this.config.solana.bridgeProgram }
          ),
        ];
      },
      opts.idempotencyKey
    );
  }

  async getLatestBaseBlockNumber(): Promise<bigint> {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    const [bridgeAddress] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
    });

    const bridge = await fetchBridge(rpc, bridgeAddress);
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
    blockNumber: bigint
  ): Promise<{ signature?: Signature; messageHash: Hash }> {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    const payer = await this.resolvePayerKeypair(this.config.solana.payerKp);

    const [bridgeAddress] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
    });

    const [outputRootAddress] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [
        Buffer.from(getIdlConstant("OUTPUT_ROOT_SEED")),
        getU64Encoder({ endian: Endian.Little }).encode(blockNumber),
      ],
    });

    const [messageAddress] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [
        Buffer.from(getIdlConstant("INCOMING_MESSAGE_SEED")),
        toBytes(event.messageHash),
      ],
    });

    const maybeMessage = await fetchMaybeIncomingMessage(rpc, messageAddress);
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
      { programAddress: this.config.solana.bridgeProgram }
    );

    const signature = await this.buildAndSendTransaction([ix], payer);
    return { signature, messageHash: event.messageHash };
  }

  async handleExecuteMessage(messageHash: Hex): Promise<Signature> {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    const payer = await this.resolvePayerKeypair(this.config.solana.payerKp);

    const [messagePda] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [
        Buffer.from(getIdlConstant("INCOMING_MESSAGE_SEED")),
        toBytes(messageHash),
      ],
    });

    const maybeIncomingMessage = await fetchMaybeIncomingMessage(
      rpc,
      messagePda
    );
    if (!maybeIncomingMessage.exists) {
      throw new Error(
        `Message not found at ${messagePda}. Ensure it has been proven on Solana first.`
      );
    }
    const incomingMessage = maybeIncomingMessage;

    if (incomingMessage.data.executed) {
      throw new Error("Message has already been executed");
    }

    const [bridgeCpiAuthorityPda] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [
        Buffer.from(getIdlConstant("BRIDGE_CPI_AUTHORITY_SEED")),
        Buffer.from(incomingMessage.data.sender),
      ],
    });

    const message = incomingMessage.data.message;

    let remainingAccounts =
      message.__kind === "Call"
        ? await this.messageCallAccounts(message)
        : await this.messageTransferAccounts(
            rpc,
            message,
            this.config.solana.bridgeProgram
          );

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

    const [bridgeAccountAddress] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
    });

    const relayMessageIx = getRelayMessageInstruction(
      { message: messagePda, bridge: bridgeAccountAddress },
      { programAddress: this.config.solana.bridgeProgram }
    );

    const relayMessageIxWithRemainingAccounts: Instruction = {
      programAddress: relayMessageIx.programAddress,
      accounts: [...relayMessageIx.accounts, ...remainingAccounts],
      data: relayMessageIx.data,
    };

    const signature = await this.buildAndSendTransaction(
      [relayMessageIxWithRemainingAccounts],
      payer
    );
    return signature;
  }

  private async messageCallAccounts(message: MessageCall) {
    const ixs = message.fields[0];
    if (ixs.length === 0) {
      throw new Error("Zero instructions in call message");
    }

    return [
      ...(await this.getIxAccounts(ixs)),
      ...ixs.map((i: Ix) => ({
        address: i.programId,
        role: AccountRole.READONLY,
      })),
    ];
  }

  private async messageTransferAccounts(
    rpc: Rpc,
    message: MessageTransfer,
    solanaBridge: SolAddress
  ) {
    const remainingAccounts: Array<AccountMeta> =
      message.transfer.__kind === "Sol"
        ? await this.messageTransferSolAccounts(message.transfer, solanaBridge)
        : message.transfer.__kind === "Spl"
        ? await this.messageTransferSplAccounts(
            rpc,
            message.transfer,
            solanaBridge
          )
        : await this.messageTransferWrappedTokenAccounts(message.transfer);

    const ixs = message.ixs;

    remainingAccounts.push(
      ...(await this.getIxAccounts(ixs)),
      ...ixs.map((i: Ix) => ({
        address: i.programId,
        role: AccountRole.READONLY,
      }))
    );

    return remainingAccounts;
  }

  private async messageTransferSolAccounts(
    message: MessageTransferSol,
    solanaBridge: SolAddress
  ) {
    const { to } = message.fields[0];

    const [solVaultPda] = await getProgramDerivedAddress({
      programAddress: solanaBridge,
      seeds: [Buffer.from(getIdlConstant("SOL_VAULT_SEED"))],
    });

    return [
      { address: solVaultPda, role: AccountRole.WRITABLE },
      { address: to, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ];
  }

  private async messageTransferSplAccounts(
    rpc: Rpc,
    message: MessageTransferSpl,
    solanaBridge: SolAddress
  ) {
    const { remoteToken, localToken, to } = message.fields[0];

    const [tokenVaultPda] = await getProgramDerivedAddress({
      programAddress: solanaBridge,
      seeds: [
        Buffer.from(getIdlConstant("TOKEN_VAULT_SEED")),
        getBase58Codec().encode(localToken),
        Buffer.from(remoteToken),
      ],
    });

    const mint = await rpc.getAccountInfo(localToken).send();
    if (!mint.value) {
      throw new Error("Mint not found");
    }

    return [
      { address: localToken, role: AccountRole.READONLY },
      { address: tokenVaultPda, role: AccountRole.WRITABLE },
      { address: to, role: AccountRole.WRITABLE },
      { address: mint.value!.owner, role: AccountRole.READONLY },
    ];
  }

  private async messageTransferWrappedTokenAccounts(
    message: MessageTransferWrappedToken
  ) {
    const { localToken, to } = message.fields[0];

    return [
      { address: localToken, role: AccountRole.WRITABLE },
      { address: to, role: AccountRole.WRITABLE },
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ];
  }

  private async getIxAccounts(ixs: Ix[]) {
    const allIxsAccounts = [];

    for (const ix of ixs) {
      const ixAccounts = await Promise.all(
        ix.accounts.map(async (acc) => {
          return {
            address: acc.pubkey,
            role: acc.isWritable
              ? acc.isSigner
                ? AccountRole.WRITABLE_SIGNER
                : AccountRole.WRITABLE
              : acc.isSigner
              ? AccountRole.READONLY_SIGNER
              : AccountRole.READONLY,
          };
        })
      );

      allIxsAccounts.push(...ixAccounts);
    }

    return allIxsAccounts;
  }

  private formatCall(call?: CallParams) {
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
    idempotencyKey?: string
  ): Promise<SolAddress> {
    const { payer, bridge, outgoingMessage, salt } = await this.setupMessage(
      idempotencyKey
    );
    const ixs = await builder({ payer, bridge, outgoingMessage, salt });
    return await this.submitMessage(
      ixs,
      outgoingMessage,
      payer,
      !!payForRelay,
      gasLimit
    );
  }

  private async setupMessage(idempotencyKey?: string) {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);
    const payer = await this.resolvePayerKeypair(this.config.solana.payerKp);

    const [bridgeAccountAddress] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
    });

    const bridge = await fetchBridge(rpc, bridgeAccountAddress);

    const { salt, pubkey: outgoingMessage } = await this.outgoingMessagePubkey(
      idempotencyKey
    );
    return { payer, bridge, outgoingMessage, salt };
  }

  private async setupSpl(
    opts: { mint: string; amount: bigint },
    payer: KeyPairSigner
  ) {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    const mint = address(opts.mint);
    const maybeMint = await fetchMaybeMint(rpc, mint);
    if (!maybeMint.exists) {
      throw new Error("Mint not found");
    }

    const amount = opts.amount;

    const fromTokenAccount = await this.resolveFromTokenAccount(
      "payer",
      payer.address,
      maybeMint
    );
    const tokenProgram = maybeMint.programAddress;

    return { mint, fromTokenAccount, amount, tokenProgram };
  }

  private async submitMessage(
    ixs: Instruction[],
    outgoingMessage: SolAddress,
    payer: KeyPairSigner,
    payForRelay: boolean,
    gasLimit?: bigint
  ): Promise<SolAddress> {
    if (payForRelay) {
      ixs.push(
        await this.buildPayForRelayInstruction(outgoingMessage, payer, gasLimit)
      );
    }

    await this.buildAndSendTransaction(ixs, payer);
    return outgoingMessage;
  }

  private async resolvePayerKeypair(payerKpArg: string) {
    if (payerKpArg === "config") {
      return await this.getSolanaCliConfigKeypairSigner();
    }

    return await this.getKeypairSignerFromPath(payerKpArg);
  }

  private async getSolanaCliConfigKeypairSigner() {
    if (this.signer) {
      return this.signer;
    }

    const homeDir = homedir();
    const keypairPath = join(homeDir, ".config/solana/id.json");
    if (!existsSync(keypairPath)) {
      throw new Error(`Solana CLI config keypair not found at: ${keypairPath}`);
    }

    this.signer = await this.getKeypairSignerFromPath(keypairPath);
    return this.signer;
  }

  private async getKeypairSignerFromPath(keypairPath: string) {
    if (this.keypairSignerCache.has(keypairPath)) {
      return this.keypairSignerCache.get(keypairPath)!;
    }

    if (!existsSync(keypairPath)) {
      throw new Error(`Keypair not found at: ${keypairPath}`);
    }

    const keypairBytes = new Uint8Array(await Bun.file(keypairPath).json());
    const keypair = await createKeyPairFromBytes(keypairBytes);
    const signer = await createSignerFromKeyPair(keypair);
    this.keypairSignerCache.set(keypairPath, signer);

    return signer;
  }

  private async solVaultPubkey() {
    const [pubkey] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
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
      programAddress: this.config.solana.bridgeProgram,
      seeds: [
        Buffer.from(getIdlConstant("OUTGOING_MESSAGE_SEED")),
        Buffer.from(salt),
      ],
    });

    return { salt, pubkey };
  }

  private async buildAndSendTransaction(
    instructions: Instruction[],
    payer: TransactionSigner
  ) {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    const url = new URL(this.config.solana.rpcUrl);
    const wssUrl = `wss://${url.host}${url.pathname}${url.search}`;
    const rpcSubscriptions = createSolanaRpcSubscriptions(wssUrl);

    const sendAndConfirmTx = sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions,
    });

    const blockhash = await rpc.getLatestBlockhash().send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(payer.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash.value, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
      (tx) => addSignersToTransactionMessage([payer], tx)
    );

    const signedTransaction = await signTransactionMessageWithSigners(
      transactionMessage
    );
    const signature = getSignatureFromTransaction(signedTransaction);

    assertIsSendableTransaction(signedTransaction);
    assertIsTransactionWithBlockhashLifetime(signedTransaction);

    await sendAndConfirmTx(signedTransaction, {
      commitment: "confirmed",
    });

    return signature;
  }

  private async buildPayForRelayInstruction(
    outgoingMessage: SolAddress,
    payer: KeyPairSigner<string>,
    gasLimit?: bigint
  ) {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    const [cfgAddress] = await getProgramDerivedAddress({
      programAddress: this.config.solana.relayerProgram,
      seeds: [Buffer.from(getRelayerIdlConstant("CFG_SEED"))],
    });

    const cfg = await fetchCfg(rpc, cfgAddress);

    const { salt, pubkey: messageToRelay } = await this.mtrPubkey(
      this.config.solana.relayerProgram
    );

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
      { programAddress: this.config.solana.relayerProgram }
    );
  }

  private async mtrPubkey(baseRelayerProgram: SolAddress, salt?: Uint8Array) {
    const s = salt ?? crypto.getRandomValues(new Uint8Array(32));

    const [pubkey] = await getProgramDerivedAddress({
      programAddress: baseRelayerProgram,
      seeds: [Buffer.from(getRelayerIdlConstant("MTR_SEED")), Buffer.from(s)],
    });

    return { salt: s, pubkey };
  }

  private async resolveFromTokenAccount(
    from: string,
    payerAddress: SolAddress,
    mint: Account<Mint>
  ) {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    if (from !== "payer") {
      const customAddress = address(from);
      const maybeToken = await fetchMaybeToken(rpc, customAddress);
      if (!maybeToken.exists) {
        throw new Error("Token account does not exist");
      }

      return maybeToken.address;
    }

    const [ataAddress] = await findAssociatedTokenPda(
      {
        owner: payerAddress,
        tokenProgram: mint.programAddress,
        mint: mint.address,
      },
      { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS }
    );

    const maybeAta = await fetchMaybeToken(rpc, ataAddress);
    if (!maybeAta.exists) {
      throw new Error("ATA does not exist");
    }

    return maybeAta.address;
  }
}
