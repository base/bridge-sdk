import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BASE_MAINNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
} from "../src/core/protocol/router";
import { SvmToBaseRouteAdapter } from "../src/core/protocol/routes/svm-to-base";
import type { BridgeRequest, BridgeRoute } from "../src/core/types";

const FAKE_PDA = "11111111111111111111111111111112" as const;
const FAKE_SIGNATURE =
  "5wHu1qwD7dZ8x1J9Z9Lf2qQzK5dN1j7Z9fZ8x1J9Z9Lf2qQzK5dN1j7Z9fZ8x1J9Z9Lf2qQzK5dN1j7Z9fZ8x1" as const;
const FAKE_OUTER_HASH = "0xabc123" as const;
const FAKE_BUFFER_ADDRESS =
  "BuFf3rAddre55111111111111111111111111111111" as const;
const FAKE_INIT_SIG =
  "InitSig111111111111111111111111111111111111111111111111111111111111111111111111111111111111" as const;
const FAKE_APPEND_SIG =
  "AppendSig1111111111111111111111111111111111111111111111111111111111111111111111111111111111" as const;
const FAKE_BRIDGE_SIG =
  "BridgeSig1111111111111111111111111111111111111111111111111111111111111111111111111111111111" as const;

const route: BridgeRoute = {
  sourceChain: SOLANA_MAINNET_CHAIN_ID,
  destinationChain: BASE_MAINNET_CHAIN_ID,
};

/**
 * Generate a hex string of the given byte length (0x-prefixed).
 */
function makeHexData(byteLen: number): `0x${string}` {
  return `0x${"ab".repeat(byteLen)}` as `0x${string}`;
}

/**
 * Wire an engine stub and common mocks onto an adapter prototype instance.
 */
function wireAdapter(
  engineStub: Record<string, unknown>,
): SvmToBaseRouteAdapter {
  const adapter = Object.create(
    SvmToBaseRouteAdapter.prototype,
  ) as SvmToBaseRouteAdapter;

  const stub = adapter as unknown as Record<string, unknown>;
  stub.solanaEngine = engineStub;
  stub.route = route;
  stub.deriveOuterHash = mock(() => Promise.resolve(FAKE_OUTER_HASH));

  return adapter;
}

/** Inline bridge method mocks shared by both adapter builders. */
function inlineBridgeMocks() {
  return {
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
}

/**
 * Build an adapter with engine methods stubbed so we never hit Solana RPC.
 */
function buildAdapter(): SvmToBaseRouteAdapter {
  return wireAdapter(inlineBridgeMocks());
}

/**
 * Build an adapter whose engine also has call-buffer methods stubbed,
 * used for testing the buffered path.
 */
function buildBufferedAdapter() {
  const engineStub = {
    ...inlineBridgeMocks(),
    // Buffer lifecycle
    initializeCallBuffer: mock(() =>
      Promise.resolve({
        bufferAddress: FAKE_BUFFER_ADDRESS,
        signature: FAKE_INIT_SIG,
      }),
    ),
    appendToCallBuffer: mock(() =>
      Promise.resolve({ signature: FAKE_APPEND_SIG }),
    ),
    closeCallBuffer: mock(() => Promise.resolve({ signature: "closeSig" })),
    // Buffered bridge
    bridgeCallBuffered: mock(() =>
      Promise.resolve({ outgoingPda: FAKE_PDA, signature: FAKE_BRIDGE_SIG }),
    ),
    bridgeSolWithBufferedCall: mock(() =>
      Promise.resolve({ outgoingPda: FAKE_PDA, signature: FAKE_BRIDGE_SIG }),
    ),
    bridgeSplWithBufferedCall: mock(() =>
      Promise.resolve({ outgoingPda: FAKE_PDA, signature: FAKE_BRIDGE_SIG }),
    ),
    bridgeWrappedTokenWithBufferedCall: mock(() =>
      Promise.resolve({ outgoingPda: FAKE_PDA, signature: FAKE_BRIDGE_SIG }),
    ),
  };

  return { adapter: wireAdapter(engineStub), engineStub };
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

// ─────────────────────────────────────────────────────────────────────────────
// Call data buffering tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SvmToBaseRouteAdapter: inline vs buffered path selection", () => {
  test("small call data (<= 900 bytes) uses inline bridgeCall", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();

    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(100), // 100 bytes — well under threshold
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    expect(engineStub.bridgeCall).toHaveBeenCalledTimes(1);
    expect(engineStub.initializeCallBuffer).toHaveBeenCalledTimes(0);
    expect(engineStub.bridgeCallBuffered).toHaveBeenCalledTimes(0);
    expect(op.initiationTx).toBe(FAKE_SIGNATURE);
    expect(op.auxiliaryTxs).toBeUndefined();
  });

  test("large call data (> 900 bytes) uses buffered path", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();

    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(1000), // 1000 bytes — exceeds threshold
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    expect(engineStub.bridgeCall).toHaveBeenCalledTimes(0);
    expect(engineStub.initializeCallBuffer).toHaveBeenCalledTimes(1);
    expect(engineStub.bridgeCallBuffered).toHaveBeenCalledTimes(1);
    expect(op.initiationTx).toBe(FAKE_BRIDGE_SIG);
    expect(op.auxiliaryTxs).toBeDefined();
    expect(op.auxiliaryTxs?.length).toBeGreaterThanOrEqual(1);
    expect(op.auxiliaryTxs?.[0]).toBe(FAKE_INIT_SIG);
  });

  test("exactly 900 bytes uses inline path", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();

    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(900), // exactly 900 bytes — at threshold
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    expect(engineStub.bridgeCall).toHaveBeenCalledTimes(1);
    expect(engineStub.initializeCallBuffer).toHaveBeenCalledTimes(0);
    expect(op.auxiliaryTxs).toBeUndefined();
  });

  test("901 bytes uses buffered path", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();

    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(901), // 901 bytes — just over threshold
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    expect(engineStub.bridgeCall).toHaveBeenCalledTimes(0);
    expect(engineStub.initializeCallBuffer).toHaveBeenCalledTimes(1);
    expect(engineStub.bridgeCallBuffered).toHaveBeenCalledTimes(1);
    expect(op.initiationTx).toBe(FAKE_BRIDGE_SIG);
  });
});

