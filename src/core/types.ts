import type { Address as SolAddress } from "@solana/kit";
import type { Hex } from "viem";
import type { Logger } from "../utils/logger";

/**
 * Chain identifier. v1 recommends CAIP-2 style strings:
 * - EVM: "eip155:<chainId>" (e.g. "eip155:8453")
 * - Solana: "solana:<cluster>" (e.g. "solana:mainnet", "solana:devnet")
 */
export type ChainId = string;

export interface ChainRef {
  id: ChainId;
  /** Optional human label. */
  name?: string;
}

export interface BridgeRoute {
  sourceChain: ChainId;
  destinationChain: ChainId;
}

export type BridgeContext = { route: BridgeRoute; chain: ChainId };

/**
 * Chain-specific address string. The chain is implied by the surrounding context
 * (e.g., a `BridgeRoute`'s source/destination chain).
 */
export type ChainAddress = string;

export type AssetRef =
  | { kind: "native" } // e.g., SOL on Solana, ETH on an EVM chain
  | { kind: "token"; address: string } // mint for Solana, ERC20 for EVM
  | { kind: "wrapped"; address: string }; // protocol-specific wrapped token id

/**
 * EVM call type matching the on-chain `CallType` enum.
 * - `Call` (0): Regular external call (`address.call{value}(data)`)
 * - `DelegateCall` (1): Delegate call (`address.delegatecall(data)`); value must be 0
 * - `Create` (2): Deploy via `CREATE` opcode; `to` must be zero address
 * - `Create2` (3): Deploy via `CREATE2` opcode; `to` must be zero address;
 *   `data` must be `abi.encode(bytes32 salt, bytes creationCode)`
 */
export enum EvmCallType {
  Call = 0,
  DelegateCall = 1,
  Create = 2,
  Create2 = 3,
}

export interface EvmCall {
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
  /**
   * Call type determining how the call is executed on-chain.
   * Defaults to `EvmCallType.Call` (0) when omitted.
   */
  ty?: EvmCallType;
}

/**
 * Solana account metadata for instruction execution.
 */
export interface SolanaAccountMeta {
  /** Base58-encoded Solana public key */
  pubkey: string;
  /** Whether the account is writable */
  isWritable: boolean;
  /** Whether the account is a signer (will be signed by bridge CPI authority) */
  isSigner: boolean;
}

/**
 * Solana instruction to be executed on the destination chain.
 * Represents a CPI call that will be invoked by the bridge program.
 */
export interface SolanaInstruction {
  /** Base58-encoded program ID */
  programId: string;
  /** Account metas for the instruction */
  accounts: SolanaAccountMeta[];
  /** Raw instruction data as Uint8Array or hex string */
  data: Uint8Array | `0x${string}`;
}

/**
 * SolanaCall represents one or more Solana instructions to execute
 * on the destination SVM chain via bridge CPI.
 */
export interface SolanaCall {
  /** Instructions to execute via bridge CPI */
  instructions: SolanaInstruction[];
}

/**
 * Discriminated union for destination-chain calls.
 * The kind must match the destination chain type:
 * - "evm": For routes where destination is an EVM chain (e.g., SVM -> Base)
 * - "solana": For routes where destination is Solana (e.g., Base -> SVM)
 */
export type DestinationCall =
  | { kind: "evm"; call: EvmCall }
  | { kind: "solana"; call: SolanaCall };

