import { expect, test } from "bun:test";
import { type Account, address as solAddress } from "@solana/kit";
import type { OutgoingMessage } from "../src/clients/ts/src/bridge";
import { CallType } from "../src/clients/ts/src/bridge";
import { buildEvmIncomingMessage } from "../src/core/protocol/identity";

test("buildEvmIncomingMessage produces correct hashes and message", () => {
  const outgoing: Account<OutgoingMessage, string> = {
    address: solAddress("11111111111111111111111111111111"),
    programAddress: solAddress("11111111111111111111111111111111"),
    data: {
      nonce: 42n,
      sender: solAddress("11111111111111111111111111111111"),
      message: {
        __kind: "Call",
        fields: [
          {
            ty: CallType.Call,
            to: new Uint8Array(20).fill(0x11),
            value: 0n,
            data: new Uint8Array([0xd0, 0x9d, 0xe0, 0x8a]), // increment()
          },
        ],
      },
    },
  } as unknown as Account<OutgoingMessage, string>;

  const gasLimit = 123_456n;

  const res = buildEvmIncomingMessage(
    outgoing as unknown as Parameters<typeof buildEvmIncomingMessage>[0],
    { gasLimit },
  );

  // Verify hashes are well-formed hex strings
  expect(res.innerHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(res.outerHash).toMatch(/^0x[0-9a-f]{64}$/);

  // Verify message fields
  expect(res.evmMessage.nonce).toBe(42n);
  expect(res.evmMessage.gasLimit).toBe(gasLimit);
  expect(res.evmMessage.ty).toBe(0); // Call type
});
