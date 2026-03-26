import { describe, expect, test } from "bun:test";
import { BridgeValidationError } from "../src/core/errors";
import {
  type BridgeAction,
  type BridgeRoute,
  type DestinationCall,
  EvmCallType,
} from "../src/core/types";
import {
  validateAction,
  validateAmount,
  validateDestinationCallFields,
  validateEvmAddress,
  validateEvmCallData,
  validateEvmCallType,
  validateEvmCallValue,
  validateRecipientAddress,
  validateSolanaAddress,
  validateSolanaInstructionData,
} from "../src/core/validation";

describe("validateAmount", () => {
  describe("rejects invalid amounts", () => {
    test("throws for zero amount", () => {
      expect(() => validateAmount(0n)).toThrow(
        "Amount must be greater than zero",
      );
    });

    test("throws for negative amount", () => {
      expect(() => validateAmount(-1n)).toThrow(
        "Amount must be greater than zero",
      );
    });

    test("throws for amount exceeding uint64 max (2^64)", () => {
      expect(() => validateAmount(2n ** 64n)).toThrow(
        "Amount exceeds maximum transferable amount",
      );
    });
  });

  describe("accepts valid amounts", () => {
    test("accepts minimum valid amount (1)", () => {
      expect(() => validateAmount(1n)).not.toThrow();
    });

    test("accepts maximum valid amount (2^64 - 1)", () => {
      expect(() => validateAmount(2n ** 64n - 1n)).not.toThrow();
    });

    test("accepts typical SOL amount (1 SOL = 1e9 lamports)", () => {
      expect(() => validateAmount(1_000_000_000n)).not.toThrow();
    });

    test("accepts typical token amount", () => {
      expect(() => validateAmount(100_000_000n)).not.toThrow();
    });
  });

  describe("error properties", () => {
    test("thrown error is a BridgeValidationError with expected fields", () => {
      let error: BridgeValidationError | undefined;
      try {
        validateAmount(0n);
      } catch (e) {
        error = e as BridgeValidationError;
      }
      expect(error).toBeInstanceOf(BridgeValidationError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.outcome).toBe("user_fix");
      expect(error?.stage).toBe("initiate");
    });
  });
});

