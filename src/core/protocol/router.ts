import type { EvmChainAdapter } from "../../adapters/chains/evm/types";
import type { SolanaChainAdapter } from "../../adapters/chains/solana/types";
import type { Logger } from "../../utils/logger";
import { BridgeUnsupportedRouteError } from "../errors";
import type {
  BridgeConfig,
  BridgeRoute,
  ChainAdapter,
  ChainId,
  RouteAdapter,
} from "../types";
import { isSolanaChainId } from "../utils";
import { BaseToSvmRouteAdapter } from "./routes/base-to-svm";
import { SvmToBaseRouteAdapter } from "./routes/svm-to-base";

/**
 * Hub chain identifiers for the bridge.
 *
 * The bridge uses a hub-and-spoke architecture where Base is the permanent hub.
 * All routes must include one of these chains as either source or destination.
 * This is a fundamental protocol constraint, not a temporary limitation.
 */
export const BASE_MAINNET_CHAIN_ID = "eip155:8453";
export const BASE_SEPOLIA_CHAIN_ID = "eip155:84532";

/** Spoke chain identifiers. */
export const SOLANA_MAINNET_CHAIN_ID = "solana:mainnet";
export const SOLANA_DEVNET_CHAIN_ID = "solana:devnet";

export const HUB_CHAIN_IDS = [
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
] as const;

export function routeMapKey(route: BridgeRoute): string {
  return `${route.sourceChain}->${route.destinationChain}`;
}

/**
 * Checks if the given chain ID is a Base hub chain.
 *
 * Base bridge uses a hub-and-spoke architecture with Base as the
 * permanent hub. All routes must include Base mainnet or Base Sepolia.
 * This is a fundamental protocol constraint, not a temporary limitation.
 */
function isBaseEvmChainId(id: string): boolean {
  return HUB_CHAIN_IDS.includes(id as (typeof HUB_CHAIN_IDS)[number]);
}

function asSolanaAdapter(
  adapter: ChainAdapter,
): SolanaChainAdapter | undefined {
  return "kind" in adapter && (adapter as SolanaChainAdapter).kind === "solana"
    ? (adapter as SolanaChainAdapter)
    : undefined;
}

function asEvmAdapter(adapter: ChainAdapter): EvmChainAdapter | undefined {
  return "kind" in adapter && (adapter as EvmChainAdapter).kind === "evm"
    ? (adapter as EvmChainAdapter)
    : undefined;
}

export function supportsBridgeRoute(route: BridgeRoute): boolean {
  return (
    (isSolanaChainId(route.sourceChain) &&
      isBaseEvmChainId(route.destinationChain)) ||
    (isBaseEvmChainId(route.sourceChain) &&
      isSolanaChainId(route.destinationChain))
  );
}

export async function resolveBridgeRoute(
  route: BridgeRoute,
  chains: Record<ChainId, ChainAdapter>,
  config: BridgeConfig,
  logger?: Logger,
): Promise<RouteAdapter> {
  const source = chains[route.sourceChain];
  const dest = chains[route.destinationChain];
  if (!source || !dest) throw new BridgeUnsupportedRouteError(route);

  if (
    isSolanaChainId(route.sourceChain) &&
    isBaseEvmChainId(route.destinationChain)
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
      logger,
    });
  }

  if (
    isBaseEvmChainId(route.sourceChain) &&
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
      logger,
    });
  }

  throw new BridgeUnsupportedRouteError(route);
}
