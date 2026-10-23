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
export const OFFPEAK_PRICING = "pricing" as const;

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

/** The smallest portable definition that can call `pricing`. */
export const OFFPEAK_PRICING_RPC = {
  id: OFFPEAK_RPC_ID,
  methods: {
    pricing: {
      input: {
        type: "object",
        properties: {
          providerID: { type: "string" },
          modelID: { type: "string" },
        },
        required: ["providerID", "modelID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition;

/**
 * Canonical pricing classification as reported by `opencode-offpeak`.
 * `opencode-free-first` never reimplements the weekly windows or holidays; it
 * only consumes this answer.
 */
export interface PricingSnapshot {
  readonly state: "PEAK" | "OFF_PEAK" | "FLAT" | "UNTRACKED" | "UNKNOWN";
  readonly allowed: boolean;
  readonly policyID?: string;
  readonly nextTransition?: number;
  readonly reason?: string;
}

export interface PricingPort {
  /**
   * Ask the canonical pricing owner for the current classification. Resolves
   * `undefined` when the capability is unavailable or failed, which means
   * "unknown" — never "off-peak".
   */
  evaluate(input: {
    readonly providerID: string;
    readonly id: string;
  }): Promise<PricingSnapshot | undefined>;
  /** Capability state for diagnostics. */
  capability(): "unknown" | "available" | "unavailable";
}

/** Build the pricing port around a caller-supplied RPC invocation. */
export function createPricingPort(
  invoke:
    | ((input: { readonly providerID: string; readonly modelID: string }) => Promise<unknown>)
    | undefined,
  onUnavailable?: (error: unknown) => void,
): PricingPort {
  let state: "unknown" | "available" | "unavailable" = "unknown";
  let reported = false;
  return {
    capability: () => state,
    async evaluate(input) {
      if (invoke === undefined) {
        state = "unavailable";
        return undefined;
      }
      try {
        const result = (await invoke({ providerID: input.providerID, modelID: input.id })) as
          | {
              state?: unknown;
              allowed?: unknown;
              policyID?: unknown;
              nextTransition?: unknown;
              reason?: unknown;
            }
          | undefined;
        state = "available";
        if (result === undefined || typeof result !== "object") return undefined;
        const pricingState =
          result.state === "PEAK" ||
          result.state === "OFF_PEAK" ||
          result.state === "FLAT" ||
          result.state === "UNTRACKED" ||
          result.state === "UNKNOWN"
            ? result.state
            : "UNKNOWN";
        return {
          state: pricingState,
          // The owner's `allowed` field describes paid requests, so it is false
          // at PEAK. For the consumer, only a positive PEAK state authorizes
          // spending free quota.
          allowed: pricingState === "PEAK",
          ...(typeof result.policyID === "string" ? { policyID: result.policyID } : {}),
          ...(typeof result.nextTransition === "number" && Number.isFinite(result.nextTransition)
            ? { nextTransition: result.nextTransition }
            : {}),
          ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
        };
      } catch (error) {
        state = "unavailable";
        if (!reported) {
          reported = true;
          onUnavailable?.(error);
        }
        return undefined;
      }
    },
  };
}

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
