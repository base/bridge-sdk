import { existsSync } from "fs";
import {
  fetchBridge,
  fetchOutgoingMessage,
  getBridgeSolInstruction,
  type OutgoingMessage,
} from "@/clients/ts/src/bridge";
import type { BridgeConfig } from "@/types";
import { getIdlConstant } from "@/utils/bridge-idl.constants";
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
  type Account,
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
}

export interface BridgeSolOpts {
  to: Address;
  amount: number;
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
      const rpc = createSolanaRpc(this.config.solana.rpcUrl);

      const payer = await this.resolvePayerKeypair(this.config.solana.payerKp);
      console.log(`Payer: ${payer.address}`);

      const [bridgeAccountAddress] = await getProgramDerivedAddress({
        programAddress: this.config.solana.bridgeProgram,
        seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
      });
      console.log(`Bridge account: ${bridgeAccountAddress}`);

      const bridge = await fetchBridge(rpc, bridgeAccountAddress);

      const solVaultAddress = await this.solVaultPubkey();
      console.log(`Sol Vault: ${solVaultAddress}`);

      // Calculate scaled amount (amount * 10^decimals)
      const scaledAmount = BigInt(Math.floor(opts.amount * Math.pow(10, 9)));
      console.log(`Amount: ${opts.amount}`);
      console.log(`Scaled amount: ${scaledAmount}`);

      const { salt, pubkey: outgoingMessage } =
        await this.outgoingMessagePubkey();
      console.log(`Outgoing message: ${outgoingMessage}`);

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
          { programAddress: this.config.solana.bridgeProgram }
        ),
      ];

      if (opts.payForRelay) {
        ixs.push(
          await this.buildPayForRelayInstruction(outgoingMessage, payer)
        );
      }

      console.log("Sending transaction...");
      const signature = await this.buildAndSendTransaction(ixs, payer);
      console.log("Bridge SOL operation completed!");
      console.log(`Signature: ${signature}`);
      return outgoingMessage;
    } catch (error) {
      console.error("Bridge SOL operation failed:", { error });
      throw error;
    }
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
}
