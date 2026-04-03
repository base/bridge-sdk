import type { Hash, TransactionReceipt } from "viem";

export const FAKE_TX_HASH =
  "0xaabbccddee00112233445566778899aabbccddee00112233445566778899aabb" as const;

export function makeReceipt(
  overrides: Partial<TransactionReceipt> = {},
): TransactionReceipt {
  return {
    transactionHash: FAKE_TX_HASH,
    status: "success",
    blockNumber: 1n,
    blockHash: "0x00" as Hash,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: "0x00",
    gasUsed: 21000n,
    logs: [],
    logsBloom: "0x00",
    to: "0x00",
    transactionIndex: 0,
    type: "eip1559",
    ...overrides,
  } as TransactionReceipt;
}
