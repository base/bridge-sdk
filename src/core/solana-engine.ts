import { existsSync } from "fs";
import { fetchBridge, getBridgeSolInstruction } from "@/clients/ts/src/bridge";
import type { BridgeConfig } from "@/types";
import { getIdlConstant } from "@/utils/bridge-idl.constants";
import { createLogger, type Logger } from "@/utils/logger";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
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
} from "@solana/kit";
import { toBytes, type Address } from "viem";
import { homedir } from "os";
import { join } from "path";
import {
  fetchCfg,
  getPayForRelayInstruction,
} from "@/clients/ts/src/base-relayer";
import { getRelayerIdlConstant } from "@/utils/relayer-idl.constants";

export interface SolanaEngineOpts {
  config: BridgeConfig;
  logger?: Logger;
}

export interface BridgeSolOpts {
  to: Address;
  amount: number;
  payForRelay?: boolean;
}

export class SolanaEngine {
  private readonly config: BridgeConfig;
  private readonly logger: Logger;
  private keypairSignerCache = new Map<string, KeyPairSigner>();
  private signer: KeyPairSigner | null = null;

  constructor(opts: SolanaEngineOpts) {
    this.config = opts.config;
    this.logger = opts.logger ?? createLogger({ namespace: "solana-engine" });
  }

  async bridgeSol(opts: BridgeSolOpts): Promise<void> {
    try {
      const rpc = createSolanaRpc(this.config.solRpcUrl);

      const payer = await this.resolvePayerKeypair(this.config.payerKp);
      this.logger.info(`Payer: ${payer.address}`);

      const [bridgeAccountAddress] = await getProgramDerivedAddress({
        programAddress: this.config.bridgeProgram,
        seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
      });
      this.logger.info(`Bridge account: ${bridgeAccountAddress}`);

      const bridge = await fetchBridge(rpc, bridgeAccountAddress);

      const solVaultAddress = await this.solVaultPubkey();
      this.logger.info(`Sol Vault: ${solVaultAddress}`);

      // Calculate scaled amount (amount * 10^decimals)
      const scaledAmount = BigInt(Math.floor(opts.amount * Math.pow(10, 9)));
      this.logger.info(`Amount: ${opts.amount}`);
      this.logger.info(`Scaled amount: ${scaledAmount}`);

      const { salt, pubkey: outgoingMessage } =
        await this.outgoingMessagePubkey();
      this.logger.info(`Outgoing message: ${outgoingMessage}`);

      const ixs: Instruction[] = [
        getBridgeSolInstruction(
          {
            // Accounts
            payer,
            from: payer,
            gasFeeReceiver: bridge.data.gasConfig.gasFeeReceiver,
            solVault: solVaultAddress,
            bridge: bridgeAccountAddress,
            outgoingMessage,
            systemProgram: SYSTEM_PROGRAM_ADDRESS,

            // Arguments
            outgoingMessageSalt: salt,
            to: toBytes(opts.to),
            amount: scaledAmount,
            call: null,
          },
          { programAddress: this.config.bridgeProgram }
        ),
      ];

      if (opts.payForRelay) {
        ixs.push(
          await this.buildPayForRelayInstruction(outgoingMessage, payer)
        );
      }

      this.logger.info("Sending transaction...");
      const signature = await this.buildAndSendTransaction(ixs, payer);
      this.logger.info("Bridge SOL operation completed!");
      this.logger.info(`Signature: ${signature}`);

      // if (args.payForRelay) {
      //   await monitorMessageExecution(args.deployEnv, outgoingMessage);
      // } else {
      //   await relayMessageToBase(args.deployEnv, outgoingMessage);
      // }
    } catch (error) {
      this.logger.error("Bridge SOL operation failed:", error);
      throw error;
    }
  }

  private async resolvePayerKeypair(payerKpArg: string) {
    if (payerKpArg === "config") {
      this.logger.info("Using Solana CLI config for payer keypair");
      return await this.getSolanaCliConfigKeypairSigner();
    }

    this.logger.info(`Using custom payer keypair: ${payerKpArg}`);
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
      programAddress: this.config.bridgeProgram,
      seeds: [Buffer.from(getIdlConstant("SOL_VAULT_SEED"))],
    });

    return pubkey;
  }

  private async outgoingMessagePubkey() {
    const bytes = new Uint8Array(32);
    const s = crypto.getRandomValues(bytes);

    const [pubkey] = await getProgramDerivedAddress({
      programAddress: this.config.bridgeProgram,
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
    const rpc = createSolanaRpc(this.config.solRpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(
      `wss://${this.config.solRpcUrl.replace("https://", "")}`
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
    const rpc = createSolanaRpc(this.config.solRpcUrl);

    const [cfgAddress] = await getProgramDerivedAddress({
      programAddress: this.config.relayerProgram,
      seeds: [Buffer.from(getRelayerIdlConstant("CFG_SEED"))],
    });

    const cfg = await fetchCfg(rpc, cfgAddress);

    const { salt, pubkey: messageToRelay } = await this.mtrPubkey(
      this.config.relayerProgram
    );
    this.logger.info(`Message To Relay: ${messageToRelay}`);

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
      { programAddress: this.config.relayerProgram }
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
}
