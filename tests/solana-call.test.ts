import { test, expect, describe } from "bun:test";
import type {
  EvmCall,
  SolanaCall,
  DestinationCall,
  BridgeRoute,
} from "../src/core/types";
import {
  isSolanaDestinationCall,
  isEvmDestinationCall,
  isSolanaChainId,
  validateDestinationCall,
} from "../src/core/utils";

describe("isSolanaChainId", () => {
  test("returns true for solana:mainnet", () => {
    expect(isSolanaChainId("solana:mainnet")).toBe(true);
  });

  test("returns true for solana:devnet", () => {
    expect(isSolanaChainId("solana:devnet")).toBe(true);
  });

  test("returns false for EVM chain", () => {
    expect(isSolanaChainId("eip155:8453")).toBe(false);
  });
});

describe("isSolanaDestinationCall", () => {
  test("returns true for solana kind", () => {
    const solanaCall: SolanaCall = {
      instructions: [
        {
          programId: "11111111111111111111111111111111",
          accounts: [],
          data: new Uint8Array([]),
        },
      ],
    };
    const destCall: DestinationCall = { kind: "solana", call: solanaCall };
    expect(isSolanaDestinationCall(destCall)).toBe(true);
  });

  test("returns false for evm kind", () => {
    const evmCall: EvmCall = {
      to: "0x1234567890123456789012345678901234567890",
      value: 0n,
      data: "0x",
    };
    const destCall: DestinationCall = { kind: "evm", call: evmCall };
    expect(isSolanaDestinationCall(destCall)).toBe(false);
  });
});

describe("isEvmDestinationCall", () => {
  test("returns true for evm kind", () => {
    const evmCall: EvmCall = {
      to: "0x1234567890123456789012345678901234567890",
      value: 0n,
      data: "0x",
    };
    const destCall: DestinationCall = { kind: "evm", call: evmCall };
    expect(isEvmDestinationCall(destCall)).toBe(true);
  });

  test("returns false for solana kind", () => {
    const solanaCall: SolanaCall = {
      instructions: [],
    };
    const destCall: DestinationCall = { kind: "solana", call: solanaCall };
    expect(isEvmDestinationCall(destCall)).toBe(false);
  });
});

describe("validateDestinationCall", () => {
  const evmRoute: BridgeRoute = {
    sourceChain: "solana:mainnet",
    destinationChain: "eip155:8453",
  };

  const svmRoute: BridgeRoute = {
    sourceChain: "eip155:8453",
    destinationChain: "solana:mainnet",
  };

  const evmCall: EvmCall = {
    to: "0x1234567890123456789012345678901234567890",
    value: 100n,
    data: "0xd09de08a",
  };

  const solanaCall: SolanaCall = {
    instructions: [
      {
        programId: "11111111111111111111111111111111",
        accounts: [
          {
            pubkey: "22222222222222222222222222222222",
            isWritable: true,
            isSigner: false,
          },
        ],
        data: new Uint8Array([1, 2, 3]),
      },
    ],
  };

  test("validates SolanaCall for SVM destination", () => {
    const destCall: DestinationCall = { kind: "solana", call: solanaCall };
    expect(() => validateDestinationCall(destCall, svmRoute)).not.toThrow();
  });

  test("validates EvmCall for EVM destination", () => {
    const destCall: DestinationCall = { kind: "evm", call: evmCall };
    expect(() => validateDestinationCall(destCall, evmRoute)).not.toThrow();
  });

  test("throws for SolanaCall to EVM destination", () => {
    const destCall: DestinationCall = { kind: "solana", call: solanaCall };
    expect(() => validateDestinationCall(destCall, evmRoute)).toThrow(
      /route destination is EVM but call kind is "solana"/
    );
  });

  test("throws for EvmCall to SVM destination", () => {
    const destCall: DestinationCall = { kind: "evm", call: evmCall };
    expect(() => validateDestinationCall(destCall, svmRoute)).toThrow(
      /route destination is Solana but call kind is "evm"/
    );
  });
});
