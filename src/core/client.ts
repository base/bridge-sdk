import { NOOP_LOGGER, type Logger } from "../utils/logger";
import {
  BridgeUnsupportedRouteError,
  BridgeInvariantViolationError,
} from "./errors";
import type {
  BridgeOperation,
  BridgeProtocol,
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
  chains: Record<ChainId, ChainAdapter>;

  /** One or more bridge protocols supported by this client (v1 typically one). */
  protocols: BridgeProtocol[];

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

function routeKey(route: BridgeRoute, protocolId: string): RouteAdapterKey {
  return `${protocolId}:${route.sourceChain}->${route.destinationChain}`;
}

class DefaultBridgeClient implements BridgeClient {
  private readonly chains: Record<ChainId, ChainAdapter>;
  private readonly protocols: BridgeProtocol[];
  private readonly logger: Logger;
  private readonly defaults: BridgeClientConfig["defaults"];

  private readonly adapterCache = new Map<
    RouteAdapterKey,
    Promise<RouteAdapter>
  >();

  constructor(config: BridgeClientConfig) {
    this.chains = config.chains;
    this.protocols = config.protocols;
    this.logger = config.logger ?? NOOP_LOGGER;
    this.defaults = config.defaults;

    if (!this.protocols.length) {
      throw new BridgeInvariantViolationError(
        "BridgeClientConfig.protocols must be non-empty"
      );
    }
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
      `bridge.request: initiating ${req.route.sourceChain} -> ${
        req.route.destinationChain
      }${req.route.protocol ? ` (protocol=${req.route.protocol})` : ""}`
    );
    return await adapter.initiate(req);
  }

  async prove(ref: MessageRef, opts?: ProveOptions): Promise<ProveResult> {
    const adapter = await this.getRouteAdapter(ref.route);
    this.logger.debug(
      `bridge.prove: ${ref.route.sourceChain} -> ${ref.route.destinationChain}${
        ref.route.protocol ? ` (protocol=${ref.route.protocol})` : ""
      }`
    );
    return await adapter.prove(ref, opts);
  }

  async execute(
    ref: MessageRef,
    opts?: ExecuteOptions
  ): Promise<ExecuteResult> {
    const adapter = await this.getRouteAdapter(ref.route);
    this.logger.debug(
      `bridge.execute: ${ref.route.sourceChain} -> ${
        ref.route.destinationChain
      }${ref.route.protocol ? ` (protocol=${ref.route.protocol})` : ""}`
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
    const protocol = this.selectProtocol(route);
    return { route, protocolId: protocol.id };
  }

  async capabilities(route: BridgeRoute): Promise<RouteCapabilities> {
    const adapter = await this.getRouteAdapter(route);
    return await adapter.capabilities();
  }

  private selectProtocol(route: BridgeRoute): BridgeProtocol {
    if (route.protocol) {
      const p = this.protocols.find((x) => x.id === route.protocol);
      if (!p || !p.supportsRoute(route)) {
        throw new BridgeUnsupportedRouteError(route);
      }
      this.logger.debug(
        `bridge.resolveRoute: selected protocol=${p.id} for ${route.sourceChain} -> ${route.destinationChain}`
      );
      return p;
    }

    const p = this.protocols.find((x) => x.supportsRoute(route));
    if (!p) {
      throw new BridgeUnsupportedRouteError(route);
    }
    this.logger.debug(
      `bridge.resolveRoute: selected protocol=${p.id} for ${route.sourceChain} -> ${route.destinationChain}`
    );
    return p;
  }

  private getRouteAdapter(route: BridgeRoute): Promise<RouteAdapter> {
    const protocol = this.selectProtocol(route);
    const key = routeKey(route, protocol.id);

    const existing = this.adapterCache.get(key);
    if (existing) {
      this.logger.debug(
        `bridge.resolveRoute: cache hit for ${protocol.id}:${route.sourceChain} -> ${route.destinationChain}`
      );
      return existing;
    }

    this.logger.debug(
      `bridge.resolveRoute: constructing adapter for ${protocol.id}:${route.sourceChain} -> ${route.destinationChain}`
    );
    const created = protocol.resolveRoute(route, this.chains);
    this.adapterCache.set(key, created);
    return created;
  }
}

export function createBridgeClient(config: BridgeClientConfig): BridgeClient {
  return new DefaultBridgeClient(config);
}