describe("SvmToBaseRouteAdapter: buffered path chunking", () => {
  test("data exceeding init chunk produces one append call", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();

    // 901 bytes total: 800 bytes in init chunk + 101 bytes in one append
    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 42n,
            data: makeHexData(901),
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    // init sends first 800 bytes, remaining 101 bytes need 1 append
    expect(engineStub.initializeCallBuffer).toHaveBeenCalledTimes(1);
    expect(engineStub.appendToCallBuffer).toHaveBeenCalledTimes(1);
    expect(engineStub.bridgeCallBuffered).toHaveBeenCalledTimes(1);

    // auxiliaryTxs = [initSig, appendSig]
    expect(op.auxiliaryTxs).toHaveLength(2);
    expect(op.auxiliaryTxs?.[0]).toBe(FAKE_INIT_SIG);
    expect(op.auxiliaryTxs?.[1]).toBe(FAKE_APPEND_SIG);
    expect(op.initiationTx).toBe(FAKE_BRIDGE_SIG);
  });

  test("large payload produces multiple append calls", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();

    // 2600 bytes total:
    //   init chunk: 800 bytes
    //   remaining: 1800 bytes -> ceil(1800/900) = 2 appends
    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(2600),
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    expect(engineStub.initializeCallBuffer).toHaveBeenCalledTimes(1);
    expect(engineStub.appendToCallBuffer).toHaveBeenCalledTimes(2);
    expect(engineStub.bridgeCallBuffered).toHaveBeenCalledTimes(1);

    // auxiliaryTxs = [initSig, appendSig1, appendSig2]
    expect(op.auxiliaryTxs).toHaveLength(3);
  });

  test("initializeCallBuffer receives correct maxDataLen", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();
    const dataSize = 1500;

    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(dataSize),
            ty: 0,
          },
        },
      },
    };

    await adapter.initiate(req);

    const calls = engineStub.initializeCallBuffer.mock.calls;
    expect(calls.length).toBe(1);
    // biome-ignore lint: test assertion
    expect((calls as any)[0][0].maxDataLen).toBe(BigInt(dataSize));
  });
});

