/**
 * `opencode-offpeak` cooperation contract.
 *
 * This plugin only *routes*: it decides which model a session should use. The
 * plugin that parks a peak-priced request owns that hold, so it is the only
 * place a hold can be cancelled. Rather than importing that repository, this
 * file declares the narrow, versioned slice of its RPC surface this plugin
 * calls, and every call is optional: when the capability is missing, older, or
 * refuses the request, `cancel` reports `unavailable` and the caller keeps its
 * documented behaviour.
 *
 * The contract (`opencode-offpeak.cancelHold`):
 *
 * - input `{ sessionID, reason? }`
 * - output `{ cancelled: boolean, state: string, model?: string }`
 *
 * `cancelled: true` means the hold lost its race: the parked request will be
 * refused at the transport boundary and never sent, so OpenCode's own retry
 * machinery decides what happens next. `state: "committed"` means the request
 * had already been released for dispatch, and the caller must leave it alone.
 * `state: "none"` means nothing was parked for that session.
 */
import type { Rpc } from "@opencode/plugin";

export const OFFPEAK_RPC_ID = "opencode-offpeak" as const;
export const OFFPEAK_CANCEL_HOLD = "cancelHold" as const;

/** The smallest portable definition that can call `cancelHold`. */
export const OFFPEAK_CANCEL_HOLD_RPC = {
  id: OFFPEAK_RPC_ID,
  methods: {
    cancelHold: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          reason: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition;

export interface CancelHoldResult {
  readonly cancelled: boolean;
  readonly state: string;
  readonly model?: string;
}

export interface PaidHoldPort {
  /**
   * Ask the plugin holding this session's parked paid request to cancel it.
   * Resolves `undefined` when the capability is unavailable or failed, which
   * means "no cancellation happened" — never "cancelled".
   */
  cancel(input: { readonly sessionID: string }): Promise<CancelHoldResult | undefined>;
  /** Capability state for diagnostics. */
  capability(): "unknown" | "available" | "unavailable";
  /** Call outcome counters, for diagnostics. */
  calls(): { readonly accepted: number; readonly committed: number; readonly unavailable: number };
}

/** Build the port around a caller-supplied RPC invocation. */
export function createPaidHoldPort(
  invoke:
    | ((input: { readonly sessionID: string; readonly reason?: string }) => Promise<unknown>)
    | undefined,
  onUnavailable?: (error: unknown) => void,
): PaidHoldPort {
  let state: "unknown" | "available" | "unavailable" = "unknown";
  let accepted = 0;
  let committed = 0;
  let unavailable = 0;
  let reported = false;
  return {
    capability: () => state,
    calls: () => ({ accepted, committed, unavailable }),
    async cancel(input) {
      if (invoke === undefined) {
        state = "unavailable";
        unavailable += 1;
        return undefined;
      }
      try {
        const result = (await invoke({ sessionID: input.sessionID })) as
          | { cancelled?: unknown; state?: unknown; model?: unknown }
          | undefined;
        state = "available";
        if (result === undefined || typeof result !== "object") {
          unavailable += 1;
          return undefined;
        }
        const outcome: CancelHoldResult = {
          cancelled: result.cancelled === true,
          state: typeof result.state === "string" ? result.state : "unknown",
          ...(typeof result.model === "string" ? { model: result.model } : {}),
        };
        if (outcome.cancelled) accepted += 1;
        else committed += 1;
        return outcome;
      } catch (error) {
        state = "unavailable";
        unavailable += 1;
        if (!reported) {
          reported = true;
          onUnavailable?.(error);
        }
        return undefined;
      }
    },
  };
}
