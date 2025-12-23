import { NOOP_LOGGER, type Logger } from "../utils/logger";
import { BridgeUnsupportedRouteError } from "./errors";
import {
  resolveBridgeRoute,
  supportsBridgeRoute,
  type BridgeConfig,
} from "./protocol/router";
import { mergeBridgeDeployments } from "./protocol/deployments";
import type {
  BridgeOperation,
  BridgeRequest,
  BridgeRoute,
  CallRequestInput,
  ChainAdapter,
  ChainId,
  ExecuteOptions,
  ExecuteResult,
  ExecutionStatus,
  MessageRef,
  MonitorOptions,
  ProveOptions,
  ProveResult,
  ResolvedRoute,
  RouteAdapter,
  RouteCapabilities,
  StatusOptions,
  TransferRequestInput,
} from "./types";

export interface BridgeClientConfig {
  /** Registered chains and their adapters. */
  chains: Record<string, ChainAdapter>;

  /**
   * Bridge-specific configuration.
   */
  bridgeConfig?: {
    /** Optional token identifier mapping overrides. */
    tokenMappings?: BridgeConfig["tokenMappings"];

    /**
     * Optional deployment overrides. Use this when targeting additional networks
     * (e.g. Base Sepolia, Solana devnet) or if contracts are redeployed.
     */
    deployments?: Partial<BridgeConfig["deployments"]>;
  };

  /** Optional default behavior for monitoring/retries/logging. */
  defaults?: {
    monitor?: MonitorOptions;
    relay?: {
      mode?: "auto" | "manual" | "none";
      gasLimit?: bigint;
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
    };
  };

  logger?: Logger;
}

export interface BridgeClient {
  /** Convenience helpers */
  transfer(req: TransferRequestInput): Promise<BridgeOperation>;
  call(req: CallRequestInput): Promise<BridgeOperation>;
  request(req: BridgeRequest): Promise<BridgeOperation>;

  /** Step execution (route-dependent; see capabilities) */
  prove(ref: MessageRef, opts?: ProveOptions): Promise<ProveResult>;
  execute(ref: MessageRef, opts?: ExecuteOptions): Promise<ExecuteResult>;

  /** Monitoring (polling/subscriptions/indexer adapters) */
  status(ref: MessageRef, opts?: StatusOptions): Promise<ExecutionStatus>;
  monitor(
    ref: MessageRef,
    opts?: MonitorOptions
  ): AsyncIterable<ExecutionStatus>;

  /** Discovery */
  resolveRoute(route: BridgeRoute): Promise<ResolvedRoute>;
  capabilities(route: BridgeRoute): Promise<RouteCapabilities>;
}

type RouteAdapterKey = string;

function routeKey(route: BridgeRoute): RouteAdapterKey {
  return `${route.sourceChain}->${route.destinationChain}`;
}

class DefaultBridgeClient implements BridgeClient {
  private readonly chains: Record<ChainId, ChainAdapter>;
  private readonly bridge: BridgeConfig;
  private readonly logger: Logger;
  private readonly defaults: BridgeClientConfig["defaults"];

  private readonly adapterCache = new Map<
    RouteAdapterKey,
    Promise<RouteAdapter>
  >();

  constructor(config: BridgeClientConfig & { bridge: BridgeConfig }) {
    this.chains = config.chains;
    this.bridge = config.bridge;
    this.logger = config.logger ?? NOOP_LOGGER;
    this.defaults = config.defaults;
  }

  async transfer(req: TransferRequestInput): Promise<BridgeOperation> {
    const bridgeReq: BridgeRequest = {
      route: req.route,
      action: {
        kind: "transfer",
        asset: req.asset,
        amount: req.amount,
        recipient: req.recipient,
        call: req.call,
      },
      idempotencyKey: req.idempotencyKey,
      relay: req.relay ?? this.defaults?.relay,
      metadata: req.metadata,
    };
    return await this.request(bridgeReq);
  }

  async call(req: CallRequestInput): Promise<BridgeOperation> {
    const bridgeReq: BridgeRequest = {
      route: req.route,
      action: { kind: "call", call: req.call },
      idempotencyKey: req.idempotencyKey,
      relay: req.relay ?? this.defaults?.relay,
      metadata: req.metadata,
    };
    return await this.request(bridgeReq);
  }

  async request(req: BridgeRequest): Promise<BridgeOperation> {
    const adapter = await this.getRouteAdapter(req.route);
    this.logger.debug(
      `bridge.request: initiating ${req.route.sourceChain} -> ${req.route.destinationChain}`
    );
    return await adapter.initiate(req);
  }

  async prove(ref: MessageRef, opts?: ProveOptions): Promise<ProveResult> {
    const adapter = await this.getRouteAdapter(ref.route);
    this.logger.debug(
      `bridge.prove: ${ref.route.sourceChain} -> ${ref.route.destinationChain}`
    );
    return await adapter.prove(ref, opts);
  }

  async execute(
    ref: MessageRef,
    opts?: ExecuteOptions
  ): Promise<ExecuteResult> {
    const adapter = await this.getRouteAdapter(ref.route);
    this.logger.debug(
      `bridge.execute: ${ref.route.sourceChain} -> ${ref.route.destinationChain}`
    );
    return await adapter.execute(ref, opts);
  }

  async status(
    ref: MessageRef,
    opts?: StatusOptions
  ): Promise<ExecutionStatus> {
    const adapter = await this.getRouteAdapter(ref.route);
    return await adapter.status(ref, opts);
  }

  async *monitor(
    ref: MessageRef,
    opts?: MonitorOptions
  ): AsyncIterable<ExecutionStatus> {
    const adapter = await this.getRouteAdapter(ref.route);
    const merged: MonitorOptions = {
      ...this.defaults?.monitor,
      ...opts,
    };
    yield* adapter.monitor(ref, merged);
  }

  async resolveRoute(route: BridgeRoute): Promise<ResolvedRoute> {
    if (!supportsBridgeRoute(route))
      throw new BridgeUnsupportedRouteError(route);
    return { route };
  }

  async capabilities(route: BridgeRoute): Promise<RouteCapabilities> {
    const adapter = await this.getRouteAdapter(route);
    return await adapter.capabilities();
  }

  private getRouteAdapter(route: BridgeRoute): Promise<RouteAdapter> {
    if (!supportsBridgeRoute(route))
      throw new BridgeUnsupportedRouteError(route);
    const key = routeKey(route);

    const existing = this.adapterCache.get(key);
    if (existing) {
      this.logger.debug(
        `bridge.resolveRoute: cache hit for ${route.sourceChain} -> ${route.destinationChain}`
      );
      return existing;
    }

    this.logger.debug(
      `bridge.resolveRoute: constructing adapter for ${route.sourceChain} -> ${route.destinationChain}`
    );
    const created = resolveBridgeRoute(route, this.chains, this.bridge);
    this.adapterCache.set(key, created);
    return created;
  }
}

export function createBridgeClient(config: BridgeClientConfig): BridgeClient {
  const chains: Record<ChainId, ChainAdapter> = {};
  for (const adapter of Object.values(config.chains)) {
    const id = adapter.chain.id;
    if (chains[id]) {
      throw new Error(
        `Duplicate chain adapter registered for ${id}. Ensure each adapter has a unique chain id.`
      );
    }
    chains[id] = adapter;
  }

  const deployments = mergeBridgeDeployments(config.bridgeConfig?.deployments);
  const bridge: BridgeConfig = {
    deployments,
    tokenMappings: config.bridgeConfig?.tokenMappings,
  };

  return new DefaultBridgeClient({
    ...config,
    chains,
    bridge,
  });
}
