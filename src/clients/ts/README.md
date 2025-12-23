# TypeScript program clients (internal)

This directory contains **generated TypeScript client bindings** for the Solana programs used by the Base ↔ Solana bridge:

- `src/base-relayer/…`
- `src/bridge/…`

These bindings are primarily consumed **internally by** `@base-markets/bridge-sdk` (the package published from the repo root) and are not meant to be “run” as a standalone app.

If you’re looking for the SDK’s public API and examples, see the repo root [`README.md`](../../../README.md).
