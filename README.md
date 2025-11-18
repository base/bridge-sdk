# Bridge SDK

Composable cross-chain bridge SDK scaffolding for Base Markets integrations.

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

- opinionated default config for Base ↔ Ethereum routes
- light-weight routing engine abstraction with pluggable RPC provider
- structured logger utility with custom transports
- Bun-native build/test scripts and TypeScript project references

## Project Structure

```
src/
  config/         // default network + token metadata
  constants/      // SDK-wide constants
  core/           // BridgeSDK + routing engine
  services/       // RPC provider, transport adapters
  types/          // shared TypeScript contracts
  utils/          // logging, helpers
tests/            // bun:test specs
```

## Usage Example

```ts
import { createBridgeSDK } from "@base-markets/bridge-sdk";

const sdk = createBridgeSDK();

const quote = await sdk.getQuote({
  amount: "1",
  fromChainId: 8453,
  toChainId: 1,
  fromTokenAddress: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  toTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  userAddress: "0x0000000000000000000000000000000000000000",
});

console.log(quote);
```
