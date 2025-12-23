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

/**
 * Chain-specific address string. The chain is implied by the surrounding context
 * (e.g., a `BridgeRoute`'s source/destination chain).
 */
export type ChainAddress = string;

export type AssetRef =
  | { kind: "native" } // e.g., SOL on Solana, ETH on an EVM chain
  | { kind: "token"; address: string } // mint for Solana, ERC20 for EVM
  | { kind: "wrapped"; address: string }; // protocol-specific wrapped token id

export interface EvmCall {
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
  /** Optional protocol-specific call type. */
  ty?: number;
}

export interface TransferRequestInput {
  route: BridgeRoute;
  asset: AssetRef;
  amount: bigint;
  /** Destination-chain address (chain is implied by route.destinationChain). */
  recipient: ChainAddress;
  /** Optional destination-side call (transfer+call) when supported. */
  call?: EvmCall;
  relay?: RelayOptions;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CallRequestInput {
  route: BridgeRoute;
  call: EvmCall;
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
  /** Optional “destination-side call” if the protocol supports transfer+call. */
  call?: CallAction["call"];
}

export interface CallAction {
  kind: "call";
  call: EvmCall; // v1: call model matches current Base EVM call constraints
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
  route: BridgeRoute;
  request: BridgeRequest;
  messageRef: MessageRef;
  /**
   * Optional tx identifiers produced during initiation (format is chain-dependent).
   * Examples: Solana signature, EVM tx hash.
   */
  initiationTx?: string;
}

export interface ResolvedRoute {
  route: BridgeRoute;
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

export interface StatusOptions {}

export interface MonitorOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
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
  | { type: "FinalizedOnSource"; at: number; sourceFinality?: string }
  | { type: "Proven"; at: number; proofTx?: string }
  | { type: "Executable"; at: number }
  | { type: "Executing"; at: number; executionTx?: string }
  | { type: "Executed"; at: number; executionTx?: string }
  | { type: "Failed"; at: number; reason: string; executionTx?: string }
  | { type: "Expired"; at: number; reason?: string };

export type RouteStep = "initiate" | "prove" | "execute" | "monitor";

export interface RouteCapabilities {
  /** Ordered steps that apply for this route, given the current config. */
  steps: RouteStep[];
  /** Whether the route supports auto-relay on destination (e.g., “payForRelay”). */
  autoRelay?: boolean;
  /** Whether manual execution is supported by this SDK config (e.g., destination signer present). */
  manualExecute?: boolean;
  /** Whether proof generation is supported by this SDK config (RPC access, contracts present). */
  prove?: boolean;
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
    opts?: MonitorOptions
  ): AsyncIterable<ExecutionStatus>;
}

export type { Logger };
