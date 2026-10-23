/**
 * Mode-control tests: the persisted TUI/RPC choice, its precedence over the
 * configured `freeUsageMode`, and the safety of every transition.
 *
 * Everything here is deterministic: pricing is a fake, provider failures are
 * injected, and no real request is made.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FreeFirstEngine } from "../dist/engine.js";
import { freeUsageModeLabel, MODE_STORAGE_KEY } from "../dist/types.js";
import {
  engineOptions,
  FakeClock,
  FakePricing,
  FakeStorage,
  FREE,
  OTHER,
  PAID,
  rateLimitError,
} from "./fakes.mjs";

async function boot(overrides = {}) {
  const pricing = "pricing" in overrides ? overrides.pricing : new FakePricing("PEAK");
  const built = engineOptions({
    ...overrides,
    ...(pricing === undefined ? {} : { pricing }),
    config: {
      freeUsageMode: "peak-only",
      ...(overrides.config ?? {}),
    },
  });
  const engine = new FreeFirstEngine(built.options);
  await engine.start();
  await built.clock.flush();
  return { engine, pricing, ...built };
}

async function retry(engine, overrides = {}) {
  const input = {
    sessionID: "ses_a",
    model: FREE,
    error: rateLimitError(),
    attempt: 2,
    decision: { retry: false },
    ...overrides,
  };
  await engine.onRetry(input);
  return input.decision;
}

function switchedTo(sessions) {
  return sessions.of("switchModel").map((call) => call.model.id);
}

describe("free usage mode control", () => {
  it("reports the configured peak-only mode without inventing an override", async () => {
    const { engine } = await boot({ config: { freeUsageMode: "peak-only" } });
    const status = engine.status();
    assert.equal(status.freeUsageMode, "peak-only");
    assert.equal(status.configuredFreeUsageMode, "peak-only");
    assert.equal(status.freeUsageModeSource, "config");
    assert.equal(freeUsageModeLabel(status.freeUsageMode), "Peak Only");
    assert.equal(status.routingActive, true);
  });

  it("notifies the host so model defaults can be rebuilt on every mode change", async () => {
    const seen = [];
    const storage = new FakeStorage();
    const first = await boot({
      storage,
      pricing: new FakePricing("PEAK"),
      onModeChanged: async (mode) => {
        seen.push(mode);
      },
    });
    await first.engine.setMode("always-free-first");
    await first.engine.setMode("peak-only");
    await first.engine.clearModeOverride();
    assert.deepEqual(seen, ["always-free-first", "peak-only", "peak-only"]);

    const second = await boot({
      storage,
      pricing: new FakePricing("PEAK"),
      config: { freeUsageMode: "always-free-first" },
      onModeChanged: async (mode) => {
        seen.push(`adopted:${mode}`);
      },
    });
    await first.engine.setMode("off");
    second.engine.onModelRequest("ses_b", FREE, "primary");
    await second.engine.onPrompt("ses_b");
    assert.ok(seen.includes("adopted:off"));
  });

  it("persists a selected mode and restores it in a fresh engine", async () => {
    const storage = new FakeStorage();
    const first = await boot({ storage, pricing: new FakePricing("OFF_PEAK") });
    assert.deepEqual(await first.engine.setMode("always-free-first"), { persisted: true });
    const saved = storage.plain()[MODE_STORAGE_KEY];
    assert.equal(saved.mode, "always-free-first");
    assert.equal(saved.schemaVersion, 1);
    await first.engine.dispose();

    const second = await boot({ storage, pricing: new FakePricing("OFF_PEAK") });
    assert.equal(second.engine.mode, "always-free-first");
    assert.equal(second.engine.modeSource, "override");
    assert.equal(second.engine.status().freeUsageModeSource, "override");
    assert.equal(second.engine.status().configuredFreeUsageMode, "peak-only");
  });

  it("a saved override wins over the configured mode at boot", async () => {
    const storage = new FakeStorage({
      [MODE_STORAGE_KEY]: {
        schemaVersion: 1,
        mode: "always-free-first",
        updatedAt: 1,
      },
    });
    const { engine, sessions, pricing } = await boot({
      storage,
      pricing: new FakePricing("OFF_PEAK"),
    });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.equal(engine.mode, "always-free-first");
    assert.equal(switchedTo(sessions).length, 0);
    assert.equal(pricing.calls.length, 0, "Free First does not consult pricing");
  });

  it("ignores a corrupt or incompatible saved mode", async () => {
    const storage = new FakeStorage({
      [MODE_STORAGE_KEY]: { schemaVersion: 99, mode: "always-free-first" },
    });
    const { engine } = await boot({ storage, config: { freeUsageMode: "peak-only" } });
    assert.equal(engine.mode, "peak-only");
    assert.equal(engine.modeSource, "config");
  });

  it("Peak Only -> Free First makes Free eligible at the next prompt", async () => {
    const { engine, sessions, pricing } = await boot({
      pricing: new FakePricing("OFF_PEAK"),
    });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.deepEqual(switchedTo(sessions), ["fake-paid"]);

    const callsBefore = pricing.calls.length;
    await engine.setMode("always-free-first");
    await engine.onPrompt("ses_a");
    assert.deepEqual(switchedTo(sessions), ["fake-paid", "fake-free"]);
    assert.equal(engine.status().activeRoute, "FREE");
    assert.equal(
      pricing.calls.length,
      callsBefore,
      "Free First must not keep asking the pricing owner",
    );
  });

  it("Free First -> Peak Only off-peak routes the active turn to Go without a probe", async () => {
    const { engine, sessions, generate, clock } = await boot({
      pricing: new FakePricing("OFF_PEAK"),
      config: { freeUsageMode: "always-free-first" },
    });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.equal(switchedTo(sessions).length, 0);

    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    await engine.setMode("peak-only");
    assert.deepEqual(switchedTo(sessions), ["fake-paid"], "the active turn moves at its next step");
    assert.equal(generate.calls.length, 0, "no Free recovery probe off-peak");
    assert.equal(engine.status().pricingState, "OFF_PEAK");
    assert.equal(engine.status().activeRoute, "GO");
    assert.equal(engine.defaultTarget().id, "fake-paid");

    await engine.onPrompt("ses_a");
    await clock.advance(10 * 60_000);
    assert.deepEqual(switchedTo(sessions), ["fake-paid"], "no duplicate switch and no probe");
    assert.equal(generate.calls.length, 0);
  });

  it("Free First -> Peak Only during PEAK keeps Free", async () => {
    const { engine, sessions } = await boot({
      pricing: new FakePricing("PEAK"),
      config: { freeUsageMode: "always-free-first" },
    });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    await engine.setMode("peak-only");
    assert.equal(switchedTo(sessions).length, 0);
    assert.equal(engine.status().activeRoute, "FREE");
    assert.equal(engine.status().pricingState, "PEAK");
  });

  it("peak-only fails closed when the pricing capability is absent", async () => {
    const { engine, sessions } = await boot({ pricing: undefined });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.deepEqual(switchedTo(sessions), ["fake-paid"]);
    assert.equal(engine.status().pricingState, "UNKNOWN");
    assert.equal(engine.status().activeRoute, "GO");

    await engine.setMode("always-free-first");
    await engine.onPrompt("ses_a");
    assert.deepEqual(switchedTo(sessions), ["fake-paid", "fake-free"]);
  });

  it("disabled stops routing, failover, probes, and timers", async () => {
    const { engine, sessions, generate, clock, storage } = await boot({
      pricing: new FakePricing("PEAK"),
      config: { freeUsageMode: "always-free-first" },
    });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.setMode("off");
    assert.equal(engine.status().routingActive, false);
    assert.match(engine.statusLine(), /Free-first disabled/);
    assert.equal(engine.status().activeRoute, "NONE");
    await clock.advance(0);
    assert.equal(clock.pendingTimers, 0, "no timer survives disabling");

    await engine.onPrompt("ses_a");
    const decision = await retry(engine);
    assert.deepEqual(decision, { retry: false });
    assert.equal(switchedTo(sessions).length, 0);
    assert.equal(generate.calls.length, 0);
    const health = storage.plain()["opencode-free-first/health-v1"];
    assert.equal(health?.cooldownUntil, undefined, "disabling manufactures no cooldown");
    assert.equal(health?.state, "FREE_HEALTHY");
  });

  it("Disabled -> Free First re-enables cleanly", async () => {
    const { engine, sessions } = await boot({
      pricing: new FakePricing("PEAK"),
      config: { freeUsageMode: "always-free-first" },
    });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.setMode("off");
    await engine.setMode("always-free-first");
    await engine.onPrompt("ses_a");
    assert.equal(engine.status().activeRoute, "FREE");
    assert.equal(switchedTo(sessions).length, 0);
  });

  it("Disabled -> Peak Only re-enables cleanly at PEAK", async () => {
    const { engine, sessions } = await boot({ pricing: new FakePricing("PEAK") });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.setMode("off");
    await engine.setMode("peak-only");
    await engine.onPrompt("ses_a");
    assert.equal(engine.status().activeRoute, "FREE");
    assert.equal(switchedTo(sessions).length, 0);
  });

  it("a genuine Free cooldown survives every mode switch", async () => {
    const { engine, sessions, storage, clock } = await boot({
      pricing: new FakePricing("OFF_PEAK"),
      config: { freeUsageMode: "always-free-first" },
    });
    engine.onModelRequest("ses_a", FREE, "primary");
    assert.deepEqual(await retry(engine), { retry: true, delay: 100 });
    await clock.advance(0);
    assert.equal(engine.status().cooldownReason, "rate-limit");
    const endsAt = engine.status().cooldownEndsAt;
    assert.ok(endsAt > 0);

    await engine.setMode("peak-only");
    assert.equal(engine.status().cooldownEndsAt, endsAt);
    await engine.setMode("off");
    assert.equal(engine.status().cooldownEndsAt, endsAt);
    await engine.setMode("always-free-first");
    assert.equal(engine.status().cooldownEndsAt, endsAt);
    assert.equal(storage.plain()["opencode-free-first/health-v1"].cooldownUntil, endsAt);

    // The cooldown still owns routing: Free is not spent while it is live.
    await engine.onPrompt("ses_a");
    assert.deepEqual(switchedTo(sessions), ["fake-paid"]);
  });

  it("a mode switch during an active turn never interrupts or duplicates it", async () => {
    const { engine, sessions, generate } = await boot({
      pricing: new FakePricing("OFF_PEAK"),
      config: { freeUsageMode: "always-free-first" },
    });
    engine.onModelRequest("ses_a", FREE, "primary");
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    await engine.setMode("peak-only");
    assert.equal(sessions.of("switchModel").length, 1);
    assert.equal(sessions.of("synthetic").length, 0);
    assert.equal(sessions.of("interrupt").length, 0);
    assert.equal(generate.calls.length, 0);
    assert.equal(engine.status().transitions.length, 1);
  });

  it("a compaction that just limited stays on Go across a mode switch", async () => {
    const { engine, sessions } = await boot({
      pricing: new FakePricing("OFF_PEAK"),
      config: { freeUsageMode: "always-free-first" },
    });
    engine.onModelRequest("ses_a", FREE, "compaction");
    const decision = await retry(engine);
    assert.deepEqual(decision, { retry: false });
    assert.deepEqual(switchedTo(sessions), ["fake-paid"]);

    await engine.setMode("peak-only");
    await engine.onPrompt("ses_a");
    assert.deepEqual(switchedTo(sessions), ["fake-paid"]);
    assert.equal(sessions.of("synthetic").length, 0);
  });

  it("does not treat the plugin's own published default as a manual override", async () => {
    const { engine, sessions } = await boot({ pricing: new FakePricing("OFF_PEAK") });
    engine.rememberPublishedDefault(PAID);
    engine.onModelSelected({ sessionID: "ses_a", model: PAID });
    assert.equal(engine.status().manualOverrides, 0);
    await engine.setMode("always-free-first");
    await engine.onPrompt("ses_a");
    assert.deepEqual(switchedTo(sessions), ["fake-free"]);
  });

  it("recognises a fallback title dispatch before prompt admission and upgrades later", async () => {
    const { engine, sessions } = await boot({ pricing: new FakePricing("OFF_PEAK") });
    engine.rememberPublishedDefault(PAID);
    // A title/auxiliary request can reach the provider before the prompt hook.
    engine.onModelRequest("ses_a", PAID, "title");
    assert.equal(engine.status().fallbackSessions, 1);
    assert.equal(engine.status().manualOverrides, 0);
    await engine.setMode("always-free-first");
    await engine.onPrompt("ses_a");
    assert.deepEqual(switchedTo(sessions), ["fake-free"]);
  });

  it("does not adopt a fallback dispatch when adoption is disabled", async () => {
    const { engine, sessions } = await boot({
      pricing: new FakePricing("OFF_PEAK"),
      config: { adoptFallbackSessions: false },
    });
    engine.onModelRequest("ses_a", PAID, "title");
    assert.equal(engine.status().fallbackSessions, 0);
    await engine.setMode("always-free-first");
    await engine.onPrompt("ses_a");
    assert.equal(switchedTo(sessions).length, 0);
  });

  it("still treats a deliberate Go selection as a manual override", async () => {
    const { engine, sessions } = await boot({
      pricing: new FakePricing("OFF_PEAK"),
      config: { freeUsageMode: "always-free-first" },
    });
    engine.rememberPublishedDefault(PAID);
    engine.onModelRequest("ses_a", FREE, "primary");
    engine.onModelSelected({ sessionID: "ses_a", model: PAID, previous: FREE });
    assert.equal(engine.status().manualOverrides, 1);
    await engine.setMode("always-free-first");
    await engine.onPrompt("ses_a");
    assert.equal(switchedTo(sessions).length, 0);
  });

  it("respects a manual model override across mode switches", async () => {
    const { engine, sessions } = await boot({
      pricing: new FakePricing("OFF_PEAK"),
      config: { freeUsageMode: "always-free-first" },
    });
    engine.onModelSelected({ sessionID: "ses_a", model: OTHER });
    await engine.setMode("peak-only");
    await engine.onPrompt("ses_a");
    assert.equal(switchedTo(sessions).length, 0);
    assert.equal(engine.status().manualOverrides, 1);
  });

  it("an explicit mode change is a no-cost save even when persistence fails", async () => {
    const storage = new FakeStorage();
    storage.set = async (key) => {
      if (key === MODE_STORAGE_KEY) throw new Error("storage unavailable");
      throw new Error(`unexpected write ${key}`);
    };
    const { engine } = await boot({ storage, config: { freeUsageMode: "always-free-first" } });
    const result = await engine.setMode("peak-only");
    assert.deepEqual(result, { persisted: false });
    assert.equal(engine.mode, "peak-only", "the running instance still applies the choice");
  });

  it("the master switch still wins over a saved mode", async () => {
    const { engine } = await boot({ config: { enabled: false, freeUsageMode: "peak-only" } });
    await engine.setMode("always-free-first");
    assert.equal(engine.mode, "always-free-first");
    assert.equal(engine.enabled, false);
    assert.equal(engine.status().routingActive, false);
  });

  it("another instance adopts a saved mode at its next prompt", async () => {
    const storage = new FakeStorage();
    const first = await boot({ storage, pricing: new FakePricing("PEAK") });
    await first.engine.setMode("peak-only");

    const second = await boot({
      storage,
      pricing: new FakePricing("OFF_PEAK"),
      config: { freeUsageMode: "always-free-first" },
    });
    second.engine.onModelRequest("ses_b", FREE, "primary");
    await second.engine.onPrompt("ses_b");
    assert.equal(second.engine.mode, "peak-only");
    assert.deepEqual(switchedTo(second.sessions), ["fake-paid"]);
  });

  it("clearModeOverride reverts to the configured mode and removes the saved row", async () => {
    const storage = new FakeStorage();
    const { engine } = await boot({ storage, config: { freeUsageMode: "peak-only" } });
    await engine.setMode("off");
    assert.equal(storage.plain()[MODE_STORAGE_KEY].mode, "off");
    const result = await engine.clearModeOverride();
    assert.deepEqual(result, { persisted: true });
    assert.equal(engine.mode, "peak-only");
    assert.equal(engine.modeSource, "config");
    assert.equal(storage.plain()[MODE_STORAGE_KEY], undefined);
  });

  it("disabling an elapsed cooldown does not probe when re-enabled off-peak", async () => {
    const clock = new FakeClock();
    const pricing = new FakePricing("PEAK");
    const { engine, generate } = await boot({ clock, pricing });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    await engine.setMode("off");
    clock.jump(10 * 60_000);
    pricing.set("OFF_PEAK", clock.now() + 60_000);
    await engine.setMode("peak-only");
    await engine.onPrompt("ses_a");
    assert.equal(generate.calls.length, 0, "no probe at OFF_PEAK");
    assert.equal(engine.status().pricingState, "OFF_PEAK");
  });
});
