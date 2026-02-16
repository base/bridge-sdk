import { describe, expect, test } from "bun:test";
import { BASE_MAINNET_CHAIN_ID } from "../src/core/protocol/router";
import type {
  BridgeRoute,
  FeeEstimate,
  Quote,
  QuoteRequest,
} from "../src/core/types";

describe("Quote types", () => {
  test("FeeEstimate supports optional note field", () => {
    const feeWithNote: FeeEstimate = {
      amount: 1000n,
      token: "ETH",
      note: "paid by relayer",
    };

    const feeWithoutNote: FeeEstimate = {
      amount: 500n,
      token: "SOL",
    };

    expect(feeWithNote.note).toBe("paid by relayer");
    expect(feeWithoutNote.note).toBeUndefined();
  });

  test("Quote structure contains required fields", () => {
    const route: BridgeRoute = {
      sourceChain: "solana:mainnet",
      destinationChain: BASE_MAINNET_CHAIN_ID,
    };

    const quote: Quote = {
      route,
      estimatedFees: {
        source: {
          amount: 15000n,
          token: "SOL",
        },
      },
      estimatedTimeMs: {
        min: 30000,
        max: 120000,
      },
    };

    expect(quote.route).toEqual(route);
    expect(quote.estimatedFees.source.amount).toBe(15000n);
    expect(quote.estimatedFees.source.token).toBe("SOL");
    expect(quote.estimatedTimeMs.min).toBe(30000);
    expect(quote.estimatedTimeMs.max).toBe(120000);
  });

  test("Quote supports optional destination and relay fees", () => {
    const route: BridgeRoute = {
      sourceChain: "solana:mainnet",
      destinationChain: BASE_MAINNET_CHAIN_ID,
    };

    const quote: Quote = {
      route,
      estimatedFees: {
        source: {
          amount: 15000n,
          token: "SOL",
        },
        destination: {
          amount: 100000n,
          token: "ETH",
          note: "paid by relayer",
        },
        relay: {
          amount: 50000n,
          token: "SOL",
        },
      },
      estimatedTimeMs: {
        min: 30000,
        max: 120000,
      },
    };

    expect(quote.estimatedFees.destination?.amount).toBe(100000n);
    expect(quote.estimatedFees.destination?.note).toBe("paid by relayer");
    expect(quote.estimatedFees.relay?.amount).toBe(50000n);
  });

  test("Quote supports optional limits and warnings", () => {
    const route: BridgeRoute = {
      sourceChain: BASE_MAINNET_CHAIN_ID,
      destinationChain: "solana:mainnet",
    };

    const quote: Quote = {
      route,
      estimatedFees: {
        source: {
          amount: 1000000000000000n,
          token: "ETH",
        },
        destination: {
          amount: 15000n,
          token: "SOL",
        },
      },
      estimatedTimeMs: {
        min: 60000,
        max: 300000,
      },
      limits: {
        min: 1000000n,
        max: 1000000000000n,
      },
      warnings: ["Source gas estimation failed, using conservative estimate"],
    };

    expect(quote.limits?.min).toBe(1000000n);
    expect(quote.limits?.max).toBe(1000000000000n);
    expect(quote.warnings).toHaveLength(1);
    expect(quote.warnings?.[0]).toContain("conservative estimate");
  });

  test("QuoteRequest mirrors BridgeRequest structure", () => {
    const route: BridgeRoute = {
      sourceChain: "solana:mainnet",
      destinationChain: BASE_MAINNET_CHAIN_ID,
    };

    const quoteRequest: QuoteRequest = {
      route,
      action: {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0x1234567890123456789012345678901234567890",
            value: 0n,
            data: "0x",
            ty: 0,
          },
        },
      },
      relay: {
        mode: "auto",
        gasLimit: 200000n,
      },
    };

    expect(quoteRequest.route).toEqual(route);
    expect(quoteRequest.action.kind).toBe("call");
    expect(quoteRequest.relay?.mode).toBe("auto");
    expect(quoteRequest.relay?.gasLimit).toBe(200000n);
  });

  test("QuoteRequest supports transfer action", () => {
    const route: BridgeRoute = {
      sourceChain: "solana:mainnet",
      destinationChain: BASE_MAINNET_CHAIN_ID,
    };

    const quoteRequest: QuoteRequest = {
      route,
      action: {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1000000000n,
        recipient: "0x1234567890123456789012345678901234567890",
      },
    };

    expect(quoteRequest.action.kind).toBe("transfer");
    if (quoteRequest.action.kind === "transfer") {
      expect(quoteRequest.action.asset.kind).toBe("native");
      expect(quoteRequest.action.amount).toBe(1000000000n);
    }
  });
});

describe("Quote validation logic", () => {
  test("gas limit validation - below minimum", () => {
    const gasLimit = 50000n;
    const minGasLimit = 100000n;
    const maxGasLimit = 1000000n;
    const warnings: string[] = [];

    if (gasLimit < minGasLimit) {
      warnings.push(`Gas limit ${gasLimit} is below minimum ${minGasLimit}`);
    }
    if (gasLimit > maxGasLimit) {
      warnings.push(`Gas limit ${gasLimit} exceeds maximum ${maxGasLimit}`);
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("below minimum");
  });

  test("gas limit validation - above maximum", () => {
    const gasLimit = 2000000n;
    const minGasLimit = 100000n;
    const maxGasLimit = 1000000n;
    const warnings: string[] = [];

    if (gasLimit < minGasLimit) {
      warnings.push(`Gas limit ${gasLimit} is below minimum ${minGasLimit}`);
    }
    if (gasLimit > maxGasLimit) {
      warnings.push(`Gas limit ${gasLimit} exceeds maximum ${maxGasLimit}`);
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exceeds maximum");
  });

  test("relay fee calculation", () => {
    const gasLimit = 100000n;
    const gasCostScaler = 1000000n;
    const gasCostScalerDp = 1000n;

    const relayFee = (gasLimit * gasCostScaler) / gasCostScalerDp;

    expect(relayFee).toBe(100000000n);
  });

  test("source gas cost calculation", () => {
    const sourceGas = 150000n;
    const gasPrice = 1000000000n; // 1 gwei

    const sourceGasCost = sourceGas * gasPrice;

    expect(sourceGasCost).toBe(150000000000000n);
  });
});
