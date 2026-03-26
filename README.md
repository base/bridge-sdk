# Bridge SDK

> [!WARNING]
>
> This codebase is a work in progress and has not been audited. This is not yet recommended for production use.
> Use at your own risk.

Composable cross-chain bridge SDK for Base Bridge integrations.

## Getting Started

```bash
bun install
# type-check & unit tests
bun run typecheck
bun test
# bundle to dist/
bun run build
```

## Features

- **Chain-agnostic API**: One `BridgeClient` entrypoint for any route via `{ sourceChain, destinationChain }`.
- **Composable primitives**: `transfer`, `call`, `request`, plus `prove`, `execute`, `status`, and `monitor`.
- **Canonical message identity**: a single `MessageRef` model with stable source identity and optional derived destination ids.
- **Capability-driven UX**: `capabilities(route)` tells you which steps apply for a route.
- **Browser/Edge compatible**: Core SDK works in browsers, edge runtimes, and Node.js. Node.js-specific utilities available via `/node` subpath.

## Usage Example

### Bridging SOL from Solana to Base

```ts
import { createBridgeClient } from "bridge-sdk";
import { base, solanaMainnet, makeEvmAdapter, makeSolanaAdapter } from "bridge-sdk/chains";
import { loadSolanaKeypair } from "bridge-sdk/node"; // Node.js only

async function main() {
  // Pre-load the Solana keypair before creating the adapter (Node.js only)
  const payer = await loadSolanaKeypair("~/.config/solana/id.json");

  const client = createBridgeClient({
    chains: {
      solana: makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer,
        chain: solanaMainnet,
      }),
      base: makeEvmAdapter({
        chain: base,
        rpcUrl: "https://mainnet.base.org",
        wallet: { type: "none" },
      }),
    },
  });

  const op = await client.transfer({
    route: {
      sourceChain: solanaMainnet.id,
      destinationChain: base.id,
    },
    asset: { kind: "native" }, // SOL
    amount: 1_000_000n,
    recipient: "0x644e3DedB0e4F83Bfcf8F9992964d240224B74dc",
    relay: { mode: "auto" },
  });

  for await (const s of client.monitor(op.messageRef)) {
    if (s.type === "Executed") break;
  }
}

main().catch(console.error);
```

## Network Configuration

The SDK ships with hardcoded **mainnet** deployment addresses. To target
additional networks (e.g. Solana devnet, Base Sepolia) or use custom contract
deployments, pass `deployments` overrides to `createBridgeClient()`.

### Default deployment addresses

| Domain   | Chain ID         | Field            | Type         | Description                    |
| -------- | ---------------- | ---------------- | ------------ | ------------------------------ |
| `solana` | `solana:mainnet` | `bridgeProgram`  | `SolAddress` | Solana bridge program address  |
| `solana` | `solana:mainnet` | `relayerProgram` | `SolAddress` | Solana relayer program address |
| `base`   | `eip155:8453`    | `bridgeContract` | `Hex`        | Base bridge contract address   |

### Devnet / testnet configuration example

The SDK exports `solanaDevnet` and `baseSepolia` chain objects you can use
alongside your own deployment addresses:

```ts
import { address } from "@solana/kit";
import { createBridgeClient } from "bridge-sdk";
import { baseSepolia, solanaDevnet, makeEvmAdapter, makeSolanaAdapter } from "bridge-sdk/chains";
import { loadSolanaKeypair } from "bridge-sdk/node"; // Node.js only

const payer = await loadSolanaKeypair("~/.config/solana/id.json");

const client = createBridgeClient({
  chains: {
    solana: makeSolanaAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      payer,
      chain: solanaDevnet,
    }),
    base: makeEvmAdapter({
      chain: baseSepolia,
      rpcUrl: "https://sepolia.base.org",
      wallet: { type: "none" },
    }),
  },
  bridgeConfig: {
    deployments: {
      solana: {
        // All fields are required when adding a new chain ID
        [solanaDevnet.id]: {
          bridgeProgram: address("<YOUR_DEVNET_BRIDGE_PROGRAM>"),
          relayerProgram: address("<YOUR_DEVNET_RELAYER_PROGRAM>"),
        },
      },
      base: {
        [baseSepolia.id]: {
          bridgeContract: "0x<YOUR_SEPOLIA_BRIDGE_CONTRACT>",
        },
      },
    },
  },
});
```

### Merge behavior

Overrides are **merged** with the built-in mainnet defaults, not replaced:

- **Existing chain IDs** — individual fields are overridden; unspecified fields
  keep their defaults.
- **New chain IDs** (e.g. `solana:devnet`) — all required fields must be
  provided or the entry is ignored.

This means you can override a single mainnet address without losing the others,
or add devnet/testnet entries while keeping the mainnet defaults intact.

## Examples

See `examples/` for working scripts against the v1 `BridgeClient` API:

- `examples/transfer.ts`: Solana → EVM transfer
- `examples/call.ts`: Solana → EVM call
- `examples/evmToSolanaTokenTransfer.ts`: EVM → Solana token transfer (prove + execute)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