export interface TransferRequestInput {
  route: BridgeRoute;
  asset: AssetRef;
  amount: bigint;
  /** Destination-chain address (chain is implied by route.destinationChain). */
  recipient: ChainAddress;
  /**
   * Optional destination-side call (transfer+call) when supported.
   * The call kind must match the destination chain type.
   */
  call?: DestinationCall;
  relay?: RelayOptions;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CallRequestInput {
  route: BridgeRoute;
  /**
   * Destination call to execute.
   * The call kind must match the destination chain type.
   */
  call: DestinationCall;
  relay?: RelayOptions;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export type BridgeAction = TransferAction | CallAction;

export interface TransferAction {
  kind: "transfer";
  asset: AssetRef;
  amount: bigint;
  /** Destination-chain address (chain is implied by route.destinationChain). */
  recipient: ChainAddress;
  /** Optional "destination-side call" if the protocol supports transfer+call. */
  call?: DestinationCall;
}

export interface CallAction {
  kind: "call";
  /** Destination call - discriminated by kind to match destination chain type. */
  call: DestinationCall;
}

export interface RelayOptions {
  /**
   * - "auto": pay/enable protocol’s auto-relay mechanism if available.
   * - "manual": do not pay for auto-relay; caller will execute manually if supported.
   * - "none": never execute; useful for initiation-only flows.
   */
  mode?: "auto" | "manual" | "none";

  /** Destination execution gas limit (meaning is chain/protocol dependent). */
  gasLimit?: bigint;

  /** EVM fee controls (only for EVM destination execution when supported). */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface BridgeRequest {
  route: BridgeRoute;
  action: BridgeAction;

  /**
   * Optional idempotency key. If provided, adapters SHOULD use it to derive
   * deterministic salts/nonces when the protocol allows (e.g., Solana PDA seed).
   */
  idempotencyKey?: string;

  relay?: RelayOptions;

  /** Free-form metadata for app usage; never sent on-chain by the SDK itself. */
  metadata?: Record<string, unknown>;
}

export interface BridgeOperation {
  request: BridgeRequest;
  messageRef: MessageRef;
  /**
   * Optional tx identifiers produced during initiation (format is chain-dependent).
   * Examples: Solana signature, EVM tx hash.
   */
  initiationTx?: string;
  /**
   * Additional transaction signatures when the initiation required multiple
   * transactions (e.g., call buffer setup for large payloads on Solana).
   * Ordered chronologically: buffer init, then appends.
   * The final bridge tx is in {@link initiationTx}.
   */
  auxiliaryTxs?: string[];
}

/**
 * Request type for getting a quote without committing to a transaction.
 * Mirrors BridgeRequest but is used for estimation purposes only.
 */
export interface QuoteRequest {
  route: BridgeRoute;
  action: BridgeAction;
  relay?: RelayOptions;
}

/**
 * Fee estimate for a specific component of the bridge operation.
 */
export interface FeeEstimate {
  /** Fee amount in the token's smallest unit */
  amount: bigint;
  /** Token identifier (e.g., "ETH", "SOL", or token address) */
  token: string;
  /** Optional note about this fee (e.g., "paid by relayer", "informational only") */
  note?: string;
}

/**
 * Quote response containing estimated fees, timing, and limits.
 */
export interface Quote {
  /** The route this quote applies to */
  route: BridgeRoute;
  /** Estimated fees for the bridge operation */
  estimatedFees: {
    /** Fee on the source chain (gas for initiation) */
    source: FeeEstimate;
    /** Fee on the destination chain (execution gas), if applicable */
    destination?: FeeEstimate;
    /** Relay fee (protocol fee for auto-relay), if applicable */
    relay?: FeeEstimate;
  };
  /** Estimated time to completion in milliseconds */
  estimatedTimeMs: {
    /** Minimum expected time */
    min: number;
    /** Maximum expected time */
    max: number;
  };
  /** Token transfer limits, if applicable */
  limits?: {
    /** Minimum transfer amount */
    min: bigint;
    /** Maximum transfer amount */
    max: bigint;
  };
  /** Warnings about the quote (e.g., high fees, low liquidity) */
  warnings?: string[];
}

export interface ProveOptions {
  /** Optional hint for which source block height to use if the protocol requires it. */
  sourceBlockNumber?: bigint;
}

export interface ProveResult {
  messageRef: MessageRef;
  proofTx?: string;
}

export interface ExecuteOptions {
  relay?: RelayOptions;
}

export interface ExecuteResult {
  messageRef: MessageRef;
  executionTx?: string;
}

export interface StatusOptions {
  /** Optional AbortSignal to cancel the status RPC call. */
  signal?: AbortSignal;
}

export interface MonitorOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Optional AbortSignal to cancel monitoring from outside the consuming loop. */
  signal?: AbortSignal;
}

export type MessageIdScheme =
  | "solana:outgoingMessagePda" // base58 pubkey
  | "solana:incomingMessagePda" // base58 pubkey
  | "evm:txHash" // 0x-prefixed
  | "evm:messageHash" // 0x-prefixed (protocol-defined)
  | "evm:bridgeOuterHash"; // 0x-prefixed (protocol-defined)

export interface MessageId {
  scheme: MessageIdScheme;
  value: string;
}

export interface MessageEndpointRef {
  chain: ChainId;
  id: MessageId;
}

export interface MessageRef {
  route: BridgeRoute;

  /** Canonical identity: MUST be present. */
  source: MessageEndpointRef;

  /**
   * Destination identity: MAY be present if known/derivable.
   * Example: Solana->EVM outer hash can be derived from the Solana outgoing message.
   */
  destination?: MessageEndpointRef;

  /**
   * Optional derived identifiers used by specific bridge implementations to query status.
   * Implementations must document what they include.
   */
  derived?: Record<string, string>;
}

export type ExecutionStatus =
  | { type: "Unknown"; at: number }
  | { type: "Initiated"; at: number; sourceTx?: string }
  | { type: "Executable"; at: number; proofTx?: string }
  | { type: "Executing"; at: number; executionTx?: string }
  | { type: "Executed"; at: number; executionTx?: string }
  | { type: "Failed"; at: number; reason: string; executionTx?: string }
  | { type: "Expired"; at: number; reason?: string };

export type RouteStep = "initiate" | "prove" | "execute" | "monitor";

export interface RouteCapabilities {
  /** Ordered steps that apply for this route, given the current config. */
  steps: RouteStep[];
  /** Whether the route supports auto-relay on destination (e.g., "payForRelay"). */
  autoRelay?: boolean;
  /** Whether manual execution is supported by this SDK config (e.g., destination signer present). */
  manualExecute?: boolean;
  /** Whether proof generation is supported by this SDK config (RPC access, contracts present). */
  prove?: boolean;
  /** Whether the route supports quote estimation (fee, time, limits). */
  supportsQuote?: boolean;
  /** Protocol constraints that affect retries / monitoring windows. */
  constraints?: {
    /** If provided, an estimate of time until the message can be proven/executed. */
    minDelayMs?: number;
    /** If provided, maximum time window for execution. */
    maxWindowMs?: number;
  };
}

export interface ChainAdapter {
  readonly chain: ChainRef;
  /** Optional quick health check. */
  ping?(): Promise<void>;
  /** Best-effort finality info, used for prove readiness. */
  finality?(): Promise<
    { type: "instant" } | { type: "confirmations"; confirmations: number }
  >;
}

export interface RouteAdapter {
  readonly route: BridgeRoute;
  capabilities(): Promise<RouteCapabilities>;
  /**
   * Get a quote for the given request without committing to a transaction.
   * Returns estimated fees, timing, and limits.
   * If not supported, the adapter MUST throw `BridgeUnsupportedStepError`.
   */
  quote(req: QuoteRequest): Promise<Quote>;
  /**
   * Initiate a cross-chain bridge operation. The adapter dispatches
   * internally based on the action kind (call vs transfer) and, for
   * transfers, the asset kind (native, token, wrapped).
   */
  initiate(req: BridgeRequest): Promise<BridgeOperation>;
  /**
   * Optional steps. If a step is not supported, the adapter MUST throw
   * `BridgeUnsupportedStepError`.
   */
  prove(ref: MessageRef, opts?: ProveOptions): Promise<ProveResult>;
  execute(ref: MessageRef, opts?: ExecuteOptions): Promise<ExecuteResult>;
  status(ref: MessageRef, opts?: StatusOptions): Promise<ExecutionStatus>;
  monitor(
    ref: MessageRef,
    opts?: MonitorOptions,
  ): AsyncIterable<ExecutionStatus>;
}

export interface BridgeConfig {
  /**
   * On-chain addresses per chain.
   *
   * v1 supports Solana <-> EVM routes only for this bridge.
   */
  deployments: {
    solana: Record<
      ChainId,
      { bridgeProgram: SolAddress; relayerProgram: SolAddress }
    >;
    base: Record<ChainId, { bridgeContract: Hex }>;
  };

  /**
   * Token identifier mapping across chains when the bridge needs both
   * "local" and "remote" ids.
   *
   * Key format: `${sourceChain}->${destinationChain}`.
   * Value maps source token id (mint for Solana, ERC20 for EVM) -> destination token id.
   */
  tokenMappings?: Record<string, Record<string, string>>;
}

export type { Logger };
