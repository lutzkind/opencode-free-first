/**
 * `opencode-free-first` — CLI (TUI) plugin.
 *
 * A thin, native control surface over the server plugin's existing control RPC:
 *
 *   /free-first                      open the mode selector
 *   /free-first status               concise state
 *   /free-first mode free-first      historical Free-whenever-healthy behaviour
 *   /free-first mode peak-only       Free only in a verified PEAK window
 *   /free-first mode disabled        free-first stops managing routing
 *   /free-first mode configured      forget the saved choice
 *
 * The mode itself is never stored here. The server persists it in OpenCode's
 * plugin storage and every surface reads it back through the RPC, so there is
 * exactly one source of truth.
 */
import { Plugin } from "@opencode/plugin/tui";
import type { FreeFirstRpcOutput } from "./rpc.js";
import { FREE_FIRST_RPC, FREE_FIRST_USAGE } from "./rpc.js";
import type { FreeUsageMode } from "./types.js";
import { freeUsageModeLabel, parseFreeUsageMode } from "./types.js";

const MODE_COMMAND = "free-first";

interface FreeFirstStatus {
  readonly enabled?: boolean;
  readonly routingActive?: boolean;
  readonly state?: string;
  readonly freeUsageMode?: FreeUsageMode;
  readonly configuredFreeUsageMode?: FreeUsageMode;
  readonly freeUsageModeSource?: "override" | "config";
  readonly pricingState?: string;
  readonly pricingNextTransition?: number;
  readonly activeRoute?: string;
  readonly cooldownMs?: number;
  readonly cooldownReason?: string;
  readonly primary?: string;
  readonly fallback?: string;
}

export default Plugin.define({
  id: "opencode-free-first",
  setup: (context) => {
    const client = context.client.rpc(FREE_FIRST_RPC);

    async function status(): Promise<FreeFirstStatus> {
      const output = (await client.control({ action: "status" })) as FreeFirstRpcOutput;
      return (output.status ?? {}) as FreeFirstStatus;
    }

    async function setMode(mode: FreeUsageMode): Promise<void> {
      const output = (await client.control({
        action: "set-mode",
        mode,
      })) as FreeFirstRpcOutput;
      context.ui.toast.show({
        title: "OpenCode Free First",
        message: output.message ?? `Free-first mode: ${freeUsageModeLabel(mode)}.`,
        variant: "success",
        duration: 10000,
      });
    }

    async function clearMode(): Promise<void> {
      const output = (await client.control({ action: "clear-mode" })) as FreeFirstRpcOutput;
      context.ui.toast.show({
        title: "OpenCode Free First",
        message: output.message ?? "Free-first mode reverted to the configured value.",
        variant: "success",
        duration: 10000,
      });
    }

    async function showStatus(): Promise<void> {
      const current = await status();
      context.ui.toast.show({
        title: "OpenCode Free First",
        message: formatStatus(current),
        variant: "info",
        duration: 12000,
      });
    }

    async function pickMode(): Promise<void> {
      const current = await status();
      const selected = await context.ui.dialog.select<FreeUsageMode>({
        title: "Free-first mode",
        ...(current.freeUsageMode === undefined ? {} : { current: current.freeUsageMode }),
        options: [
          {
            title: "Free First",
            value: "always-free-first",
            description: "Use Free whenever it is healthy, regardless of PEAK or OFF_PEAK pricing.",
          },
          {
            title: "Peak Only",
            value: "peak-only",
            description:
              "Use Free only during a verified PEAK window. Off-peak uses Go directly, with no Free request or probe.",
          },
          {
            title: "Disable Free-first",
            value: "off",
            description:
              "Stop free-first routing. This is not /offpeak off; /offpeak keeps its own paid-price protection.",
          },
        ],
      });
      if (selected === undefined) return;
      await setMode(selected);
    }

    async function run(rawInput = ""): Promise<void> {
      const input = rawInput.trim().replace(/^\/free-first(?=\s|$)\s*/i, "");
      const space = input.indexOf(" ");
      const verb = (space < 0 ? input : input.slice(0, space)).toLowerCase();
      const argument = space < 0 ? "" : input.slice(space + 1).trim();

      try {
        if (verb === "") {
          await pickMode();
          return;
        }
        if (verb === "status") {
          await showStatus();
          return;
        }
        if (verb === "mode") {
          if (argument === "" || argument.toLowerCase() === "configured") {
            if (argument === "") throw new Error(FREE_FIRST_USAGE);
            await clearMode();
            return;
          }
          const mode = parseFreeUsageMode(argument);
          if (mode === undefined) throw new Error(FREE_FIRST_USAGE);
          await setMode(mode);
          return;
        }
        // A bare alias is accepted as a convenience, never as a new mode name.
        const alias = parseFreeUsageMode(verb);
        if (alias !== undefined) {
          await setMode(alias);
          return;
        }
        throw new Error(FREE_FIRST_USAGE);
      } catch (error) {
        context.ui.toast.show({
          title: "OpenCode Free First",
          message: error instanceof Error ? error.message : "Free-first command failed.",
          variant: "error",
          duration: 12000,
        });
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-free-first.command",
          title: "OpenCode Free First",
          group: "OpenCode Free First",
          description: "Choose Free First, Peak Only, or disable free-first routing",
          slash: { name: MODE_COMMAND, arguments: true },
          run,
        },
      ],
    }));
  },
});

function formatStatus(status: FreeFirstStatus): string {
  const mode = status.freeUsageMode ?? "off";
  const source = status.freeUsageModeSource === "override" ? "saved in OpenCode" : "configured";
  const routing = status.routingActive === true ? "" : " · not managing routing";
  const lines = [
    `Mode: ${freeUsageModeLabel(mode)} (${source})${routing}`,
    `Pricing: ${formatPricing(status)}`,
    `Route: ${status.activeRoute ?? "UNKNOWN"}`,
    `Free: ${formatHealth(status)}`,
    `Free model: ${status.primary ?? "unknown"}`,
    `Go fallback: ${status.fallback ?? "session-previous-or-default"}`,
  ];
  if (mode === "off") {
    lines.push("/offpeak off is a different control: it does not disable free-first.");
  }
  return lines.join("\n");
}

function formatPricing(status: FreeFirstStatus): string {
  const mode = status.freeUsageMode ?? "off";
  if (mode === "off") return "not used (free-first disabled)";
  if (mode !== "peak-only") return "not used (Free First ignores pricing)";
  const state = status.pricingState ?? "UNKNOWN";
  if (status.pricingNextTransition === undefined) return state;
  return `${state} · next change ${new Date(status.pricingNextTransition).toISOString()}`;
}

function formatHealth(status: FreeFirstStatus): string {
  if (status.routingActive !== true) return "not managed (free-first disabled)";
  if (status.state === "FREE_HEALTHY") return "healthy";
  const remaining = status.cooldownMs ?? 0;
  if (remaining > 0) {
    const reason =
      status.cooldownReason === "rate-limit"
        ? "rate-limit"
        : status.cooldownReason === "free-route"
          ? "free-route rejection"
          : status.cooldownReason === "transient-availability"
            ? "transient outage"
            : "cooldown";
    return `${reason} cooldown ${formatRemaining(remaining)}`;
  }
  return status.state === "FREE_PROBE" ? "probing" : "cooldown elapsed";
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