describe("SvmToBaseRouteAdapter: buffered transfer paths", () => {
  test("native transfer with large call uses buffered SOL bridge", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();

    const req: BridgeRequest = {
      route,
      action: {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1_000_000_000n,
        recipient: "0x1234567890123456789012345678901234567890",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(1200),
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    expect(engineStub.bridgeSol).toHaveBeenCalledTimes(0);
    expect(engineStub.bridgeSolWithBufferedCall).toHaveBeenCalledTimes(1);
    expect(engineStub.initializeCallBuffer).toHaveBeenCalledTimes(1);
    expect(op.initiationTx).toBe(FAKE_BRIDGE_SIG);
    expect(op.auxiliaryTxs).toBeDefined();
  });

  test("native transfer with small call uses inline path", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();

    const req: BridgeRequest = {
      route,
      action: {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1_000_000_000n,
        recipient: "0x1234567890123456789012345678901234567890",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(100),
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    expect(engineStub.bridgeSol).toHaveBeenCalledTimes(1);
    expect(engineStub.bridgeSolWithBufferedCall).toHaveBeenCalledTimes(0);
    expect(op.auxiliaryTxs).toBeUndefined();
  });

  test("native transfer without call uses inline path", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();

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

    expect(engineStub.bridgeSol).toHaveBeenCalledTimes(1);
    expect(engineStub.bridgeSolWithBufferedCall).toHaveBeenCalledTimes(0);
    expect(op.auxiliaryTxs).toBeUndefined();
  });

  test("SPL transfer with large call uses buffered SPL bridge", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();
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
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(1200),
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    expect(engineStub.bridgeSpl).toHaveBeenCalledTimes(0);
    expect(engineStub.bridgeSplWithBufferedCall).toHaveBeenCalledTimes(1);
    expect(engineStub.initializeCallBuffer).toHaveBeenCalledTimes(1);
    expect(op.initiationTx).toBe(FAKE_BRIDGE_SIG);
    expect(op.auxiliaryTxs).toBeDefined();
  });

  test("wrapped transfer with large call uses buffered wrapped bridge", async () => {
    const { adapter, engineStub } = buildBufferedAdapter();

    const req: BridgeRequest = {
      route,
      action: {
        kind: "transfer",
        asset: { kind: "wrapped", address: "WrappedMintAddr" },
        amount: 500_000n,
        recipient: "0x1234567890123456789012345678901234567890",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(1200),
            ty: 0,
          },
        },
      },
    };

    const op = await adapter.initiate(req);

    expect(engineStub.bridgeWrapped).toHaveBeenCalledTimes(0);
    expect(engineStub.bridgeWrappedTokenWithBufferedCall).toHaveBeenCalledTimes(
      1,
    );
    expect(engineStub.initializeCallBuffer).toHaveBeenCalledTimes(1);
    expect(op.initiationTx).toBe(FAKE_BRIDGE_SIG);
    expect(op.auxiliaryTxs).toBeDefined();
  });
});

describe("SvmToBaseRouteAdapter: buffer cleanup on bridge failure", () => {
  test("closeCallBuffer is called when append fails", async () => {
    const closeCallBuffer = mock(() =>
      Promise.resolve({ signature: "closeSig" }),
    );

    const engineStub = {
      ...inlineBridgeMocks(),
      initializeCallBuffer: mock(() =>
        Promise.resolve({
          bufferAddress: FAKE_BUFFER_ADDRESS,
          signature: FAKE_INIT_SIG,
        }),
      ),
      appendToCallBuffer: mock(() =>
        Promise.reject(new Error("Simulated append failure")),
      ),
      closeCallBuffer,
      bridgeCallBuffered: mock(() =>
        Promise.resolve({ outgoingPda: FAKE_PDA, signature: FAKE_BRIDGE_SIG }),
      ),
    };

    const adapter = wireAdapter(engineStub);

    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(1200), // needs init + append
            ty: 0,
          },
        },
      },
    };

    await expect(adapter.initiate(req)).rejects.toThrow(
      "Simulated append failure",
    );

    expect(engineStub.bridgeCallBuffered).toHaveBeenCalledTimes(0);
    expect(closeCallBuffer).toHaveBeenCalledTimes(1);
  });

  test("closeCallBuffer is called when bridge fails", async () => {
    const closeCallBuffer = mock(() =>
      Promise.resolve({ signature: "closeSig" }),
    );

    const engineStub = {
      ...inlineBridgeMocks(),
      initializeCallBuffer: mock(() =>
        Promise.resolve({
          bufferAddress: FAKE_BUFFER_ADDRESS,
          signature: FAKE_INIT_SIG,
        }),
      ),
      appendToCallBuffer: mock(() =>
        Promise.resolve({ signature: FAKE_APPEND_SIG }),
      ),
      closeCallBuffer,
      bridgeCallBuffered: mock(() =>
        Promise.reject(new Error("Simulated bridge failure")),
      ),
    };

    const adapter = wireAdapter(engineStub);

    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: makeHexData(1200),
            ty: 0,
          },
        },
      },
    };

    await expect(adapter.initiate(req)).rejects.toThrow(
      "Simulated bridge failure",
    );

    expect(closeCallBuffer).toHaveBeenCalledTimes(1);
    // biome-ignore lint: test assertion
    expect((closeCallBuffer.mock.calls as any)[0][0].bufferAddress).toBe(
      FAKE_BUFFER_ADDRESS,
    );
  });
});
