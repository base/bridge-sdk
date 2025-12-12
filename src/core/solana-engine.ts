import { existsSync } from "fs";
import {
  CallType,
  fetchBridge,
  fetchOutgoingMessage,
  getBridgeCallInstruction,
  getBridgeSolInstruction,
  getBridgeSplInstruction,
  getBridgeWrappedTokenInstruction,
  getWrapTokenInstruction,
  type OutgoingMessage,
  type WrapTokenInstructionDataArgs,
} from "@/clients/ts/src/bridge";
import type { BridgeConfig } from "@/types";
import { getIdlConstant } from "@/utils/bridge-idl.constants";
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
} from "@solana/kit";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { homedir } from "os";
import { join } from "path";
import {
  fetchCfg,
  getPayForRelayInstruction,
} from "@/clients/ts/src/base-relayer";
import { getRelayerIdlConstant } from "@/utils/relayer-idl.constants";
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
} from "@/constants";
import { type Logger, NOOP_LOGGER } from "@/utils/logger";

export interface SolanaEngineOpts {
  config: BridgeConfig;
  logger?: Logger;
}

export interface BridgeSolOpts {
  to: Address;
  amount: bigint;
  payForRelay?: boolean;
}

export interface BridgeSplOpts {
  to: Address;
  mint: string;
  remoteToken: string;
  amount: bigint;
  payForRelay?: boolean;
}

export interface BridgeWrappedOpts {
  to: Address;
  mint: string;
  amount: bigint;
  payForRelay?: boolean;
}

export interface BridgeCallOpts {
  to: Address;
  value: bigint;
  data: Hex;
  payForRelay?: boolean;
}

export interface WrapTokenOpts {
  remoteToken: string;
  name: string;
  symbol: string;
  decimals: number;
  scalerExponent: number;
  payForRelay?: boolean;
}

export class SolanaEngine {
  private readonly config: BridgeConfig;
  private readonly logger: Logger;
  private keypairSignerCache = new Map<string, KeyPairSigner>();
  private signer: KeyPairSigner | null = null;

  constructor(opts: SolanaEngineOpts) {
    this.config = opts.config;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  async getOutgoingMessage(
    pubkey: SolAddress
  ): Promise<Account<OutgoingMessage, string>> {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);
    return await fetchOutgoingMessage(rpc, pubkey);
  }

