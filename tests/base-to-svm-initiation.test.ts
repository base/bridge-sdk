import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BridgeError,
  BridgeProofNotAvailableError,
  BridgeUnsupportedActionError,
} from "../src/core/errors";
import {
  BASE_MAINNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
} from "../src/core/protocol/router";
import { BaseToSvmRouteAdapter } from "../src/core/protocol/routes/base-to-svm";
import type { BridgeRequest, BridgeRoute } from "../src/core/types";

const FAKE_TX_HASH =
  "0xaabbccddee00112233445566778899aabbccddee00112233445566778899aabb" as const;
const FAKE_MESSAGE_HASH =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const FAKE_MMR_ROOT =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
const FAKE_SENDER = "0x3333333333333333333333333333333333333333" as const;
const FAKE_DATA = "0xdeadbeef" as const;
const FAKE_NONCE = 42n;
const EVM_CALL_TO = "0x1234567890123456789012345678901234567890" as const;
const EVM_CALL_DATA = "0xd09de08a" as const;

const SOL_SYSTEM_PROGRAM = "11111111111111111111111111111111" as const;
const SOL_TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as const;
const SOL_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as const;
const SOL_RENT_SYSVAR = "SysvarRent111111111111111111111111111111111" as const;
const SOL_WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112" as const;
const SOL_CONFIG_PROGRAM =
  "Config1111111111111111111111111111111111111" as const;

const LOCAL_ERC20 = "0xLocalERC20Address" as const;

const route: BridgeRoute = {
  sourceChain: BASE_MAINNET_CHAIN_ID,
  destinationChain: SOLANA_MAINNET_CHAIN_ID,
};

function wireAdapter(
  engineStub: Record<string, unknown>,
  opts?: { tokenMapping?: Record<string, string> },
): BaseToSvmRouteAdapter {
  const adapter = Object.create(
    BaseToSvmRouteAdapter.prototype,
  ) as BaseToSvmRouteAdapter;

  const stub = adapter as unknown as Record<string, unknown>;
  stub.baseEngine = engineStub;
  stub.route = route;
  stub.tokenMapping = opts?.tokenMapping;

  // Stub extractMessageInitiated to avoid needing realistic EVM receipt logs.
  stub.extractMessageInitiated = mock(() =>
    Promise.resolve({
      messageHash: FAKE_MESSAGE_HASH,
      mmrRoot: FAKE_MMR_ROOT,
      nonce: FAKE_NONCE,
      sender: FAKE_SENDER,
      data: FAKE_DATA,
    }),
  );

  return adapter;
}

function buildAdapter(opts?: { tokenMapping?: Record<string, string> }) {
  const engineStub = {
    bridgeCall: mock(() => Promise.resolve(FAKE_TX_HASH)),
    bridgeToken: mock(() => Promise.resolve(FAKE_TX_HASH)),
  };

  return { adapter: wireAdapter(engineStub, opts), engineStub };
}

function makeSolanaInstruction(programId: string = SOL_SYSTEM_PROGRAM) {
  return {
    programId,
    accounts: [
      {
        pubkey: SOL_TOKEN_PROGRAM,
        isWritable: true,
        isSigner: false,
      },
    ],
    data: new Uint8Array([1, 2, 3, 4]),
  };
}

function makeCallRequest(
  instructions = [makeSolanaInstruction()],
): BridgeRequest {
  return {
    route,
    action: {
      kind: "call",
      call: { kind: "solana", call: { instructions } },
    },
  };
}

function makeTransferRequest(
  overrides: { address?: string; amount?: bigint; recipient?: string } = {},
): BridgeRequest {
  return {
    route,
    action: {
      kind: "transfer",
      asset: { kind: "token", address: overrides.address ?? LOCAL_ERC20 },
      amount: overrides.amount ?? 1_000_000n,
      recipient: overrides.recipient ?? SOL_RENT_SYSVAR,
    },
  };
}

