import type { Rpc } from "@opencode/plugin";
import type { EngineStatus } from "./engine.js";
import type { FreeUsageMode } from "./types.js";
import { freeUsageModeLabel, parseFreeUsageMode } from "./types.js";

const object = {
  type: "object",
  additionalProperties: true,
} as const;

export const FREE_FIRST_RPC_ID = "opencode-free-first" as const;

/**
 * Diagnostics and operator controls. Free-first has no queue, no scheduler, and
 * no work of its own, so the surface is small: the current state, a cooldown
 * reset, the runtime master switch, and the persistent free-usage mode.
 *
 * The TUI plugin is a thin client of this RPC: it never stores a second copy of
 * the mode, so the saved choice has exactly one source of truth.
 */
export const FREE_FIRST_RPC = {
  id: FREE_FIRST_RPC_ID,
  methods: {
    control: {
      input: {
        type: "object",
        properties: {
          action: { type: "string" },
          mode: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      output: object,
    },
  },
  events: {
    transition: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          reason: { type: "string" },
        },
        required: ["to"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition;

export type FreeFirstEventName = keyof typeof FREE_FIRST_RPC.events;

/** Full event-stream type string, for example `rpc.opencode-free-first.transition`. */
export function freeFirstEventType<Name extends FreeFirstEventName>(
  name: Name,
): `rpc.${typeof FREE_FIRST_RPC_ID}.${Name}` {
  return `rpc.${FREE_FIRST_RPC_ID}.${name}`;
}

export interface FreeFirstRpcInput {
  readonly action: string;
  readonly mode?: string;
}

export interface FreeFirstRpcOutput {
  readonly message?: string;
  readonly status?: Record<string, unknown>;
  /** Present on a successful mode change, so the caller can fan it out. */
  readonly mode?: FreeUsageMode;
}

/** Usage string shared by the RPC handler, the TUI, and the documentation. */
export const FREE_FIRST_USAGE =
  "Usage: /free-first [status|reset|on|off] | /free-first mode <free-first|peak-only|disabled> | /free-first mode configured";

/** The subset of the engine the control surface needs. */
export interface FreeFirstControlEngine {
  readonly mode: FreeUsageMode;
  readonly enabled: boolean;
  refresh(): Promise<void>;
  status(): EngineStatus;
  statusLine(): string;
  setEnabled(enabled: boolean): void;
  markHealthy(reason: string): void;
  setMode(mode: FreeUsageMode): Promise<{ readonly persisted: boolean }>;
  clearModeOverride(): Promise<{ readonly persisted: boolean }>;
}

function savedNote(persisted: boolean): string {
  return persisted
    ? "Saved in OpenCode; this choice overrides freeUsageMode until changed."
    : "Applied for this running instance, but the saved choice could not be written; it will not survive a restart.";
}

function modeMessage(mode: FreeUsageMode, persisted: boolean): string {
  switch (mode) {
    case "always-free-first":
      return `Free-first mode: Free First. Free is preferred whenever it is healthy, at any pricing window. ${savedNote(persisted)}`;
    case "peak-only":
      return `Free-first mode: Peak Only. Free is used only during a verified PEAK window; off-peak, weekend, and holiday traffic goes to Go with no Free request or probe. ${savedNote(persisted)}`;
    case "off":
      return `Free-first mode: Free-first disabled. opencode-free-first no longer manages routing. This is NOT /offpeak off: /offpeak still controls paid peak-price protection. ${savedNote(persisted)}`;
  }
}

/**
 * Handle one control RPC call. Kept independent of the OpenCode context so the
 * exact user-facing semantics (including the mode aliases and the wording that
 * separates "Free-first disabled" from `/offpeak off`) are unit-testable.
 */
export async function handleFreeFirstControl(
  engine: FreeFirstControlEngine,
  rawInput: unknown,
): Promise<FreeFirstRpcOutput> {
  const input = rawInput as FreeFirstRpcInput;
  switch (input.action) {
    case "status":
    case "pricing": {
      // Report the whole instance's view, not one location's memory.
      await engine.refresh();
      return { status: engine.status() as unknown as Record<string, unknown> };
    }
    case "on": {
      engine.setEnabled(true);
      await engine.refresh();
      const disabledNote =
        engine.mode === "off"
          ? " Mode is Free-first disabled; choose Free First or Peak Only to route."
          : "";
      return {
        message: `opencode-free-first is ON (runtime master switch). Mode: ${freeUsageModeLabel(engine.mode)}.${disabledNote} ${engine.statusLine()}`,
      };
    }
    case "off":
      engine.setEnabled(false);
      return {
        message:
          "opencode-free-first is OFF (runtime master switch). No routing, failover, probing, or timer remains active; the saved mode and persisted cooldown state are preserved. This is not /offpeak off.",
      };
    case "reset":
      engine.markHealthy("rpc-reset");
      return {
        message: "Free-first cooldown cleared.",
        status: engine.status() as unknown as Record<string, unknown>,
      };
    case "set-mode":
    case "mode": {
      const mode = parseFreeUsageMode(input.mode);
      if (mode === undefined) throw new Error(FREE_FIRST_USAGE);
      const result = await engine.setMode(mode);
      return {
        mode,
        message: modeMessage(mode, result.persisted),
        status: engine.status() as unknown as Record<string, unknown>,
      };
    }
    case "clear-mode":
    case "default-mode": {
      const result = await engine.clearModeOverride();
      return {
        mode: engine.mode,
        message: `Free-first mode reverted to the configured value: ${freeUsageModeLabel(engine.mode)} (${engine.mode}). ${
          result.persisted
            ? "The saved choice was removed."
            : "The saved choice could not be removed; the configured value applies for this running instance."
        }`,
        status: engine.status() as unknown as Record<string, unknown>,
      };
    }
    default:
      throw new Error(FREE_FIRST_USAGE);
  }
}
