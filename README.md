# Bridge SDK

> [!WARNING]
>
> This codebase is a work in progress and has not been audited. This is not yet recommended for production use.
> Use at your own risk.

Composable cross-chain bridge SDK for Base Markets integrations.

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
- **Runtime-agnostic**: Compatible with standard Node.js environments (no Bun-only APIs).

## Project Structure

```
src/
  core/           // BridgeClient orchestration + shared types/errors/monitor
  adapters/       // Chain adapters + Base Markets bridge implementation (route adapters)
  clients/        // Generated clients (Solana/Base)
  interfaces/     // ABIs and IDLs
  utils/          // Helper functions
examples/         // Usage examples
tests/            // bun:test specs
```

## Usage Example

### Bridging SOL from Solana to Base

```ts
import { createBridgeClient } from "@base-markets/bridge-sdk";
import { makeSolanaAdapter } from "./your-adapters/solana";
import { makeEvmAdapter } from "./your-adapters/evm";

async function main() {
  const client = createBridgeClient({
    chains: {
      "solana:mainnet": await makeSolanaAdapter({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        payer: { type: "keypairPath", path: "~/.config/solana/id.json" },
      }),
      "eip155:8453": makeEvmAdapter({
        chainId: 8453,
        rpcUrl: "https://mainnet.base.org",
        wallet: { type: "none" },
      }),
    },
  });

  const op = await client.transfer({
    route: { sourceChain: "solana:mainnet", destinationChain: "eip155:8453" },
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

#### Overriding deployments (advanced)

If you need to target additional networks (e.g. Base Sepolia / Solana devnet) or
use custom deployments, pass `deployments` overrides to:
`createBridgeClient({ bridgeConfig: { deployments: ... } })`.

## Examples

See `examples/` for working scripts against the v1 `BridgeClient` API:

- `examples/transfer.ts`: Solana → EVM transfer
- `examples/call.ts`: Solana → EVM call
- `examples/evmToSolanaTokenTransfer.ts`: EVM → Solana token transfer (prove + execute)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
