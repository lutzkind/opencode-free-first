import type { Rpc } from "@opencode/plugin";

const object = {
  type: "object",
  additionalProperties: true,
} as const;

export const FREE_FIRST_RPC_ID = "opencode-free-first" as const;

/**
 * Read-only diagnostic surface. Free-first has no queue, no scheduler, and no
 * work of its own, so the only control worth exposing is `status` plus an
 * explicit `reset` for an operator who has cleared the provider limit by hand.
 * Core runtime behaviour never depends on this RPC.
 */
export const FREE_FIRST_RPC = {
  id: FREE_FIRST_RPC_ID,
  methods: {
    control: {
      input: {
        type: "object",
        properties: {
          action: { type: "string" },
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
}

export interface FreeFirstRpcOutput {
  readonly message?: string;
  readonly status?: Record<string, unknown>;
}

/** Usage string shared by the RPC handler and the documentation. */
export const FREE_FIRST_USAGE = "Usage: /free-first status|reset|on|off";
