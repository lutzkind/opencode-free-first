/**
 * Control-RPC semantics. The TUI is a thin client of this handler, so these
 * tests pin the exact commands, aliases, and the wording that keeps
 * "Free-first disabled" distinct from `/offpeak off`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FREE_FIRST_USAGE, handleFreeFirstControl } from "../dist/rpc.js";
import { freeUsageModeLabel, parseFreeUsageMode } from "../dist/types.js";

function fakeEngine(overrides = {}) {
  const calls = [];
  const state = {
    mode: "peak-only",
    enabled: true,
    persisted: true,
    ...overrides,
  };
  return {
    calls,
    state,
    get mode() {
      return state.mode;
    },
    get enabled() {
      return state.enabled;
    },
    async refresh() {
      calls.push("refresh");
    },
    status() {
      return {
        freeUsageMode: state.mode,
        enabled: state.enabled,
        activeRoute: state.mode === "off" ? "NONE" : "GO",
      };
    },
    statusLine() {
      return `status:${state.mode}`;
    },
    setEnabled(enabled) {
      state.enabled = enabled;
      calls.push(["setEnabled", enabled]);
    },
    markHealthy(reason) {
      calls.push(["markHealthy", reason]);
    },
    async setMode(mode) {
      state.mode = mode;
      calls.push(["setMode", mode]);
      return { persisted: state.persisted };
    },
    async clearModeOverride() {
      state.mode = "peak-only";
      calls.push(["clearModeOverride"]);
      return { persisted: state.persisted };
    },
  };
}

describe("control RPC", () => {
  it("reports status without changing anything", async () => {
    const engine = fakeEngine();
    const output = await handleFreeFirstControl(engine, { action: "status" });
    assert.equal(output.status.freeUsageMode, "peak-only");
    assert.equal(output.message, undefined);
    assert.deepEqual(engine.calls, ["refresh"]);
  });

  it("maps every user-facing mode alias to the implementation name", () => {
    assert.equal(parseFreeUsageMode("free-first"), "always-free-first");
    assert.equal(parseFreeUsageMode("always-free-first"), "always-free-first");
    assert.equal(parseFreeUsageMode("peak-only"), "peak-only");
    assert.equal(parseFreeUsageMode("disabled"), "off");
    assert.equal(parseFreeUsageMode("off"), "off");
    assert.equal(parseFreeUsageMode("Peak-Only"), "peak-only");
    assert.equal(parseFreeUsageMode("on"), undefined);
    assert.equal(parseFreeUsageMode(undefined), undefined);
  });

  it("sets Free First with an explicit, non-ambiguous message", async () => {
    const engine = fakeEngine();
    const output = await handleFreeFirstControl(engine, {
      action: "set-mode",
      mode: "free-first",
    });
    assert.equal(engine.mode, "always-free-first");
    assert.equal(output.mode, "always-free-first");
    assert.match(output.message, /Free-first mode: Free First/);
    assert.match(output.message, /whenever it is healthy/);
    assert.match(output.message, /Saved in OpenCode/);
  });

  it("sets Peak Only and records the persisted choice", async () => {
    const engine = fakeEngine({ mode: "always-free-first" });
    const output = await handleFreeFirstControl(engine, {
      action: "set-mode",
      mode: "peak-only",
    });
    assert.equal(engine.mode, "peak-only");
    assert.match(output.message, /Free-first mode: Peak Only/);
    assert.match(output.message, /no Free request or probe/);
  });

  it("labels the disabled mode as Free-first disabled, never as /offpeak off", async () => {
    const engine = fakeEngine();
    const output = await handleFreeFirstControl(engine, {
      action: "set-mode",
      mode: "disabled",
    });
    assert.equal(engine.mode, "off");
    assert.match(output.message, /Free-first disabled/);
    assert.match(output.message, /NOT \/offpeak off/);
    assert.doesNotMatch(output.message, /Free-first mode: Off\b/);
    assert.equal(freeUsageModeLabel("off"), "Free-first disabled");
    assert.notEqual(freeUsageModeLabel("off"), "Off");
  });

  it("accepts the implementation alias and the mode action", async () => {
    const engine = fakeEngine();
    await handleFreeFirstControl(engine, { action: "mode", mode: "always-free-first" });
    assert.equal(engine.mode, "always-free-first");
    await handleFreeFirstControl(engine, { action: "set-mode", mode: "off" });
    assert.equal(engine.mode, "off");
  });

  it("rejects an unknown mode without changing the engine", async () => {
    const engine = fakeEngine();
    await assert.rejects(
      () => handleFreeFirstControl(engine, { action: "set-mode", mode: "sometimes" }),
      (error) => error.message === FREE_FIRST_USAGE,
    );
    assert.equal(engine.mode, "peak-only");
    assert.equal(
      engine.calls.some((call) => Array.isArray(call) && call[0] === "setMode"),
      false,
    );
  });

  it("reports a failed persistence write instead of pretending it was saved", async () => {
    const engine = fakeEngine({ persisted: false });
    const output = await handleFreeFirstControl(engine, {
      action: "set-mode",
      mode: "free-first",
    });
    assert.match(output.message, /could not be written/);
    assert.match(output.message, /will not survive a restart/);
  });

  it("reverts to the configured value with clear-mode", async () => {
    const engine = fakeEngine({ mode: "off" });
    const output = await handleFreeFirstControl(engine, { action: "clear-mode" });
    assert.equal(engine.mode, "peak-only");
    assert.match(output.message, /configured value: Peak Only/);
    assert.match(output.message, /saved choice was removed/);
  });

  it("keeps /offpeak off and the free-first master switch separate", async () => {
    const engine = fakeEngine({ mode: "off" });
    const on = await handleFreeFirstControl(engine, { action: "on" });
    assert.match(on.message, /runtime master switch/);
    assert.match(on.message, /Mode: Free-first disabled/);
    assert.match(on.message, /choose Free First or Peak Only/);

    const off = await handleFreeFirstControl(engine, { action: "off" });
    assert.match(off.message, /runtime master switch/);
    assert.match(off.message, /This is not \/offpeak off/);
    assert.equal(engine.enabled, false);
  });

  it("resets a cooldown through the existing action", async () => {
    const engine = fakeEngine();
    const output = await handleFreeFirstControl(engine, { action: "reset" });
    assert.match(output.message, /cooldown cleared/);
    assert.deepEqual(engine.calls.at(-1), ["markHealthy", "rpc-reset"]);
  });

  it("rejects an unknown action with the documented usage", async () => {
    const engine = fakeEngine();
    await assert.rejects(
      () => handleFreeFirstControl(engine, { action: "reticulate" }),
      (error) => error.message === FREE_FIRST_USAGE,
    );
  });
});
