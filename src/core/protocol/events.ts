import type { Hex } from "viem";
import { decodeEventLog } from "viem";
import { BRIDGE_ABI } from "../../interfaces/abis/bridge.abi";

export interface MessageInitiatedEvent {
  messageHash: Hex;
  mmrRoot: Hex;
  message: { nonce: bigint; sender: Hex; data: Hex };
}

/**
 * Decode `MessageInitiated` events from EVM transaction logs.
 */
export function decodeMessageInitiatedEvents(
  logs: readonly { data: Hex; topics: [Hex, ...Hex[]] | [] }[],
): MessageInitiatedEvent[] {
  return logs
    .map((log) => {
      try {
        const decoded = decodeEventLog({
          abi: BRIDGE_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName !== "MessageInitiated") return null;
        return decoded.args;
      } catch {
        return null;
      }
    })
    .filter((x) => x !== null);
}