function mockCallArg(
  // biome-ignore lint/suspicious/noExplicitAny: typed mock internals require any for generic call arg access
  stub: { mock: { calls: any[] } },
  callIndex = 0,
): Record<string, unknown> {
  return stub.mock.calls[callIndex][0] as Record<string, unknown>;
}

describe("BaseToSvmRouteAdapter.initiate – call path", () => {
  let adapter: BaseToSvmRouteAdapter;
  let engineStub: ReturnType<typeof buildAdapter>["engineStub"];

  const defaultCallReq = makeCallRequest();

  beforeEach(() => {
    ({ adapter, engineStub } = buildAdapter());
  });

  test("calls baseEngine.bridgeCall with converted instructions", async () => {
    await adapter.initiate(defaultCallReq);

    expect(engineStub.bridgeCall).toHaveBeenCalledTimes(1);
    expect(engineStub.bridgeToken).toHaveBeenCalledTimes(0);

    const callArgs = mockCallArg(engineStub.bridgeCall);
    expect(callArgs.ixs).toHaveLength(1);
  });

  test("returns BridgeOperation with correct initiationTx", async () => {
    const op = await adapter.initiate(defaultCallReq);

    expect(op.initiationTx).toBe(FAKE_TX_HASH);
  });

  test("returns BridgeOperation with evm:messageHash messageRef", async () => {
    const op = await adapter.initiate(defaultCallReq);

    expect(op.messageRef.source.id.scheme).toBe("evm:messageHash");
    expect(op.messageRef.source.id.value).toBe(FAKE_MESSAGE_HASH);
    expect(op.messageRef.source.chain).toBe(BASE_MAINNET_CHAIN_ID);
    expect(op.messageRef.route).toEqual(route);
  });

  test("populates derived fields on messageRef", async () => {
    const op = await adapter.initiate(defaultCallReq);

    expect(op.messageRef.derived).toBeDefined();
    expect(op.messageRef.derived?.txHash).toBe(FAKE_TX_HASH);
    expect(op.messageRef.derived?.nonce).toBe(FAKE_NONCE.toString());
    expect(op.messageRef.derived?.sender).toBe(FAKE_SENDER);
    expect(op.messageRef.derived?.data).toBe(FAKE_DATA);
    expect(op.messageRef.derived?.mmrRoot).toBe(FAKE_MMR_ROOT);
  });

  test("preserves request in returned operation", async () => {
    const op = await adapter.initiate(defaultCallReq);

    expect(op.request).toBe(defaultCallReq);
  });

  test("handles multiple Solana instructions", async () => {
    const req = makeCallRequest([
      makeSolanaInstruction(),
      makeSolanaInstruction(SOL_TOKEN_PROGRAM),
      makeSolanaInstruction(SOL_MEMO_PROGRAM),
    ]);

    const op = await adapter.initiate(req);

    expect(op.initiationTx).toBe(FAKE_TX_HASH);

    const callArgs = mockCallArg(engineStub.bridgeCall);
    expect(callArgs.ixs).toHaveLength(3);
  });

  test("calls baseEngine.bridgeCall with empty ixs when instructions array is empty", async () => {
    const req = makeCallRequest([]);

    const op = await adapter.initiate(req);

    expect(op.initiationTx).toBe(FAKE_TX_HASH);
    expect(engineStub.bridgeCall).toHaveBeenCalledTimes(1);

    const callArgs = mockCallArg(engineStub.bridgeCall);
    expect(callArgs.ixs).toHaveLength(0);
  });

  test("throws BridgeUnsupportedActionError for EVM destination call", async () => {
    const req: BridgeRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: EVM_CALL_TO,
            value: 0n,
            data: EVM_CALL_DATA,
            ty: 0,
          },
        },
      },
    };

    const error = await adapter.initiate(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeUnsupportedActionError);
    expect((error as BridgeUnsupportedActionError).code).toBe(
      "UNSUPPORTED_ACTION",
    );
  });
});

