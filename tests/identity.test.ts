import { test, expect } from "bun:test";
import { buildEvmIncomingMessage } from "../src/core/protocol/identity";
import { BaseEngine } from "../src/core/protocol/engines/base-engine";
import { address as solAddress, type Account } from "@solana/kit";
import { base } from "viem/chains";
import type { OutgoingMessage } from "../src/clients/ts/src/bridge";
import { CallType } from "../src/clients/ts/src/bridge";

test("base-markets: buildEvmIncomingMessage matches legacy BaseEngine hashing", () => {
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
  } as any;

  const gasLimit = 123_456n;

  const legacy = new BaseEngine({
    config: {
      solana: {
        rpcUrl: "http://localhost",
        payerKp: "__unused__",
        bridgeProgram: solAddress("11111111111111111111111111111111"),
        relayerProgram: solAddress("11111111111111111111111111111111"),
      },
      base: {
        rpcUrl: "http://localhost",
        bridgeContract: "0x0000000000000000000000000000000000000000",
        chain: base,
      },
    },
  });

  const legacyRes = (legacy as any).buildEvmMessage(outgoing, gasLimit) as {
    innerHash: `0x${string}`;
    outerHash: `0x${string}`;
    evmMessage: any;
  };

  const newRes = buildEvmIncomingMessage(outgoing as any, { gasLimit });

  expect(newRes.innerHash).toBe(legacyRes.innerHash);
  expect(newRes.outerHash).toBe(legacyRes.outerHash);
  expect(newRes.evmMessage.nonce).toBe(42n);
});