describe("validateEvmAddress", () => {
  const VALID_LOWER = "0x644e3dedb0e4f83bfcf8f9992964d240224b74dc";
  const VALID_CHECKSUM = "0x644e3DedB0e4F83Bfcf8F9992964d240224B74dc";
  const VALID_UPPER = "0x644E3DEDB0E4F83BFCF8F9992964D240224B74DC";

  describe("rejects invalid addresses", () => {
    test("throws for empty string", () => {
      expect(() => validateEvmAddress("")).toThrow("Invalid EVM address");
    });

    test("throws for missing 0x prefix", () => {
      expect(() =>
        validateEvmAddress("644e3dedb0e4f83bfcf8f9992964d240224b74dc"),
      ).toThrow("Invalid EVM address");
    });

    test("throws for too-short address", () => {
      expect(() => validateEvmAddress("0x1234")).toThrow("Invalid EVM address");
    });

    test("throws for too-long address", () => {
      expect(() => validateEvmAddress(`0x${"a".repeat(41)}`)).toThrow(
        "Invalid EVM address",
      );
    });

    test("throws for non-hex characters", () => {
      expect(() =>
        validateEvmAddress("0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG"),
      ).toThrow("Invalid EVM address");
    });

    test("throws for address without 0x but correct length", () => {
      expect(() =>
        validateEvmAddress("xx644e3dedb0e4f83bfcf8f9992964d240224b74dc"),
      ).toThrow("Invalid EVM address");
    });
  });

  describe("accepts valid addresses", () => {
    test("accepts lowercase address", () => {
      expect(() => validateEvmAddress(VALID_LOWER)).not.toThrow();
    });

    test("accepts checksummed address", () => {
      expect(() => validateEvmAddress(VALID_CHECKSUM)).not.toThrow();
    });

    test("accepts uppercase address", () => {
      expect(() => validateEvmAddress(VALID_UPPER)).not.toThrow();
    });

    test("accepts zero address", () => {
      expect(() =>
        validateEvmAddress("0x0000000000000000000000000000000000000000"),
      ).not.toThrow();
    });
  });

  describe("error properties", () => {
    test("thrown error is a BridgeValidationError", () => {
      let error: BridgeValidationError | undefined;
      try {
        validateEvmAddress("bad");
      } catch (e) {
        error = e as BridgeValidationError;
      }
      expect(error).toBeInstanceOf(BridgeValidationError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.outcome).toBe("user_fix");
    });

    test("error message includes the invalid value", () => {
      expect(() => validateEvmAddress("not-an-address")).toThrow(
        'got "not-an-address"',
      );
    });

    test("truncates long invalid values in error message", () => {
      const long = `0x${"g".repeat(100)}`;
      let message = "";
      try {
        validateEvmAddress(long);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("…");
      expect(message.length).toBeLessThan(long.length + 100);
    });
  });
});

describe("validateSolanaAddress", () => {
  // Solana system program (32 ones)
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  // A typical Solana public key (44 chars)
  const TYPICAL_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  describe("rejects invalid addresses", () => {
    test("throws for empty string", () => {
      expect(() => validateSolanaAddress("")).toThrow("Invalid Solana address");
    });

    test("throws for too-short string (31 chars)", () => {
      expect(() => validateSolanaAddress("1".repeat(31))).toThrow(
        "Invalid Solana address",
      );
    });

    test("throws for too-long string (45 chars)", () => {
      expect(() => validateSolanaAddress("1".repeat(45))).toThrow(
        "Invalid Solana address",
      );
    });

    test("throws for invalid base58 character '0' (zero)", () => {
      expect(() => validateSolanaAddress(`0${"1".repeat(31)}`)).toThrow(
        "Invalid Solana address",
      );
    });

    test("throws for invalid base58 character 'O'", () => {
      expect(() => validateSolanaAddress(`O${"1".repeat(31)}`)).toThrow(
        "Invalid Solana address",
      );
    });

    test("throws for invalid base58 character 'I'", () => {
      expect(() => validateSolanaAddress(`I${"1".repeat(31)}`)).toThrow(
        "Invalid Solana address",
      );
    });

    test("throws for invalid base58 character 'l'", () => {
      expect(() => validateSolanaAddress(`l${"1".repeat(31)}`)).toThrow(
        "Invalid Solana address",
      );
    });

    test("throws for EVM-style address", () => {
      expect(() =>
        validateSolanaAddress("0x644e3dedb0e4f83bfcf8f9992964d240224b74dc"),
      ).toThrow("Invalid Solana address");
    });
  });

  describe("accepts valid addresses", () => {
    test("accepts 32-char address (system program)", () => {
      expect(() => validateSolanaAddress(SYSTEM_PROGRAM)).not.toThrow();
    });

    test("accepts typical 44-char address", () => {
      expect(() => validateSolanaAddress(TYPICAL_ADDRESS)).not.toThrow();
    });

    test("accepts 43-char address", () => {
      expect(() => validateSolanaAddress("A".repeat(43))).not.toThrow();
    });
  });

  describe("error properties", () => {
    test("thrown error is a BridgeValidationError", () => {
      let error: BridgeValidationError | undefined;
      try {
        validateSolanaAddress("bad");
      } catch (e) {
        error = e as BridgeValidationError;
      }
      expect(error).toBeInstanceOf(BridgeValidationError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.outcome).toBe("user_fix");
    });
  });
});

describe("validateRecipientAddress", () => {
  const evmRoute = {
    sourceChain: "solana:mainnet",
    destinationChain: "eip155:8453",
  };
  const solanaRoute = {
    sourceChain: "eip155:8453",
    destinationChain: "solana:mainnet",
  };

  test("validates as EVM when destination is an EVM chain", () => {
    expect(() =>
      validateRecipientAddress(
        "0x644e3dedb0e4f83bfcf8f9992964d240224b74dc",
        evmRoute,
      ),
    ).not.toThrow();
    expect(() =>
      validateRecipientAddress("not-an-evm-address", evmRoute),
    ).toThrow("Invalid EVM address");
  });

  test("validates as Solana when destination is a Solana chain", () => {
    expect(() =>
      validateRecipientAddress(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        solanaRoute,
      ),
    ).not.toThrow();
    expect(() => validateRecipientAddress("0xinvalid", solanaRoute)).toThrow(
      "Invalid Solana address",
    );
  });

  test("dispatches correctly for devnet Solana destination", () => {
    const devnetRoute = {
      sourceChain: "eip155:84532",
      destinationChain: "solana:devnet",
    };
    expect(() =>
      validateRecipientAddress("11111111111111111111111111111111", devnetRoute),
    ).not.toThrow();
  });
});

describe("validateEvmCallData", () => {
  describe("rejects invalid data", () => {
    test("throws for non-hex string", () => {
      expect(() => validateEvmCallData("not-hex")).toThrow(
        "Invalid EVM call data",
      );
    });

    test("throws for hex without 0x prefix", () => {
      expect(() => validateEvmCallData("1234abcd")).toThrow(
        "Invalid EVM call data",
      );
    });

    test("throws for 0x with non-hex characters", () => {
      expect(() => validateEvmCallData("0xGGGG")).toThrow(
        "Invalid EVM call data",
      );
    });
  });

  describe("accepts valid data", () => {
    test("accepts empty calldata (0x)", () => {
      expect(() => validateEvmCallData("0x")).not.toThrow();
    });

    test("accepts typical function selector", () => {
      expect(() => validateEvmCallData("0xd09de08a")).not.toThrow();
    });

    test("accepts longer calldata", () => {
      expect(() =>
        validateEvmCallData(
          "0xd09de08a0000000000000000000000000000000000000000000000000000000000000001",
        ),
      ).not.toThrow();
    });
  });

  describe("error properties", () => {
    test("thrown error is a BridgeValidationError", () => {
      let error: BridgeValidationError | undefined;
      try {
        validateEvmCallData("bad");
      } catch (e) {
        error = e as BridgeValidationError;
      }
      expect(error).toBeInstanceOf(BridgeValidationError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.outcome).toBe("user_fix");
    });
  });
});

describe("validateSolanaInstructionData", () => {
  describe("rejects invalid data", () => {
    test("throws for non-hex string", () => {
      expect(() =>
        validateSolanaInstructionData("not-hex" as `0x${string}`),
      ).toThrow("Invalid Solana instruction data");
    });

    test("throws for hex without 0x prefix", () => {
      expect(() =>
        validateSolanaInstructionData("1234abcd" as `0x${string}`),
      ).toThrow("Invalid Solana instruction data");
    });

    test("throws for 0x with non-hex characters", () => {
      expect(() =>
        validateSolanaInstructionData("0xGGGG" as `0x${string}`),
      ).toThrow("Invalid Solana instruction data");
    });
  });

  describe("accepts valid data", () => {
    test("accepts empty Uint8Array", () => {
      expect(() =>
        validateSolanaInstructionData(new Uint8Array()),
      ).not.toThrow();
    });

    test("accepts non-empty Uint8Array", () => {
      expect(() =>
        validateSolanaInstructionData(new Uint8Array([1, 2, 3])),
      ).not.toThrow();
    });

    test("accepts empty hex string (0x)", () => {
      expect(() => validateSolanaInstructionData("0x")).not.toThrow();
    });

    test("accepts valid hex string", () => {
      expect(() => validateSolanaInstructionData("0xdeadbeef")).not.toThrow();
    });
  });

  describe("error properties", () => {
    test("thrown error is a BridgeValidationError", () => {
      let error: BridgeValidationError | undefined;
      try {
        validateSolanaInstructionData("bad" as `0x${string}`);
      } catch (e) {
        error = e as BridgeValidationError;
      }
      expect(error).toBeInstanceOf(BridgeValidationError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.outcome).toBe("user_fix");
    });
  });
});

describe("validateEvmCallValue", () => {
  describe("rejects invalid values", () => {
    test("throws for negative value", () => {
      expect(() => validateEvmCallValue(-1n)).toThrow(
        "EVM call value must not be negative",
      );
    });

    test("throws for large negative value", () => {
      expect(() => validateEvmCallValue(-1000000000000000000n)).toThrow(
        "EVM call value must not be negative",
      );
    });
  });

  describe("accepts valid values", () => {
    test("accepts zero value", () => {
      expect(() => validateEvmCallValue(0n)).not.toThrow();
    });

    test("accepts positive value", () => {
      expect(() => validateEvmCallValue(1n)).not.toThrow();
    });

    test("accepts large positive value", () => {
      expect(() => validateEvmCallValue(1000000000000000000n)).not.toThrow();
    });
  });

  describe("error properties", () => {
    test("thrown error is a BridgeValidationError", () => {
      let error: BridgeValidationError | undefined;
      try {
        validateEvmCallValue(-1n);
      } catch (e) {
        error = e as BridgeValidationError;
      }
      expect(error).toBeInstanceOf(BridgeValidationError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.outcome).toBe("user_fix");
    });
  });
});

describe("validateEvmCallType", () => {
  const VALID_EVM = "0x644e3dedb0e4f83bfcf8f9992964d240224b74dc";
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  describe("accepts valid call types", () => {
    test("accepts Call (0)", () => {
      expect(() =>
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 1n,
          data: "0x",
          ty: EvmCallType.Call,
        }),
      ).not.toThrow();
    });

    test("accepts DelegateCall (1) with zero value", () => {
      expect(() =>
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 0n,
          data: "0x",
          ty: EvmCallType.DelegateCall,
        }),
      ).not.toThrow();
    });

    test("accepts Create (2) with zero address", () => {
      expect(() =>
        validateEvmCallType({
          to: ZERO_ADDRESS as `0x${string}`,
          value: 0n,
          data: "0x",
          ty: EvmCallType.Create,
        }),
      ).not.toThrow();
    });

    test("accepts Create2 (3) with zero address", () => {
      expect(() =>
        validateEvmCallType({
          to: ZERO_ADDRESS as `0x${string}`,
          value: 0n,
          data: "0x",
          ty: EvmCallType.Create2,
        }),
      ).not.toThrow();
    });

    test("accepts undefined ty (defaults to Call)", () => {
      expect(() =>
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 0n,
          data: "0x",
        }),
      ).not.toThrow();
    });
  });

  describe("rejects invalid call type values", () => {
    test("throws for ty = 4 (out of range)", () => {
      expect(() =>
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 0n,
          data: "0x",
          ty: 4 as EvmCallType,
        }),
      ).toThrow("Invalid EVM call type");
    });

    test("throws for ty = -1", () => {
      expect(() =>
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 0n,
          data: "0x",
          ty: -1 as EvmCallType,
        }),
      ).toThrow("Invalid EVM call type");
    });

    test("throws for ty = 100", () => {
      expect(() =>
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 0n,
          data: "0x",
          ty: 100 as EvmCallType,
        }),
      ).toThrow("Invalid EVM call type");
    });
  });

  describe("DelegateCall cross-field constraints", () => {
    test("throws when DelegateCall has non-zero value", () => {
      expect(() =>
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 1n,
          data: "0x",
          ty: EvmCallType.DelegateCall,
        }),
      ).toThrow("DelegateCall cannot have a non-zero value");
    });

    test("throws when DelegateCall has large value", () => {
      expect(() =>
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 1000000000000000000n,
          data: "0x",
          ty: EvmCallType.DelegateCall,
        }),
      ).toThrow("DelegateCall cannot have a non-zero value");
    });
  });

  describe("Create/Create2 cross-field constraints", () => {
    test("throws when Create has non-zero `to` address", () => {
      expect(() =>
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 0n,
          data: "0x",
          ty: EvmCallType.Create,
        }),
      ).toThrow("Create requires the `to` address to be the zero address");
    });

    test("throws when Create2 has non-zero `to` address", () => {
      expect(() =>
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 0n,
          data: "0x",
          ty: EvmCallType.Create2,
        }),
      ).toThrow("Create2 requires the `to` address to be the zero address");
    });

    test("accepts Create with uppercase zero address", () => {
      expect(() =>
        validateEvmCallType({
          to: "0x0000000000000000000000000000000000000000" as `0x${string}`,
          value: 0n,
          data: "0x",
          ty: EvmCallType.Create,
        }),
      ).not.toThrow();
    });
  });

  describe("error properties", () => {
    test("thrown error is a BridgeValidationError", () => {
      let error: BridgeValidationError | undefined;
      try {
        validateEvmCallType({
          to: VALID_EVM as `0x${string}`,
          value: 0n,
          data: "0x",
          ty: 99 as EvmCallType,
        });
      } catch (e) {
        error = e as BridgeValidationError;
      }
      expect(error).toBeInstanceOf(BridgeValidationError);
      expect(error?.code).toBe("VALIDATION");
      expect(error?.outcome).toBe("user_fix");
    });
  });
});

