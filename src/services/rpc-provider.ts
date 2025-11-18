import type { ChainMetadata } from "@/types";
import { createLogger, type Logger } from "@/utils/logger";

export interface RpcProviderOptions {
  chains: ChainMetadata[];
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface RpcRequest<TParams = unknown> {
  method: string;
  params?: TParams;
}

export class RpcProvider {
  private readonly chains: Map<number, ChainMetadata>;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(options: RpcProviderOptions) {
    this.chains = new Map(options.chains.map((chain) => [chain.id, chain]));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? createLogger({ namespace: "rpc" });
  }

  async request<TResponse>(
    chainId: number,
    { method, params }: RpcRequest
  ): Promise<TResponse | undefined> {
    const chain = this.chains.get(chainId);

    if (!chain) {
      this.logger.warn("Attempted RPC request for unsupported chain", {
        chainId,
        method,
      });
      return undefined;
    }

    try {
      const response = await this.fetchImpl(chain.rpcUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method,
          params,
        }),
      });

      if (!response.ok) {
        this.logger.warn("RPC request returned non-200 status", {
          chainId,
          method,
          status: response.status,
        });
        return undefined;
      }

      const payload = (await response.json()) as { result?: TResponse };
      return payload.result;
    } catch (error) {
      this.logger.error("RPC request failed", {
        chainId,
        method,
        error: (error as Error).message,
      });
      return undefined;
    }
  }
}