describe("BaseToSvmRouteAdapter.initiate – transfer path", () => {
  const TOKEN_MAPPING = {
    [LOCAL_ERC20]: SOL_WRAPPED_SOL_MINT,
  };

  let adapter: BaseToSvmRouteAdapter;
  let engineStub: ReturnType<typeof buildAdapter>["engineStub"];

  const defaultTransferReq = makeTransferRequest();

  beforeEach(() => {
    ({ adapter, engineStub } = buildAdapter({ tokenMapping: TOKEN_MAPPING }));
  });

  test("calls baseEngine.bridgeToken with correct transfer params", async () => {
    await adapter.initiate(defaultTransferReq);

    expect(engineStub.bridgeToken).toHaveBeenCalledTimes(1);
    expect(engineStub.bridgeCall).toHaveBeenCalledTimes(0);

    const callArgs = mockCallArg(engineStub.bridgeToken);
    const transfer = callArgs.transfer as Record<string, unknown>;
    expect(transfer.localToken).toBe(LOCAL_ERC20);
    expect(transfer.to).toBe(SOL_RENT_SYSVAR);
    expect(transfer.amount).toBe(1_000_000n);
    expect(callArgs.ixs).toHaveLength(0);
  });

  test("returns BridgeOperation with initiationTx", async () => {
    const op = await adapter.initiate(defaultTransferReq);

    expect(op.initiationTx).toBe(FAKE_TX_HASH);
  });

  test("returns BridgeOperation with evm:messageHash messageRef", async () => {
    const op = await adapter.initiate(defaultTransferReq);

    expect(op.messageRef.source.id.scheme).toBe("evm:messageHash");
    expect(op.messageRef.source.id.value).toBe(FAKE_MESSAGE_HASH);
    expect(op.messageRef.source.chain).toBe(BASE_MAINNET_CHAIN_ID);
    expect(op.messageRef.route).toEqual(route);
  });

  test("passes Solana instructions when transfer has optional call", async () => {
    const req: BridgeRequest = {
      route,
      action: {
        kind: "transfer",
        asset: { kind: "token", address: LOCAL_ERC20 },
        amount: 1_000_000n,
        recipient: SOL_RENT_SYSVAR,
        call: {
          kind: "solana",
          call: {
            instructions: [
              makeSolanaInstruction(),
              makeSolanaInstruction(SOL_MEMO_PROGRAM),
            ],
          },
        },
      },
    };

    await adapter.initiate(req);

    const callArgs = mockCallArg(engineStub.bridgeToken);
    expect(callArgs.ixs).toHaveLength(2);
  });

  test.each([
    { address: "0xTokenA", amount: 100n },
    { address: "0xTokenB", amount: 200n },
  ])("routes $address through its mapped Solana mint", async ({
    address,
    amount,
  }) => {
    const { adapter: a, engineStub: es } = buildAdapter({
      tokenMapping: {
        "0xTokenA": SOL_WRAPPED_SOL_MINT,
        "0xTokenB": SOL_CONFIG_PROGRAM,
      },
    });

    const req = makeTransferRequest({ address, amount });

    const op = await a.initiate(req);
    expect(op.initiationTx).toBe(FAKE_TX_HASH);
    expect(es.bridgeToken).toHaveBeenCalledTimes(1);
    const transfer = mockCallArg(es.bridgeToken).transfer as Record<
      string,
      unknown
    >;
    expect(transfer.localToken).toBe(address);
  });

  test("throws for unsupported asset kind (native)", async () => {
    const req: BridgeRequest = {
      route,
      action: {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1_000_000_000n,
        recipient: SOL_RENT_SYSVAR,
      },
    };

    const error = await adapter.initiate(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeUnsupportedActionError);
    expect((error as BridgeUnsupportedActionError).code).toBe(
      "UNSUPPORTED_ACTION",
    );
  });

  test("throws when token mapping is missing for ERC20", async () => {
    const { adapter: a } = buildAdapter({
      tokenMapping: { "0xOtherToken": SOL_WRAPPED_SOL_MINT },
    });

    const req = makeTransferRequest({ address: "0xUnknownToken" });

    await expect(a.initiate(req)).rejects.toBeInstanceOf(
      BridgeUnsupportedActionError,
    );
  });

  test("throws when tokenMapping is undefined", async () => {
    const { adapter: a } = buildAdapter(); // no tokenMapping

    const req = makeTransferRequest({ address: "0xSomeToken" });

    await expect(a.initiate(req)).rejects.toBeInstanceOf(
      BridgeUnsupportedActionError,
    );
  });

  test("throws BridgeUnsupportedActionError when transfer call is EVM kind", async () => {
    const req: BridgeRequest = {
      route,
      action: {
        kind: "transfer",
        asset: { kind: "token", address: LOCAL_ERC20 },
        amount: 1_000_000n,
        recipient: SOL_RENT_SYSVAR,
        call: {
          kind: "evm",
          call: {
            to: EVM_CALL_TO,
            value: 0n,
            data: EVM_CALL_DATA,
            ty: 0,
          },
        },
      },
    };

    await expect(adapter.initiate(req)).rejects.toBeInstanceOf(
      BridgeUnsupportedActionError,
    );
  });
});

