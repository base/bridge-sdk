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
} from "@/constants";

export interface SolanaEngineOpts {
  config: BridgeConfig;
}

export interface BridgeSolOpts {
  to: Address;
  amount: number;
  payForRelay?: boolean;
}

export interface BridgeSplOpts {
  to: Address;
  mint: string;
  remoteToken: string;
  amount: number;
  payForRelay?: boolean;
}

export interface BridgeWrappedOpts {
  to: Address;
  mint: string;
  amount: number;
  payForRelay?: boolean;
}

export interface BridgeCallOpts {
  to: Address;
  value: number;
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
  private keypairSignerCache = new Map<string, KeyPairSigner>();
  private signer: KeyPairSigner | null = null;

  constructor(opts: SolanaEngineOpts) {
    this.config = opts.config;
  }

  async getOutgoingMessage(
    pubkey: SolAddress
  ): Promise<Account<OutgoingMessage, string>> {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);
    return await fetchOutgoingMessage(rpc, pubkey);
  }

  async bridgeSol(opts: BridgeSolOpts): Promise<SolAddress> {
    try {
      const { payer, bridge, outgoingMessage, salt } =
        await this.setupMessage();

      const solVaultAddress = await this.solVaultPubkey();
      console.log(`Sol Vault: ${solVaultAddress}`);

      // Calculate scaled amount (amount * 10^decimals)
      const scaledAmount = BigInt(Math.floor(opts.amount * Math.pow(10, 9)));
      console.log(`Amount: ${opts.amount}`);
      console.log(`Scaled amount: ${scaledAmount}`);

      const ixs: Instruction[] = [
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
            amount: scaledAmount,
            call: null,
          },
          { programAddress: this.config.solana.bridgeProgram }
        ),
      ];

      return await this.submitMessage(
        ixs,
        outgoingMessage,
        payer,
        !!opts.payForRelay
      );
    } catch (error) {
      console.error("Bridge SOL operation failed:", { error });
      throw error;
    }
  }

  async bridgeSpl(opts: BridgeSplOpts): Promise<SolAddress> {
    try {
      const { payer, bridge, outgoingMessage, salt } =
        await this.setupMessage();

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
      console.log(`Token Vault: ${tokenVaultAddress}`);

      const ixs: Instruction[] = [
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

      return await this.submitMessage(
        ixs,
        outgoingMessage,
        payer,
        !!opts.payForRelay
      );
    } catch (error) {
      console.error("Bridge SPL operation failed:", error);
      throw error;
    }
  }

  async bridgeWrapped(opts: BridgeWrappedOpts): Promise<SolAddress> {
    try {
      const { payer, bridge, outgoingMessage, salt } =
        await this.setupMessage();

      const { mint, fromTokenAccount, amount, tokenProgram } =
        await this.setupSpl(opts, payer);

      const ixs: Instruction[] = [
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

      return await this.submitMessage(
        ixs,
        outgoingMessage,
        payer,
        !!opts.payForRelay
      );
    } catch (error) {
      console.error("Bridge Wrapped Token operation failed:", error);
      throw error;
    }
  }

  async bridgeCall(opts: BridgeCallOpts): Promise<SolAddress> {
    try {
      const { payer, bridge, outgoingMessage, salt } =
        await this.setupMessage();

      // Remove 0x prefix
      const callData = opts.data.startsWith("0x")
        ? opts.data.slice(2)
        : opts.data;

      // Build bridge call instruction
      const ixs: Instruction[] = [
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
              value: BigInt(Math.floor(opts.value * 1e18)), // Convert ETH to wei
              data: Buffer.from(callData, "hex"),
            },
          },
          { programAddress: this.config.solana.bridgeProgram }
        ),
      ];

      return await this.submitMessage(
        ixs,
        outgoingMessage,
        payer,
        !!opts.payForRelay
      );
    } catch (error) {
      console.error("Bridge call failed:", error);
      throw error;
    }
  }

  async wrapToken(opts: WrapTokenOpts): Promise<SolAddress> {
    try {
      const { payer, bridge, outgoingMessage, salt } =
        await this.setupMessage();

      // Instruction arguments
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

      const nameLengthLeBytes = getU64Encoder({ endian: Endian.Little }).encode(
        encodedName.length
      );

      const symbolLengthLeBytes = getU64Encoder({
        endian: Endian.Little,
      }).encode(encodedSymbol.length);

      // Calculate metadata hash
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
      console.log(`Mint: ${mintAddress}`);

      // Build wrap token instruction
      const ixs: Instruction[] = [
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

      return await this.submitMessage(
        ixs,
        outgoingMessage,
        payer,
        !!opts.payForRelay
      );
    } catch (error) {
      console.error("Token wrap failed:", error);
      throw error;
    }
  }

  private async setupMessage() {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    const payer = await this.resolvePayerKeypair(this.config.solana.payerKp);
    console.log(`Payer: ${payer.address}`);

    const [bridgeAccountAddress] = await getProgramDerivedAddress({
      programAddress: this.config.solana.bridgeProgram,
      seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
    });
    console.log(`Bridge account: ${bridgeAccountAddress}`);

    // Fetch bridge state
    const bridge = await fetchBridge(rpc, bridgeAccountAddress);

    const { salt, pubkey: outgoingMessage } =
      await this.outgoingMessagePubkey();
    console.log(`Outgoing message: ${outgoingMessage}`);

    return { payer, bridge, outgoingMessage, salt };
  }

  private async setupSpl(opts: BridgeWrappedOpts, payer: KeyPairSigner) {
    const rpc = createSolanaRpc(this.config.solana.rpcUrl);

    const mint = address(opts.mint);
    console.log(`Mint: ${mint}`);

    const maybeMint = await fetchMaybeMint(rpc, mint);
    if (!maybeMint.exists) {
      throw new Error("Mint not found");
    }

    // Calculate scaled amount (amount * 10^decimals)
    const amount = BigInt(
      Math.floor(opts.amount * Math.pow(10, maybeMint.data.decimals))
    );
    console.log(`Amount: ${opts.amount}`);
    console.log(`Decimals: ${maybeMint.data.decimals}`);
    console.log(`Scaled amount: ${amount}`);

    // Resolve from token account
    const fromTokenAccount = await this.resolveFromTokenAccount(
      "payer",
      payer.address,
      maybeMint
    );
    console.log(`From Token Account: ${fromTokenAccount}`);

    const tokenProgram = maybeMint.programAddress;
    console.log(`Token Program: ${tokenProgram}`);

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

    console.log("Sending transaction...");
    const signature = await this.buildAndSendTransaction(ixs, payer);
    console.log("Bridge SPL operation completed!");
    console.log(`Signature: ${signature}`);
    return outgoingMessage;
  }

  private async resolvePayerKeypair(payerKpArg: string) {
    if (payerKpArg === "config") {
      console.log("Using Solana CLI config for payer keypair");
      return await this.getSolanaCliConfigKeypairSigner();
    }

    console.log(`Using custom payer keypair: ${payerKpArg}`);
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
    const rpcSubscriptions = createSolanaRpcSubscriptions(
      `wss://${this.config.solana.rpcUrl.replace("https://", "")}`
    );

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
    console.log(`Message To Relay: ${messageToRelay}`);

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
        gasLimit: 200_000n,
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
