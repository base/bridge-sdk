import { beforeEach, describe, expect, mock, test } from "bun:test";
import { SvmToBaseRouteAdapter } from "../src/core/protocol/routes/svm-to-base";
import type { BridgeRequest, BridgeRoute } from "../src/core/types";

const FAKE_PDA = "11111111111111111111111111111112" as const;
const FAKE_SIGNATURE =
  "5wHu1qwD7dZ8x1J9Z9Lf2qQzK5dN1j7Z9fZ8x1J9Z9Lf2qQzK5dN1j7Z9fZ8x1J9Z9Lf2qQzK5dN1j7Z9fZ8x1" as const;
const FAKE_OUTER_HASH = "0xabc123" as const;

const route: BridgeRoute = {
  sourceChain: "solana:mainnet",
  destinationChain: "eip155:8453",
};

/**
 * Build an adapter with engine methods stubbed so we never hit Solana RPC.
 */
function buildAdapter(): SvmToBaseRouteAdapter {
  const adapter = Object.create(
    SvmToBaseRouteAdapter.prototype,
  ) as SvmToBaseRouteAdapter;

  const engineStub = {
    bridgeCall: mock(() =>
      Promise.resolve({ outgoingPda: FAKE_PDA, signature: FAKE_SIGNATURE }),
    ),
    bridgeSol: mock(() =>
      Promise.resolve({ outgoingPda: FAKE_PDA, signature: FAKE_SIGNATURE }),
    ),
    bridgeSpl: mock(() =>
      Promise.resolve({ outgoingPda: FAKE_PDA, signature: FAKE_SIGNATURE }),
    ),
    bridgeWrapped: mock(() =>
      Promise.resolve({ outgoingPda: FAKE_PDA, signature: FAKE_SIGNATURE }),
    ),
  };

  // Stub deriveOuterHash (private method) to avoid RPC calls
  const deriveOuterHashMock = mock(() => Promise.resolve(FAKE_OUTER_HASH));

  const stub = adapter as unknown as Record<string, unknown>;
  stub.solanaEngine = engineStub;
  stub.route = route;
  stub.deriveOuterHash = deriveOuterHashMock;

  return adapter;
}

describe("SvmToBaseRouteAdapter.initiate sets initiationTx", () => {
  let adapter: SvmToBaseRouteAdapter;

  beforeEach(() => {
    adapter = buildAdapter();
  });

  test("call path sets initiationTx to Solana signature", async () => {
    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: "0xd09de08a",
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    expect(op.initiationTx).toBe(FAKE_SIGNATURE);
    expect(op.messageRef.source.id.value).toBe(FAKE_PDA);
  });

  test("native transfer path sets initiationTx to Solana signature", async () => {
    const req: BridgeRequest = {
      route,
      action: {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1_000_000_000n,
        recipient: "0x1234567890123456789012345678901234567890",
      },
    };

    const op = await adapter.initiate(req);

    expect(op.initiationTx).toBe(FAKE_SIGNATURE);
    expect(op.messageRef.source.id.value).toBe(FAKE_PDA);
  });

  test("SPL token transfer path sets initiationTx to Solana signature", async () => {
    (adapter as unknown as Record<string, unknown>).tokenMapping = {
      SoMeMiNtAdDrEsS: "0xRemoteToken",
    };

    const req: BridgeRequest = {
      route,
      action: {
        kind: "transfer",
        asset: { kind: "token", address: "SoMeMiNtAdDrEsS" },
        amount: 1_000_000n,
        recipient: "0x1234567890123456789012345678901234567890",
      },
    };

    const op = await adapter.initiate(req);

    expect(op.initiationTx).toBe(FAKE_SIGNATURE);
    expect(op.messageRef.source.id.value).toBe(FAKE_PDA);
  });

  test("wrapped token transfer path sets initiationTx to Solana signature", async () => {
    const req: BridgeRequest = {
      route,
      action: {
        kind: "transfer",
        asset: { kind: "wrapped", address: "WrappedMintAddr" },
        amount: 500_000n,
        recipient: "0x1234567890123456789012345678901234567890",
      },
    };

    const op = await adapter.initiate(req);

    expect(op.initiationTx).toBe(FAKE_SIGNATURE);
    expect(op.messageRef.source.id.value).toBe(FAKE_PDA);
  });
});