describe("BaseToSvmRouteAdapter.initiate – edge cases", () => {
  test("propagates engine errors from bridgeCall", async () => {
    const engineStub = {
      bridgeCall: mock(() =>
        Promise.reject(new Error("Simulated RPC failure")),
      ),
      bridgeToken: mock(() => Promise.resolve(FAKE_TX_HASH)),
    };
    const adapter = wireAdapter(engineStub);

    const req = makeCallRequest();

    try {
      await adapter.initiate(req);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      if (!(err instanceof BridgeError)) throw err;
      expect(err.message).toBe("Simulated RPC failure");
      expect(err.code).toBe("RPC_ERROR");
      expect(err.outcome).toBe("retry");
      expect(err.stage).toBe("initiate");
      expect(err.route).toEqual(route);
      expect(err.chain).toBe(BASE_MAINNET_CHAIN_ID);
    }
  });

  test("propagates engine errors from bridgeToken", async () => {
    const engineStub = {
      bridgeCall: mock(() => Promise.resolve(FAKE_TX_HASH)),
      bridgeToken: mock(() =>
        Promise.reject(new Error("Simulated token bridge failure")),
      ),
    };
    const adapter = wireAdapter(engineStub, {
      tokenMapping: { "0xToken": SOL_WRAPPED_SOL_MINT },
    });

    const req = makeTransferRequest({ address: "0xToken" });

    try {
      await adapter.initiate(req);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      if (!(err instanceof BridgeError)) throw err;
      expect(err.message).toBe("Simulated token bridge failure");
      expect(err.code).toBe("RPC_ERROR");
      expect(err.outcome).toBe("retry");
      expect(err.stage).toBe("initiate");
      expect(err.route).toEqual(route);
      expect(err.chain).toBe(BASE_MAINNET_CHAIN_ID);
    }
  });

  test("propagates extractMessageInitiated error when zero events found (call path)", async () => {
    const engineStub = {
      bridgeCall: mock(() => Promise.resolve(FAKE_TX_HASH)),
      bridgeToken: mock(() => Promise.resolve(FAKE_TX_HASH)),
    };
    const adapter = wireAdapter(engineStub);

    (adapter as unknown as Record<string, unknown>).extractMessageInitiated =
      mock(() =>
        Promise.reject(
          new BridgeProofNotAvailableError(
            "Expected exactly 1 MessageInitiated event in tx receipt; found 0",
            { route, chain: BASE_MAINNET_CHAIN_ID },
          ),
        ),
      );

    const req = makeCallRequest();

    try {
      await adapter.initiate(req);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeProofNotAvailableError);
      if (!(err instanceof BridgeProofNotAvailableError)) throw err;
      expect(err.code).toBe("PROOF_NOT_AVAILABLE");
      expect(err.outcome).toBe("retry");
      expect(err.stage).toBe("prove");
      expect(err.message).toContain("found 0");
    }

    expect(engineStub.bridgeCall).toHaveBeenCalledTimes(1);
  });

  test("propagates extractMessageInitiated error when multiple events found (transfer path)", async () => {
    const engineStub = {
      bridgeCall: mock(() => Promise.resolve(FAKE_TX_HASH)),
      bridgeToken: mock(() => Promise.resolve(FAKE_TX_HASH)),
    };
    const adapter = wireAdapter(engineStub, {
      tokenMapping: { "0xToken": SOL_WRAPPED_SOL_MINT },
    });

    (adapter as unknown as Record<string, unknown>).extractMessageInitiated =
      mock(() =>
        Promise.reject(
          new BridgeProofNotAvailableError(
            "Expected exactly 1 MessageInitiated event in tx receipt; found 3",
            { route, chain: BASE_MAINNET_CHAIN_ID },
          ),
        ),
      );

    const req = makeTransferRequest({ address: "0xToken" });

    try {
      await adapter.initiate(req);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeProofNotAvailableError);
      if (!(err instanceof BridgeProofNotAvailableError)) throw err;
      expect(err.code).toBe("PROOF_NOT_AVAILABLE");
      expect(err.outcome).toBe("retry");
      expect(err.stage).toBe("prove");
      expect(err.message).toContain("found 3");
    }

    expect(engineStub.bridgeToken).toHaveBeenCalledTimes(1);
  });

  test("propagates RPC error from extractMessageInitiated receipt fetch", async () => {
    const engineStub = {
      bridgeCall: mock(() => Promise.resolve(FAKE_TX_HASH)),
      bridgeToken: mock(() => Promise.resolve(FAKE_TX_HASH)),
    };
    const adapter = wireAdapter(engineStub);

    (adapter as unknown as Record<string, unknown>).extractMessageInitiated =
      mock(() =>
        Promise.reject(
          new BridgeError({
            message: "Failed to fetch transaction receipt",
            code: "RPC_ERROR",
            outcome: "retry",
            stage: "initiate",
            route,
            chain: BASE_MAINNET_CHAIN_ID,
          }),
        ),
      );

    const req = makeCallRequest();

    try {
      await adapter.initiate(req);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      if (!(err instanceof BridgeError)) throw err;
      expect(err.code).toBe("RPC_ERROR");
      expect(err.outcome).toBe("retry");
      expect(err.message).toBe("Failed to fetch transaction receipt");
      expect(err.chain).toBe(BASE_MAINNET_CHAIN_ID);
    }

    expect(engineStub.bridgeCall).toHaveBeenCalledTimes(1);
  });

  test("preserves BridgeError subclass identity through wrapEngineError", async () => {
    const subclassError = new BridgeUnsupportedActionError({
      route,
      actionKind: "call",
    });
    // BridgeUnsupportedActionError sets route but not chain; wrapEngineError
    // should patch the missing chain without re-wrapping.
    expect(subclassError.chain).toBeUndefined();

    const engineStub = {
      bridgeCall: mock(() => Promise.reject(subclassError)),
      bridgeToken: mock(() => Promise.resolve(FAKE_TX_HASH)),
    };
    const adapter = wireAdapter(engineStub);

    const req = makeCallRequest();

    try {
      await adapter.initiate(req);
      expect.unreachable("should have thrown");
    } catch (err) {
      // Subclass identity is preserved — not re-wrapped into a plain BridgeError.
      expect(err).toBeInstanceOf(BridgeUnsupportedActionError);
      if (!(err instanceof BridgeUnsupportedActionError)) throw err;
      expect(err).toBe(subclassError); // same reference, not a copy
      expect(err.code).toBe("UNSUPPORTED_ACTION");
      expect(err.outcome).toBe("user_fix");
      expect(err.route).toEqual(route);
      // chain was patched in by wrapEngineError
      expect(err.chain).toBe(BASE_MAINNET_CHAIN_ID);
    }
  });
});
