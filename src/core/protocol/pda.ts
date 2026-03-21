import {
  getProgramDerivedAddress,
  type Address as SolAddress,
} from "@solana/kit";
import type { Hex } from "viem";
import { toBytes } from "viem";
import { getIdlConstant } from "../../utils/bridge-idl.constants";

/**
 * Derive the PDA for an incoming message account on Solana.
 */
export async function deriveIncomingMessagePda(
  bridgeProgram: SolAddress,
  messageHash: Hex,
): Promise<SolAddress> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: bridgeProgram,
    seeds: [
      Buffer.from(getIdlConstant("INCOMING_MESSAGE_SEED")),
      Buffer.from(toBytes(messageHash)),
    ],
  });
  return pda;
}
