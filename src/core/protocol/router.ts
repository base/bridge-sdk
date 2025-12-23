import type {
  BridgeRoute,
  ChainAdapter,
  ChainId,
  RouteAdapter,
} from "../types";
import { BridgeUnsupportedRouteError } from "../errors";
import type { EvmChainAdapter } from "../../adapters/chains/evm/types";
import type { SolanaChainAdapter } from "../../adapters/chains/solana/types";
import { BaseToSvmRouteAdapter } from "./routes/base-to-svm";
import { SvmToBaseRouteAdapter } from "./routes/svm-to-base";
import type { Address as SolAddress } from "@solana/kit";
import type { Hex } from "viem";

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

function routeMapKey(route: BridgeRoute): string {
  return `${route.sourceChain}->${route.destinationChain}`;
}

function isSolanaChainId(id: string): boolean {
  return id.startsWith("solana:");
}

function isEip155ChainId(id: string): boolean {
  return id.startsWith("eip155:");
}

function isBaseEvmChainId(id: string): boolean {
  // Base mainnet + Base Sepolia
  return id === "eip155:8453" || id === "eip155:84532";
}

function asSolanaAdapter(
  adapter: ChainAdapter
): SolanaChainAdapter | undefined {
  return (adapter as any)?.kind === "solana"
    ? (adapter as SolanaChainAdapter)
    : undefined;
}

function asEvmAdapter(adapter: ChainAdapter): EvmChainAdapter | undefined {
  return (adapter as any)?.kind === "evm"
    ? (adapter as EvmChainAdapter)
    : undefined;
}

export function supportsBridgeRoute(route: BridgeRoute): boolean {
  // Hub-and-spoke invariant: routes must include Base mainnet or Base Sepolia.
  const includesBase =
    isBaseEvmChainId(route.sourceChain) ||
    isBaseEvmChainId(route.destinationChain);
  if (!includesBase) return false;

  return (
    (isSolanaChainId(route.sourceChain) &&
      isEip155ChainId(route.destinationChain)) ||
    (isEip155ChainId(route.sourceChain) &&
      isSolanaChainId(route.destinationChain))
  );
}

export async function resolveBridgeRoute(
  route: BridgeRoute,
  chains: Record<ChainId, ChainAdapter>,
  config: BridgeConfig
): Promise<RouteAdapter> {
  const source = chains[route.sourceChain];
  const dest = chains[route.destinationChain];
  if (!source || !dest) throw new BridgeUnsupportedRouteError(route);

  if (
    isSolanaChainId(route.sourceChain) &&
    isEip155ChainId(route.destinationChain)
  ) {
    const sol = asSolanaAdapter(source);
    const evm = asEvmAdapter(dest);
    if (!sol || !evm) throw new BridgeUnsupportedRouteError(route);
    const solDep = config.deployments.solana[route.sourceChain];
    const evmDep = config.deployments.base[route.destinationChain];
    if (!solDep || !evmDep) throw new BridgeUnsupportedRouteError(route);
    return new SvmToBaseRouteAdapter({
      route,
      solana: sol,
      evm,
      solanaDeployment: solDep,
      evmDeployment: evmDep,
      tokenMapping: config.tokenMappings?.[routeMapKey(route)],
    });
  }

  if (
    isEip155ChainId(route.sourceChain) &&
    isSolanaChainId(route.destinationChain)
  ) {
    const evm = asEvmAdapter(source);
    const sol = asSolanaAdapter(dest);
    if (!sol || !evm) throw new BridgeUnsupportedRouteError(route);
    const solDep = config.deployments.solana[route.destinationChain];
    const evmDep = config.deployments.base[route.sourceChain];
    if (!solDep || !evmDep) throw new BridgeUnsupportedRouteError(route);
    return new BaseToSvmRouteAdapter({
      route,
      solana: sol,
      evm,
      solanaDeployment: solDep,
      evmDeployment: evmDep,
      tokenMapping: config.tokenMappings?.[routeMapKey(route)],
    });
  }

  throw new BridgeUnsupportedRouteError(route);
}