describe("validateDestinationCallFields", () => {
  const VALID_EVM = "0x644e3dedb0e4f83bfcf8f9992964d240224b74dc";
  const VALID_SOL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  const evmRoute: BridgeRoute = {
    sourceChain: "solana:mainnet",
    destinationChain: "eip155:8453",
  };
  const solanaRoute: BridgeRoute = {
    sourceChain: "eip155:8453",
    destinationChain: "solana:mainnet",
  };

  test("validates EVM call `to` address", () => {
    const call: DestinationCall = {
      kind: "evm",
      call: { to: VALID_EVM as `0x${string}`, value: 0n, data: "0x" },
    };
    expect(() => validateDestinationCallFields(call, evmRoute)).not.toThrow();
  });

  test("throws for invalid EVM call `to` address", () => {
    const call: DestinationCall = {
      kind: "evm",
      call: { to: "0xINVALID" as `0x${string}`, value: 0n, data: "0x" },
    };
    expect(() => validateDestinationCallFields(call, evmRoute)).toThrow(
      "Invalid EVM address",
    );
  });

  test("throws for negative EVM call `value`", () => {
    const call: DestinationCall = {
      kind: "evm",
      call: {
        to: VALID_EVM as `0x${string}`,
        value: -1n,
        data: "0x",
      },
    };
    expect(() => validateDestinationCallFields(call, evmRoute)).toThrow(
      "EVM call value must not be negative",
    );
  });

  test("throws for invalid EVM call `data` field", () => {
    const call: DestinationCall = {
      kind: "evm",
      call: {
        to: VALID_EVM as `0x${string}`,
        value: 0n,
        data: "not-hex" as `0x${string}`,
      },
    };
    expect(() => validateDestinationCallFields(call, evmRoute)).toThrow(
      "Invalid EVM call data",
    );
  });

  test("throws for invalid EVM call `ty` value", () => {
    const call: DestinationCall = {
      kind: "evm",
      call: {
        to: VALID_EVM as `0x${string}`,
        value: 0n,
        data: "0x",
        ty: 5 as EvmCallType,
      },
    };
    expect(() => validateDestinationCallFields(call, evmRoute)).toThrow(
      "Invalid EVM call type",
    );
  });

  test("throws for DelegateCall with non-zero value via validateDestinationCallFields", () => {
    const call: DestinationCall = {
      kind: "evm",
      call: {
        to: VALID_EVM as `0x${string}`,
        value: 1n,
        data: "0x",
        ty: EvmCallType.DelegateCall,
      },
    };
    expect(() => validateDestinationCallFields(call, evmRoute)).toThrow(
      "DelegateCall cannot have a non-zero value",
    );
  });

  test("throws for Create with non-zero `to` address via validateDestinationCallFields", () => {
    const call: DestinationCall = {
      kind: "evm",
      call: {
        to: VALID_EVM as `0x${string}`,
        value: 0n,
        data: "0x",
        ty: EvmCallType.Create,
      },
    };
    expect(() => validateDestinationCallFields(call, evmRoute)).toThrow(
      "Create requires the `to` address to be the zero address",
    );
  });

  test("accepts valid EVM call with ty = Call", () => {
    const call: DestinationCall = {
      kind: "evm",
      call: {
        to: VALID_EVM as `0x${string}`,
        value: 1n,
        data: "0x",
        ty: EvmCallType.Call,
      },
    };
    expect(() => validateDestinationCallFields(call, evmRoute)).not.toThrow();
  });

  test("throws for Solana call with empty instructions", () => {
    const call: DestinationCall = {
      kind: "solana",
      call: {
        instructions: [],
      },
    };
    expect(() => validateDestinationCallFields(call, solanaRoute)).toThrow(
      "Solana call must include at least one instruction",
    );
  });

  test("validates Solana call programId", () => {
    const call: DestinationCall = {
      kind: "solana",
      call: {
        instructions: [
          {
            programId: VALID_SOL,
            accounts: [],
            data: new Uint8Array(),
          },
        ],
      },
    };
    expect(() =>
      validateDestinationCallFields(call, solanaRoute),
    ).not.toThrow();
  });

  test("throws for invalid Solana call programId", () => {
    const call: DestinationCall = {
      kind: "solana",
      call: {
        instructions: [
          {
            programId: "0xNOT_SOLANA",
            accounts: [],
            data: new Uint8Array(),
          },
        ],
      },
    };
    expect(() => validateDestinationCallFields(call, solanaRoute)).toThrow(
      "Invalid Solana address",
    );
  });

  test("validates Solana call account pubkeys", () => {
    const call: DestinationCall = {
      kind: "solana",
      call: {
        instructions: [
          {
            programId: VALID_SOL,
            accounts: [
              { pubkey: SYSTEM_PROGRAM, isWritable: true, isSigner: false },
              { pubkey: VALID_SOL, isWritable: false, isSigner: true },
            ],
            data: new Uint8Array(),
          },
        ],
      },
    };
    expect(() =>
      validateDestinationCallFields(call, solanaRoute),
    ).not.toThrow();
  });

  test("throws for invalid Solana account pubkey", () => {
    const call: DestinationCall = {
      kind: "solana",
      call: {
        instructions: [
          {
            programId: VALID_SOL,
            accounts: [
              { pubkey: "INVALID", isWritable: true, isSigner: false },
            ],
            data: new Uint8Array(),
          },
        ],
      },
    };
    expect(() => validateDestinationCallFields(call, solanaRoute)).toThrow(
      "Invalid Solana address",
    );
  });

  test("throws for invalid Solana instruction data (malformed hex string)", () => {
    const call: DestinationCall = {
      kind: "solana",
      call: {
        instructions: [
          {
            programId: VALID_SOL,
            accounts: [],
            data: "0xNOTHEX" as `0x${string}`,
          },
        ],
      },
    };
    expect(() => validateDestinationCallFields(call, solanaRoute)).toThrow(
      "Invalid Solana instruction data",
    );
  });

  test("accepts Solana instruction with valid hex data", () => {
    const call: DestinationCall = {
      kind: "solana",
      call: {
        instructions: [
          {
            programId: VALID_SOL,
            accounts: [],
            data: "0xdeadbeef",
          },
        ],
      },
    };
    expect(() =>
      validateDestinationCallFields(call, solanaRoute),
    ).not.toThrow();
  });

  test("validates multiple instructions", () => {
    const call: DestinationCall = {
      kind: "solana",
      call: {
        instructions: [
          {
            programId: VALID_SOL,
            accounts: [
              { pubkey: SYSTEM_PROGRAM, isWritable: true, isSigner: false },
            ],
            data: new Uint8Array(),
          },
          {
            programId: SYSTEM_PROGRAM,
            accounts: [],
            data: new Uint8Array(),
          },
        ],
      },
    };
    expect(() =>
      validateDestinationCallFields(call, solanaRoute),
    ).not.toThrow();
  });
});

