/**
 * The TUI command surface, tested against a fake OpenCode CLI context. This is
 * the deterministic half of the TUI coverage; `tui-smoke.test.mjs` exercises the
 * same commands in the real TUI when explicitly enabled.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import tui from "../dist/tui.js";

function baseStatus(overrides = {}) {
  return {
    enabled: true,
    routingActive: true,
    state: "FREE_HEALTHY",
    freeUsageMode: "peak-only",
    configuredFreeUsageMode: "peak-only",
    freeUsageModeSource: "config",
    pricingState: "OFF_PEAK",
    pricingNextTransition: Date.UTC(2026, 9, 23, 6, 0, 0),
    activeRoute: "GO",
    cooldownMs: 0,
    cooldownReason: undefined,
    primary: "opencode/deepseek-v4.1-flash-free",
    fallback: "opencode-go/deepseek-v4.1-flash",
    ...overrides,
  };
}

function fakeContext({ status = baseStatus(), select, fail } = {}) {
  const calls = { control: [], toasts: [], selects: [], layers: [] };
  const state = { ...status };
  const context = {
    keymap: {
      layer(factory) {
        calls.layers.push(factory());
      },
    },
    ui: {
      toast: {
        show(options) {
          calls.toasts.push(options);
        },
      },
      dialog: {
        async select(options) {
          calls.selects.push(options);
          return select === undefined ? undefined : select(options);
        },
      },
    },
    client: {
      rpc() {
        return {
          async control(input) {
            calls.control.push(input);
            if (fail !== undefined) throw fail;
            if (input.action === "set-mode") {
              state.freeUsageMode = input.mode;
              state.freeUsageModeSource = "override";
              return {
                mode: input.mode,
                message: `Free-first mode: ${input.mode}. Saved in OpenCode.`,
                status: { ...state },
              };
            }
            if (input.action === "clear-mode") {
              state.freeUsageMode = state.configuredFreeUsageMode;
              state.freeUsageModeSource = "config";
              return {
                mode: state.freeUsageMode,
                message: `Free-first mode reverted to the configured value: ${state.freeUsageMode}.`,
                status: { ...state },
              };
            }
            return { status: { ...state } };
          },
        };
      },
    },
  };
  context.calls = calls;
  return { context, calls, state };
}

function setup(tuiContext) {
  tui.setup(tuiContext);
}

function command(tuiContext) {
  setup(tuiContext);
  const layer = tuiContext.calls.layers[0];
  assert.ok(layer, "the CLI plugin registered a keymap layer");
  return layer.commands[0];
}

function run(tuiContext, input) {
  return command(tuiContext).run(input);
}

describe("TUI command registration", () => {
  it("registers /free-first as a native slash command with arguments", () => {
    const { context } = fakeContext();
    const registered = command(context);
    assert.equal(registered.id, "opencode-free-first.command");
    assert.equal(registered.slash.name, "free-first");
    assert.equal(registered.slash.arguments, true);
    assert.equal(typeof registered.run, "function");
  });

  it("targets the global input mode so it works from any session", () => {
    const { context, calls } = fakeContext();
    setup(context);
    assert.equal(calls.layers[0].mode, "global");
  });
});

describe("/free-first status", () => {
  it("shows Peak Only, canonical pricing, route, health, and both models", async () => {
    const { context, calls } = fakeContext({
      status: baseStatus({
        activeRoute: "GO",
        cooldownMs: 3_600_000,
        cooldownReason: "rate-limit",
        state: "FREE_COOLDOWN",
      }),
    });
    await run(context, "status");
    const message = calls.toasts.at(-1).message;
    assert.match(message, /Mode: Peak Only \(configured\)/);
    assert.match(message, /Pricing: OFF_PEAK · next change 2026-10-23T06:00:00.000Z/);
    assert.match(message, /Route: GO/);
    assert.match(message, /Free: rate-limit cooldown 1h 0m/);
    assert.match(message, /Free model: opencode\/deepseek-v4\.1-flash-free/);
    assert.match(message, /Go fallback: opencode-go\/deepseek-v4\.1-flash/);
    assert.equal(calls.toasts.at(-1).variant, "info");
  });

  it("shows a free-route rejection and a transient outage distinctly", async () => {
    const gate = fakeContext({
      status: baseStatus({
        state: "FREE_COOLDOWN",
        cooldownMs: 300_000,
        cooldownReason: "free-route",
      }),
    });
    await run(gate.context, "status");
    assert.match(gate.calls.toasts.at(-1).message, /Free: free-route rejection cooldown 5m 0s/);

    const transient = fakeContext({
      status: baseStatus({
        state: "FREE_COOLDOWN",
        cooldownMs: 60_000,
        cooldownReason: "transient-availability",
      }),
    });
    await run(transient.context, "status");
    assert.match(transient.calls.toasts.at(-1).message, /Free: transient outage cooldown 1m 0s/);
  });

  it("reports probing and healthy from the shared state", async () => {
    const probing = fakeContext({
      status: baseStatus({ state: "FREE_PROBE", cooldownMs: 0 }),
    });
    await run(probing.context, "status");
    assert.match(probing.calls.toasts.at(-1).message, /Free: probing/);

    const healthy = fakeContext({ status: baseStatus({ state: "FREE_HEALTHY" }) });
    await run(healthy.context, "status");
    assert.match(healthy.calls.toasts.at(-1).message, /Free: healthy/);
  });

  it("says pricing is ignored in Free First and unused when disabled", async () => {
    const freeFirst = fakeContext({
      status: baseStatus({
        freeUsageMode: "always-free-first",
        configuredFreeUsageMode: "always-free-first",
        freeUsageModeSource: "override",
        pricingState: undefined,
        pricingNextTransition: undefined,
        activeRoute: "FREE",
        state: "FREE_HEALTHY",
      }),
    });
    await run(freeFirst.context, "status");
    assert.match(freeFirst.calls.toasts.at(-1).message, /Mode: Free First \(saved in OpenCode\)/);
    assert.match(
      freeFirst.calls.toasts.at(-1).message,
      /Pricing: not used \(Free First ignores pricing\)/,
    );

    const disabled = fakeContext({
      status: baseStatus({
        routingActive: false,
        freeUsageMode: "off",
        freeUsageModeSource: "override",
        activeRoute: "NONE",
      }),
    });
    await run(disabled.context, "status");
    const message = disabled.calls.toasts.at(-1).message;
    assert.match(message, /Mode: Free-first disabled \(saved in OpenCode\)/);
    assert.match(message, /not managing routing/);
    assert.match(message, /Pricing: not used \(free-first disabled\)/);
    assert.match(message, /\/offpeak off is a different control/);
    assert.doesNotMatch(message, /Mode: Off\b/);
  });
});

describe("/free-first selector", () => {
  it("opens the native selector with the active mode and the three choices", async () => {
    const { context, calls } = fakeContext();
    await run(context, "");
    const dialog = calls.selects.at(-1);
    assert.equal(dialog.title, "Free-first mode");
    assert.equal(dialog.current, "peak-only");
    assert.deepEqual(
      dialog.options.map((option) => option.title),
      ["Free First", "Peak Only", "Disable Free-first"],
    );
    assert.deepEqual(
      dialog.options.map((option) => option.value),
      ["always-free-first", "peak-only", "off"],
    );
    assert.match(dialog.options[2].description, /not \/offpeak off/);
  });

  it("saves the selected Free First mode through the server RPC", async () => {
    const { context, calls } = fakeContext({ select: () => "always-free-first" });
    await run(context, "");
    assert.deepEqual(calls.control.at(-1), { action: "set-mode", mode: "always-free-first" });
    assert.match(calls.toasts.at(-1).message, /Saved in OpenCode/);
    assert.equal(calls.toasts.at(-1).variant, "success");
  });

  it("does nothing when the selector is cancelled", async () => {
    const { context, calls } = fakeContext({ select: () => undefined });
    await run(context, "");
    assert.equal(
      calls.control.some((input) => input.action === "set-mode"),
      false,
    );
    assert.deepEqual(calls.control, [{ action: "status" }]);
    assert.equal(calls.toasts.length, 0);
  });
});

describe("/free-first mode", () => {
  it("accepts the three user-facing modes and the configured escape hatch", async () => {
    const cases = [
      ["mode free-first", { action: "set-mode", mode: "always-free-first" }],
      ["mode peak-only", { action: "set-mode", mode: "peak-only" }],
      ["mode disabled", { action: "set-mode", mode: "off" }],
      ["mode configured", { action: "clear-mode" }],
    ];
    for (const [input, expected] of cases) {
      const { context, calls } = fakeContext();
      await run(context, input);
      assert.deepEqual(calls.control.at(-1), expected);
      assert.equal(calls.toasts.at(-1).variant, "success");
    }
  });

  it("also accepts the raw command text and the implementation alias", async () => {
    const { context, calls } = fakeContext();
    await run(context, "/free-first mode always-free-first");
    assert.deepEqual(calls.control.at(-1), { action: "set-mode", mode: "always-free-first" });
  });

  it("rejects an unknown mode with the documented usage", async () => {
    const { context, calls } = fakeContext();
    await run(context, "mode sometimes");
    assert.equal(calls.control.length, 0);
    assert.equal(calls.toasts.at(-1).variant, "error");
    assert.match(calls.toasts.at(-1).message, /Usage: \/free-first/);
  });

  it("reports a failed RPC as an error toast", async () => {
    const { context, calls } = fakeContext({ fail: new Error("server unavailable") });
    await run(context, "status");
    assert.equal(calls.toasts.at(-1).variant, "error");
    assert.match(calls.toasts.at(-1).message, /server unavailable/);
  });
});
