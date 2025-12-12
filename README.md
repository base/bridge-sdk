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

- **Solana ↔ Base Bridging**: Seamlessly bridge assets between Solana and Base.
- **Multiple Bridge Types**:
  - **Bridge SOL**: Native SOL transfers.
  - **Bridge SPL**: SPL token transfers.
  - **Bridge Wrapped**: Wrapped token transfers.
  - **Bridge Call**: Arbitrary cross-chain contract calls.
- **Message Relaying**: Built-in support for monitoring and verifying message execution on Base.
- **Dual Engine Architecture**:
  - `SolanaEngine`: Handles Solana-side interactions (setup messages, build transactions).
  - `BaseEngine`: Handles Base-side monitoring and verification.
- **Bun-native**: Optimized for Bun runtime with fast build and test execution.

## Project Structure

```
src/
  clients/        // Generated clients (Solana/Base)
  config/         // Default configuration
  constants/      // SDK-wide constants
  core/           // Core logic (BridgeSDK, SolanaEngine, BaseEngine)
  interfaces/     // ABIs and IDLs
  types/          // TypeScript type definitions
  utils/          // Helper functions
examples/         // Usage examples
tests/            // bun:test specs
```

## Usage Example

### Bridging SOL from Solana to Base

```ts
import { createBridgeSDK } from "@base-markets/bridge-sdk";

async function main() {
  // Initialize SDK with optional config
  // If payerKp is not provided, it will look for standard Solana CLI config
  const sdk = createBridgeSDK({
    config: {
      solana: {
        payerKp: "path/to/keypair.json",
      },
    },
  });

  // Bridge 0.001 SOL to an EVM address
  const outgoingMessage = await sdk.bridgeSol({
    to: "0x644e3DedB0e4F83Bfcf8F9992964d240224B74dc", // EVM recipient address
    amount: 1_000_000n, // 0.001 SOL (in lamports)
    payForRelay: true, // Optional: Pay for relay execution on Base
  });

  console.log("Bridge transaction sent. Message pubkey:", outgoingMessage);

  // Wait for the message to be executed on Base
  await sdk.waitForMessageExecution(outgoingMessage);
  console.log("Message executed on Base!");
}

main().catch(console.error);
```

### Other Examples

Check the `examples/` directory for more usage patterns:

- `examples/bridgeSpl.ts`: Bridging SPL tokens
- `examples/bridgeWrapped.ts`: Bridging wrapped tokens
- `examples/bridgeCall.ts`: Making cross-chain contract calls
- `examples/wrapToken.ts`: Wrapping tokens

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
