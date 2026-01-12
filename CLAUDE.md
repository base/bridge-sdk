# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
bun install          # Install dependencies
bun run build        # Clean, generate types, and bundle to dist/
bun run typecheck    # Type-check without emitting
bun test             # Run all tests
bun test <file>      # Run a specific test file
```

## Architecture Overview

This is a **cross-chain bridge SDK** for Base Markets with a **hub-and-spoke architecture** where **Base is always the hub**. Routes must include either Base mainnet (`eip155:8453`) or Base Sepolia (`eip155:84532`).

### Supported Routes (v1)
- Solana mainnet (`solana:mainnet`) ↔ Base mainnet (`eip155:8453`)
- Solana devnet (`solana:devnet`) ↔ Base Sepolia (`eip155:84532`)

### Core Components

**`src/core/`** - Chain-agnostic orchestration
- `client.ts` - Main `BridgeClient` implementation and route resolution
- `types.ts` - Core types: `ChainId`, `BridgeRoute`, `MessageRef`, `ExecutionStatus`, `BridgeRequest`
- `errors.ts` - Typed errors with actionable outcomes (`retry`, `user_fix`, `fatal`)
- `capabilities.ts` - Route capability discovery

**`src/core/protocol/`** - Base Markets bridge logic
- `router.ts` - Hub-and-spoke routing validation
- `routes/svm-to-base.ts` - Solana → Base route adapter
- `routes/base-to-svm.ts` - Base → Solana route adapter
- `engines/solana-engine.ts` - Solana bridge operations
- `engines/base-engine.ts` - EVM bridge operations
- `identity.ts` - Message hashing and derivation
- `encoding.ts` - Message encoding/decoding

**`src/adapters/chains/`** - Chain integration
- `evm/` - viem-based EVM adapter
- `solana/` - @solana/kit-based Solana adapter

**`src/clients/` and `src/interfaces/`** - Generated Anchor clients, ABIs, and IDLs (do not modify manually)

**`src/chains/`** - Chain definitions exported as `@base-markets/bridge-sdk/chains`

### Key Patterns

**Message Identity**: `MessageRef` has canonical `source` identity (required) and optional `destination` identity. Source identity is anchored to the initiating chain.

**Bridging Flow**:
1. `initiate` - Submit message on source chain
2. `prove` (optional, route-dependent) - Generate ZK proof for Base→SVM
3. `execute` - Relay message on destination (auto or manual)
4. `monitor` - Poll for terminal state

**Capabilities**: Call `client.capabilities(route)` to discover which steps apply before execution.

## Workflow

1. Write or update code relevant to the task
2. Write incremental unit tests covering new logic
3. Run `bun test` to verify tests pass
4. Ensure good test coverage for changes