describe("validateAction", () => {
  const evmRoute: BridgeRoute = {
    sourceChain: "solana:mainnet",
    destinationChain: "eip155:8453",
  };
  const solanaRoute: BridgeRoute = {
    sourceChain: "eip155:8453",
    destinationChain: "solana:mainnet",
  };

  const VALID_EVM = "0x644e3dedb0e4f83bfcf8f9992964d240224b74dc";
  const VALID_SOL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  describe("transfer actions", () => {
    test("passes for valid transfer with EVM recipient", () => {
      const action: BridgeAction = {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1000n,
        recipient: VALID_EVM,
      };
      expect(() => validateAction(action, evmRoute)).not.toThrow();
    });

    test("validates amount", () => {
      const action: BridgeAction = {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 0n,
        recipient: VALID_EVM,
      };
      expect(() => validateAction(action, evmRoute)).toThrow(
        "Amount must be greater than zero",
      );
    });

    test("validates recipient address", () => {
      const action: BridgeAction = {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1000n,
        recipient: "not-valid",
      };
      expect(() => validateAction(action, evmRoute)).toThrow(
        "Invalid EVM address",
      );
    });

    test("validates optional destination call addresses on transfer+call", () => {
      const action: BridgeAction = {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1000n,
        recipient: VALID_EVM,
        call: {
          kind: "evm",
          call: {
            to: "0xBAD" as `0x${string}`,
            value: 0n,
            data: "0x",
          },
        },
      };
      expect(() => validateAction(action, evmRoute)).toThrow(
        "Invalid EVM address",
      );
    });

    test("passes for valid transfer+call", () => {
      const action: BridgeAction = {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1000n,
        recipient: VALID_EVM,
        call: {
          kind: "evm",
          call: {
            to: VALID_EVM as `0x${string}`,
            value: 0n,
            data: "0x",
          },
        },
      };
      expect(() => validateAction(action, evmRoute)).not.toThrow();
    });
  });

  describe("call actions", () => {
    test("passes for valid EVM call action", () => {
      const action: BridgeAction = {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: VALID_EVM as `0x${string}`,
            value: 0n,
            data: "0x",
          },
        },
      };
      expect(() => validateAction(action, evmRoute)).not.toThrow();
    });

    test("throws for invalid EVM call address", () => {
      const action: BridgeAction = {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: "0xNOPE" as `0x${string}`,
            value: 0n,
            data: "0x",
          },
        },
      };
      expect(() => validateAction(action, evmRoute)).toThrow(
        "Invalid EVM address",
      );
    });

    test("passes for valid Solana call action", () => {
      const action: BridgeAction = {
        kind: "call",
        call: {
          kind: "solana",
          call: {
            instructions: [
              {
                programId: VALID_SOL,
                accounts: [],
                data: new Uint8Array(),
              },
            ],
          },
        },
      };
      expect(() => validateAction(action, solanaRoute)).not.toThrow();
    });

    test("throws for invalid Solana call programId", () => {
      const action: BridgeAction = {
        kind: "call",
        call: {
          kind: "solana",
          call: {
            instructions: [
              {
                programId: "INVALID",
                accounts: [],
                data: new Uint8Array(),
              },
            ],
          },
        },
      };
      expect(() => validateAction(action, solanaRoute)).toThrow(
        "Invalid Solana address",
      );
    });

    test("does not validate amount or recipient for call actions", () => {
      // Call actions have no amount or recipient fields — this should
      // only validate the destination call addresses.
      const action: BridgeAction = {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: VALID_EVM as `0x${string}`,
            value: 0n,
            data: "0x",
          },
        },
      };
      expect(() => validateAction(action, evmRoute)).not.toThrow();
    });

    test("throws when call kind is EVM but destination is Solana", () => {
      const action: BridgeAction = {
        kind: "call",
        call: {
          kind: "evm",
          call: {
            to: VALID_EVM as `0x${string}`,
            value: 0n,
            data: "0x",
          },
        },
      };
      expect(() => validateAction(action, solanaRoute)).toThrow(
        "Call type mismatch",
      );
    });

    test("throws when call kind is Solana but destination is EVM", () => {
      const action: BridgeAction = {
        kind: "call",
        call: {
          kind: "solana",
          call: {
            instructions: [
              {
                programId: VALID_SOL,
                accounts: [],
                data: new Uint8Array(),
              },
            ],
          },
        },
      };
      expect(() => validateAction(action, evmRoute)).toThrow(
        "Call type mismatch",
      );
    });
  });

  describe("transfer+call cross-validation", () => {
    test("reports call kind mismatch before recipient format error on transfer+call", () => {
      // Solana recipient + Solana call on an EVM destination route:
      // should get "Call type mismatch" (call kind), not "Invalid EVM address" (recipient).
      const action: BridgeAction = {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1000n,
        recipient: VALID_SOL, // wrong format for EVM destination
        call: {
          kind: "solana",
          call: {
            instructions: [
              {
                programId: VALID_SOL,
                accounts: [],
                data: new Uint8Array(),
              },
            ],
          },
        },
      };
      expect(() => validateAction(action, evmRoute)).toThrow(
        "Call type mismatch",
      );
    });

    test("throws when transfer call kind mismatches destination chain", () => {
      const action: BridgeAction = {
        kind: "transfer",
        asset: { kind: "native" },
        amount: 1000n,
        recipient: VALID_EVM,
        call: {
          kind: "solana",
          call: {
            instructions: [
              {
                programId: VALID_SOL,
                accounts: [],
                data: new Uint8Array(),
              },
            ],
          },
        },
      };
      expect(() => validateAction(action, evmRoute)).toThrow(
        "Call type mismatch",
      );
    });
  });
});
