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

  // Verify hashes match known-correct values (snapshot)
  expect(res.innerHash).toBe(
    "0xcfec34b5085fad7d40fc731d6647a8e20efab3a12b6a30f3f357baf9cdf7e903",
  );
  expect(res.outerHash).toBe(
    "0xebb305f55da790bd21c434446a422685def8f660ffb0417169f214a6834383c2",
  );

  // Verify message fields
  expect(res.evmMessage.nonce).toBe(42n);
  expect(res.evmMessage.gasLimit).toBe(gasLimit);
  expect(res.evmMessage.ty).toBe(0); // Call type
});