  async bridgeSol(opts: BridgeSolOpts): Promise<SolAddress> {
    return await this.executeBridgeOp(
      opts.payForRelay,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const solVaultAddress = await this.solVaultPubkey();
        this.logger.debug(`Sol Vault: ${solVaultAddress}`);
        this.logger.debug(`Amount: ${opts.amount}`);

        return [
          getBridgeSolInstruction(
            {
              // Accounts
              payer,
              from: payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              solVault: solVaultAddress,
              bridge: bridge.address,
              outgoingMessage,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,

              // Arguments
              outgoingMessageSalt: salt,
              to: toBytes(opts.to),
              amount: opts.amount,
              call: null,
            },
            { programAddress: this.config.solana.bridgeProgram }
          ),
        ];
      }
    );
  }

  async bridgeSpl(opts: BridgeSplOpts): Promise<SolAddress> {
    return await this.executeBridgeOp(
      opts.payForRelay,
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
        this.logger.debug(`Token Vault: ${tokenVaultAddress}`);

        return [
          getBridgeSplInstruction(
            {
              // Accounts
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

              // Arguments
              outgoingMessageSalt: salt,
              to: toBytes(opts.to),
              remoteToken: remoteTokenBytes,
              amount,
              call: null,
            },
            { programAddress: this.config.solana.bridgeProgram }
          ),
        ];
      }
    );
  }

  async bridgeWrapped(opts: BridgeWrappedOpts): Promise<SolAddress> {
    return await this.executeBridgeOp(
      opts.payForRelay,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        const { mint, fromTokenAccount, amount, tokenProgram } =
          await this.setupSpl(opts, payer);

        return [
          getBridgeWrappedTokenInstruction(
            {
              // Accounts
              payer,
              from: payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              mint,
              fromTokenAccount,
              bridge: bridge.address,
              outgoingMessage,
              tokenProgram,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,

              // Arguments
              outgoingMessageSalt: salt,
              to: toBytes(opts.to),
              amount,
              call: null,
            },
            { programAddress: this.config.solana.bridgeProgram }
          ),
        ];
      }
    );
  }

  async bridgeCall(opts: BridgeCallOpts): Promise<SolAddress> {
    return await this.executeBridgeOp(
      opts.payForRelay,
      async ({ payer, bridge, outgoingMessage, salt }) => {
        // Remove 0x prefix
        const callData = opts.data.startsWith("0x")
          ? opts.data.slice(2)
          : opts.data;

        return [
          getBridgeCallInstruction(
            {
              // Accounts
              payer,
              from: payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              bridge: bridge.address,
              outgoingMessage,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,

              // Arguments
              outgoingMessageSalt: salt,
              call: {
                ty: CallType.Call,
                to: toBytes(opts.to),
                value: opts.value,
                data: Buffer.from(callData, "hex"),
              },
            },
            { programAddress: this.config.solana.bridgeProgram }
          ),
        ];
      }
    );
  }

  async wrapToken(opts: WrapTokenOpts): Promise<SolAddress> {
    return await this.executeBridgeOp(
      opts.payForRelay,
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
        this.logger.debug(`Mint: ${mintAddress}`);

        return [
          getWrapTokenInstruction(
            {
              // Accounts
              payer,
              gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
              mint: mintAddress,
              bridge: bridge.address,
              outgoingMessage,
              tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
              systemProgram: SYSTEM_PROGRAM_ADDRESS,

              // Arguments
              ...instructionArgs,
            },
            { programAddress: this.config.solana.bridgeProgram }
          ),
        ];
      }
    );
  }

  private async executeBridgeOp(
    payForRelay: boolean | undefined,
    builder: (ctx: {
      payer: KeyPairSigner;
      bridge: Awaited<ReturnType<typeof fetchBridge>>;
      outgoingMessage: SolAddress;
      salt: Uint8Array;
    }) => Promise<Instruction[]>
  ): Promise<SolAddress> {
    const { payer, bridge, outgoingMessage, salt } = await this.setupMessage();

    const ixs = await builder({ payer, bridge, outgoingMessage, salt });

    return await this.submitMessage(ixs, outgoingMessage, payer, !!payForRelay);
  }

  private async setupMessage() {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    const payer = await this.resolvePayerKeypair(this.config.solana.payerKp);
    this.logger.debug(`Payer: ${payer.address}`);

    const [bridgeAccountAddress] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
    });
    this.logger.debug(`Bridge account: ${bridgeAccountAddress}`);

    // Fetch bridge state
    const bridge = await fetchBridge(rpc, bridgeAccountAddress);

    const { salt, pubkey: outgoingMessage } =
      await this.outgoingMessagePubkey();
    this.logger.debug(`Outgoing message: ${outgoingMessage}`);

    return { payer, bridge, outgoingMessage, salt };
  }

  private async setupSpl(
    opts: { mint: string; amount: bigint },
    payer: KeyPairSigner
  ) {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    const mint = address(opts.mint);
    this.logger.debug(`Mint: ${mint}`);

    const maybeMint = await fetchMaybeMint(rpc, mint);
    if (!maybeMint.exists) {
      throw new Error("Mint not found");
    }

    const amount = opts.amount;
    this.logger.debug(`Amount: ${amount}`);
    this.logger.debug(`Decimals: ${maybeMint.data.decimals}`);

    // Resolve from token account
    const fromTokenAccount = await this.resolveFromTokenAccount(
      "payer",
      payer.address,
      maybeMint
    );
    this.logger.debug(`From Token Account: ${fromTokenAccount}`);

    const tokenProgram = maybeMint.programAddress;
    this.logger.debug(`Token Program: ${tokenProgram}`);

    return { mint, fromTokenAccount, amount, tokenProgram };
  }

  private async submitMessage(
    ixs: Instruction[],
    outgoingMessage: SolAddress,
    payer: KeyPairSigner,
    payForRelay: boolean
  ): Promise<SolAddress> {
    if (payForRelay) {
      ixs.push(await this.buildPayForRelayInstruction(outgoingMessage, payer));
    }

    this.logger.debug("Sending transaction...");
    const signature = await this.buildAndSendTransaction(ixs, payer);
    this.logger.debug("Bridge SPL operation completed!");
    this.logger.info(`Signature: ${signature}`);
    return outgoingMessage;
  }

  private async resolvePayerKeypair(payerKpArg: string) {
    if (payerKpArg === "config") {
      this.logger.debug("Using Solana CLI config for payer keypair");
      return await this.getSolanaCliConfigKeypairSigner();
    }

    this.logger.debug(`Using custom payer keypair: ${payerKpArg}`);
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

  private async outgoingMessagePubkey() {
    const bytes = new Uint8Array(32);
    const s = crypto.getRandomValues(bytes);

    const [pubkey] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [
        Buffer.from(getIdlConstant("OUTGOING_MESSAGE_SEED")),
        Buffer.from(s),
      ],
    });

    return { salt: s, pubkey };
  }

  private async buildAndSendTransaction(
    instructions: Instruction[],
    payer: TransactionSigner
  ) {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    // Use URL API to safely parse the RPC URL
    const url = new URL(this.config.solana.rpcUrl);
    // Construct WSS URL: protocol is wss:, host and pathname from rpcUrl
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
    payer: KeyPairSigner<string>
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
    this.logger.debug(`Message To Relay: ${messageToRelay}`);

    return getPayForRelayInstruction(
      {
        // Accounts
        payer,
        cfg: cfgAddress,
        gasFeeReceiver: cfg.data.gasConfig.gasFeeReceiver,
        messageToRelay,
        mtrSalt: salt,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,

        // Arguments
        outgoingMessage: outgoingMessage,
        gasLimit: DEFAULT_RELAY_GAS_LIMIT,
      },
      { programAddress: this.config.solana.relayerProgram }
    );
  }

  private async mtrPubkey(baseRelayerProgram: SolAddress, salt?: Uint8Array) {
    const bytes = new Uint8Array(32);
    const s = salt ?? crypto.getRandomValues(bytes);

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
