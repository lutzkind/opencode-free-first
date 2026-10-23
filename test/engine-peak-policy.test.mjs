import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FreeFirstEngine } from "../dist/engine.js";
import {
  engineOptions,
  FakeClock,
  FakePricing,
  FakeSessions,
  FakeStorage,
  FREE,
  OTHER,
  PAID,
  rateLimitError,
} from "./fakes.mjs";

async function boot(overrides = {}) {
  const pricing = overrides.pricing ?? new FakePricing("PEAK");
  const built = engineOptions({
    ...overrides,
    pricing,
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

describe("free usage modes", () => {
  it("always-free-first keeps the healthy free route selected", async () => {
    const built = engineOptions({ config: { freeUsageMode: "always-free-first" } });
    const engine = new FreeFirstEngine(built.options);
    await engine.start();
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.equal(built.sessions.of("switchModel").length, 0);
    assert.equal(engine.status().freeUsageMode, "always-free-first");
    assert.equal(engine.status().activeRoute, "FREE");
    assert.equal(engine.statusLine(), "FREE (fake/fake-free)");
  });

  it("always-free-first keeps the existing 429 failover", async () => {
    const built = engineOptions({ config: { freeUsageMode: "always-free-first" } });
    const engine = new FreeFirstEngine(built.options);
    await engine.start();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine);
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.deepEqual(
      built.sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid"],
    );
  });

  it("off disables free-first routing and failover", async () => {
    const built = engineOptions({ config: { freeUsageMode: "off" } });
    const engine = new FreeFirstEngine(built.options);
    await engine.start();
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    const decision = await retry(engine);
    assert.deepEqual(decision, { retry: false });
    assert.equal(built.sessions.of("switchModel").length, 0);
    assert.equal(engine.status().freeUsageMode, "off");
    assert.equal(engine.status().activeRoute, "NONE");
    assert.match(engine.statusLine(), /free usage mode off/);
  });
});

describe("peak-only", () => {
  it("uses the free route during PEAK when it is healthy", async () => {
    const { engine, sessions, generate, pricing } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.equal(sessions.of("switchModel").length, 0);
    assert.equal(generate.calls.length, 0);
    assert.ok(pricing.calls.length >= 1);
    assert.equal(engine.status().pricingState, "PEAK");
    assert.equal(engine.status().activeRoute, "FREE");
    assert.match(
      engine.statusLine(),
      /FREE policy: PEAK_ONLY \| Pricing: PEAK \| Active route: FREE/,
    );
  });

  it("fails a PEAK 429 over to Go in the same turn", async () => {
    const { engine, sessions, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine);
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.deepEqual(
      sessions.of("switchModel").map((call) => `${call.sessionID}:${call.model.id}`),
      ["ses_a:fake-paid"],
    );
    assert.equal(engine.status().cooldownReason, "rate-limit");
    assert.equal(engine.status().activeRoute, "GO");
    assert.ok(log.has("free rate limit detected"));
  });

  it("fails a PEAK provider 500 over to Go in the same turn", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine, {
      error: { type: "provider.internal", status: 500, message: "internal server error" },
    });
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid"],
    );
    assert.equal(engine.status().cooldownReason, "transient-availability");
  });

  it("routes OFF_PEAK straight to Go with zero free traffic and no probe", async () => {
    const pricing = new FakePricing("OFF_PEAK");
    const { engine, sessions, generate } = await boot({ pricing });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.deepEqual(
      sessions.of("switchModel").map((call) => `${call.sessionID}:${call.model.id}`),
      ["ses_a:fake-paid"],
    );
    assert.equal(generate.calls.length, 0, "no free probe off-peak");
    assert.equal(engine.status().pricingState, "OFF_PEAK");
    assert.equal(engine.status().activeRoute, "GO");
    assert.match(
      engine.statusLine(),
      /FREE policy: PEAK_ONLY \| Pricing: OFF_PEAK \| Active route: GO \| Free preserved until PEAK/,
    );
    // A session that has never been seen is also routed to Go before dispatch.
    await engine.onPrompt("ses_b");
    assert.deepEqual(
      sessions
        .of("switchModel")
        .filter((call) => call.sessionID === "ses_b")
        .map((call) => call.model.id),
      ["fake-paid"],
    );
  });

  it("reports GO as the active route off-peak even while idle sessions still hold a free hint", async () => {
    const pricing = new FakePricing("PEAK");
    const { engine } = await boot({ pricing });
    await engine.refreshPricing(true);
    engine.onModelRequest("ses_idle", FREE, "primary");
    assert.equal(engine.status().activeRoute, "FREE");
    pricing.set("OFF_PEAK");
    await engine.refreshPricing(true);
    // The idle session is not switched until it reaches a safe boundary, but
    // new traffic cannot use Free: the active route is GO, not MIXED.
    assert.equal(engine.status().activeRoute, "GO");
    assert.equal(engine.status().managedSessions, 1);
    assert.equal(engine.status().fallbackSessions, 0);
  });

  it("never probes a cooldown that elapses during OFF_PEAK", async () => {
    const pricing = new FakePricing("PEAK");
    const { engine, clock, generate } = await boot({ pricing });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    assert.equal(engine.status().cooldownReason, "rate-limit");
    const callsBefore = generate.calls.length;
    pricing.set("OFF_PEAK");
    await engine.refreshPricing(true);
    await clock.advance(2_000);
    assert.equal(generate.calls.length, callsBefore, "no free probe during OFF_PEAK");
    assert.equal(engine.status().pricingState, "OFF_PEAK");
    assert.equal(engine.status().activeRoute, "GO");
  });

  it("makes free eligible again at the OFF_PEAK → PEAK boundary", async () => {
    const pricing = new FakePricing("OFF_PEAK");
    const { engine, clock, sessions } = await boot({ pricing });
    pricing.nextTransition = clock.now() + 1_000;
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid"],
    );
    // The classifier flips at the boundary returned with the previous answer.
    pricing.set("PEAK", clock.now() + 60_000);
    await clock.advance(1_000);
    await engine.onPrompt("ses_a");
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid", "fake-free"],
    );
    assert.equal(engine.status().pricingState, "PEAK");
    assert.equal(engine.status().activeRoute, "FREE");
  });

  it("stops new free traffic at PEAK → OFF_PEAK without touching the active turn", async () => {
    const pricing = new FakePricing("PEAK");
    const { engine, clock, sessions } = await boot({ pricing });
    pricing.nextTransition = clock.now() + 1_000;
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.equal(sessions.of("switchModel").length, 0);
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    pricing.set("OFF_PEAK", clock.now() + 60_000);
    await clock.advance(1_000);
    await engine.onPrompt("ses_a");
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid"],
    );
    assert.equal(sessions.of("synthetic").length, 0, "no duplicate continuation");
    assert.equal(sessions.of("interrupt").length, 0, "the active turn was not interrupted");
    assert.equal(sessions.of("switchModel")[0].sessionID, "ses_a");
    assert.equal(engine.status().activeRoute, "GO");
  });

  it("moves the next step of an active free turn to Go at PEAK → OFF_PEAK", async () => {
    const pricing = new FakePricing("PEAK");
    const { engine, clock, sessions } = await boot({ pricing });
    pricing.nextTransition = clock.now() + 1_000;
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    pricing.set("OFF_PEAK", clock.now() + 60_000);
    await clock.advance(1_000);
    await engine.onContext("ses_a", FREE);
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid"],
      "the next step resolves to Go without disturbing the active execution",
    );
    assert.equal(sessions.of("synthetic").length, 0);
    assert.equal(sessions.of("interrupt").length, 0);
    assert.equal(engine.status().activeRoute, "GO");
  });

  it("treats a weekend classification as OFF_PEAK", async () => {
    const pricing = new FakePricing("OFF_PEAK");
    const { engine, sessions } = await boot({ pricing });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid"],
    );
    assert.equal(engine.status().pricingState, "OFF_PEAK");
  });

  it("treats a Chinese public holiday classification as OFF_PEAK", async () => {
    const pricing = new FakePricing("OFF_PEAK");
    const { engine, sessions } = await boot({ pricing });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid"],
    );
  });

  it("uses free during a normal weekday DeepSeek peak window", async () => {
    const pricing = new FakePricing("PEAK");
    const { engine, sessions, log } = await boot({ pricing });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onPrompt("ses_a");
    assert.equal(sessions.of("switchModel").length, 0);
    assert.ok(log.has("free usage pricing changed"));
  });

  it("keeps a live cooldown when it crosses back into PEAK", async () => {
    const pricing = new FakePricing("PEAK");
    const { engine, clock, sessions, generate } = await boot({ pricing });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    pricing.set("OFF_PEAK");
    await clock.advance(500);
    pricing.set("PEAK", clock.now() + 60_000);
    await clock.advance(1_000);
    // The existing recovery path probes at the cooldown boundary because the
    // route became eligible again; the probe confirms and returns the session.
    assert.equal(generate.calls.length, 1);
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid", "fake-free"],
    );
  });

  it("reloads with the mode and routing behavior intact", async () => {
    const pricing = new FakePricing("OFF_PEAK");
    const clock = new FakeClock();
    const storage = new FakeStorage();
    const sessions = new FakeSessions();
    const config = { freeUsageMode: "peak-only", fallback: PAID };
    const first = new FreeFirstEngine(
      engineOptions({ pricing, clock, storage, sessions, config }).options,
    );
    await first.start();
    first.onModelRequest("ses_a", FREE, "primary");
    await first.onPrompt("ses_a");
    await clock.flush();
    await first.dispose();

    pricing.set("PEAK", clock.now() + 60_000);
    const second = new FreeFirstEngine(
      engineOptions({ pricing, clock, storage, sessions, config }).options,
    );
    await second.start();
    await second.onPrompt("ses_a");
    assert.equal(second.status().freeUsageMode, "peak-only");
    assert.equal(second.status().pricingState, "PEAK");
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid", "fake-free"],
      "the reload adopts persisted route state and returns to free at PEAK",
    );
    assert.equal(second.status().activeRoute, "FREE");
  });

  it("keeps cross-instance routing coherent under peak-only", async () => {
    const pricing = new FakePricing("PEAK");
    const clock = new FakeClock();
    const storage = new FakeStorage();
    const config = { freeUsageMode: "peak-only", fallback: PAID };
    const first = new FreeFirstEngine(engineOptions({ pricing, clock, storage, config }).options);
    await first.start();
    first.onModelRequest("ses_a", FREE, "primary");
    await retry(first);
    await clock.advance(0);
    await clock.flush();

    const second = new FreeFirstEngine(engineOptions({ pricing, clock, storage, config }).options);
    await second.start();
    second.onModelRequest("ses_b", FREE, "primary");
    await second.onPrompt("ses_b");
    assert.equal(second.status().fallbackSessions, 2);
    assert.equal(second.status().activeRoute, "GO");
    assert.deepEqual(
      second.status().transitions.map((line) => line.split(" -> ")[1]),
      ["fake/fake-paid"],
      "the second instance adopts the shared cooldown and does not invent a free transition",
    );
  });

  it("does not treat context_length_exceeded as an availability failure", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine, {
      error: {
        type: "provider.invalid-request",
        status: 400,
        message:
          "Your request resulted in more tokens than this model's maximum context length allows. context_length_exceeded",
      },
    });
    assert.deepEqual(decision, { retry: false });
    assert.equal(sessions.of("switchModel").length, 0);
    assert.equal(engine.status().cooldownReason, undefined);
  });

  it("does not fail over on an unrelated manual model change", async () => {
    const { engine, sessions } = await boot();
    engine.onModelSelected({ sessionID: "ses_a", model: OTHER });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    assert.equal(sessions.of("switchModel").length, 0);
  });
});
