/**
 * Regression coverage for the cooldown-expiry defect.
 *
 * Live failure this guards against (2026-10-16): after an authoritative
 * free-tier reset had passed hours earlier, every new session was still being
 * routed to the fallback at prompt admission. The cause was the recovery probe:
 * the host refuses the probe path for the free tier
 * (`Generate.UnavailableError`), the failure was classified as inconclusive, and
 * the inconclusive branch re-armed a *blocking* cooldown every 60 seconds
 * forever, so the free model was never allowed again.
 *
 * The invariant is now explicit: an inconclusive probe is *unknown*, never
 * *limited*, and must never keep the free model blocked.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FreeFirstEngine } from "../dist/engine.js";
import { engineOptions, FakeGenerate, FakeStorage, FREE, OTHER, rateLimitError } from "./fakes.mjs";

const HOST_REFUSED_PROBE = {
  tag: "Generate.UnavailableError",
  message:
    "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
};

async function boot(overrides = {}) {
  const built = engineOptions(overrides);
  const engine = new FreeFirstEngine(built.options);
  await engine.start();
  await built.clock.flush();
  return { engine, ...built };
}

async function failover(engine, sessionID, error = rateLimitError()) {
  engine.onModelRequest(sessionID, FREE, "primary");
  const decision = { retry: false };
  await engine.onRetry({ sessionID, model: FREE, error, attempt: 2, decision });
  return decision;
}

function freeSwitches(sessions) {
  return sessions.of("switchModel").filter((call) => call.model.id === FREE.id);
}

describe("authoritative cooldown expiry", () => {
  it("allows the free model again once the reset time has passed, without a restart", async () => {
    const { engine, clock, sessions, generate } = await boot();
    await failover(engine, "ses_a", {
      ...rateLimitError(),
      response: {
        body: JSON.stringify({ reset_at: new Date(clock.now() + 600_000).toISOString() }),
      },
    });
    assert.equal(engine.status().state, "FREE_COOLDOWN");
    assert.equal(engine.status().cooldownMs, 600_000);

    // The process stays alive across the boundary.
    await clock.advance(600_001);
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().cooldownMs, 0);
    assert.equal(generate.calls.length, 1, "recovery used one probe");

    // A brand new session selects the free model and starts a task.
    const before = sessions.of("switchModel").length;
    await engine.onPrompt("ses_new");
    assert.equal(sessions.of("switchModel").length, before, "no downgrade after expiry");
  });

  it("does not downgrade for hours when the host refuses the probe path", async () => {
    // Exactly the live defect: the reset passed long ago, the probe can never
    // succeed, and new sessions must still be allowed to use the free model.
    const generate = new FakeGenerate();
    generate.error = HOST_REFUSED_PROBE;
    const { engine, clock, sessions, log } = await boot({ generate });

    await failover(engine, "ses_a", {
      ...rateLimitError(),
      response: {
        body: JSON.stringify({ reset_at: new Date(clock.now() + 60_000).toISOString() }),
      },
    });
    assert.equal(engine.status().state, "FREE_COOLDOWN");

    // Hours pass with the process alive.
    await clock.advance(8 * 3_600_000);

    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().cooldownMs, 0);
    assert.match(engine.status().lastProbeOutcome, /^unsupported:/);
    assert.ok(log.has("the recovery probe is not permitted for this model"));
    // Only the real limit ever blocked anything.
    const blocked = engine.status().transitions.filter((line) => line.includes("prompt-admission"));
    assert.deepEqual(blocked, []);

    // A new session manually selects the free model and must stay on it.
    const before = sessions.of("switchModel").length;
    await engine.onPrompt("ses_new");
    await engine.onPrompt("ses_another");
    assert.equal(
      sessions.of("switchModel").length,
      before,
      "new sessions stayed on the free model",
    );

    // Even a failing probe attempt is not retried into a block.
    assert.ok(generate.calls.length <= 2, `bounded probing, got ${generate.calls.length}`);
  });

  it("keeps recovering sessions to the free model after an inconclusive probe", async () => {
    const generate = new FakeGenerate();
    generate.error = HOST_REFUSED_PROBE;
    const { engine, clock } = await boot({ generate });
    await failover(engine, "ses_a");
    await clock.advance(1_500);
    assert.equal(engine.status().fallbackSessions, 0, "the session returned to the free model");
    assert.equal(engine.status().state, "FREE_HEALTHY");
  });
});

describe("cross-instance state", () => {
  it("a stale instance cannot resurrect an expired cooldown", async () => {
    const storage = new FakeStorage();
    const { engine, clock, sessions } = await boot({ storage });
    // Another instance stored a cooldown that has since expired.
    await storage.set("opencode-free-first/health-v1", {
      schemaVersion: 1,
      scope: "fake/fake-free",
      state: "FREE_COOLDOWN",
      cooldownUntil: clock.now() - 3_600_000,
      level: 4,
      lastRateLimitAt: clock.now() - 7_200_000,
      lastResetSource: "retry-after",
    });
    await engine.onPrompt("ses_new");
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().cooldownMs, 0);
    assert.equal(sessions.of("switchModel").length, 0, "the expired record routed nothing");
  });

  it("a stale instance cannot resurrect a cooldown it adopted earlier", async () => {
    const storage = new FakeStorage();
    const { engine, clock, sessions } = await boot({ storage });
    await storage.set("opencode-free-first/health-v1", {
      schemaVersion: 1,
      scope: "fake/fake-free",
      state: "FREE_COOLDOWN",
      cooldownUntil: clock.now() + 30_000,
      level: 1,
      lastRateLimitAt: clock.now(),
      lastResetSource: "retry-after",
    });
    // Adopting makes this instance hold a cooldown that later expires.
    await engine.onPrompt("ses_a");
    assert.equal(engine.status().state, "FREE_COOLDOWN");
    await clock.advance(30_100);
    assert.equal(engine.status().state, "FREE_HEALTHY");
    const before = sessions.of("switchModel").length;
    await engine.onPrompt("ses_b");
    assert.equal(sessions.of("switchModel").length, before);
  });

  it("a stale instance cannot overwrite a newer confirmed recovery", async () => {
    const storage = new FakeStorage();
    const { engine, clock } = await boot({ storage });
    await failover(engine, "ses_a");
    await clock.advance(0);
    const before = storage.plain()["opencode-free-first/health-v1"];
    assert.equal(before.state, "FREE_COOLDOWN");

    // Another instance confirms a recovery that is newer than the limit.
    await storage.set("opencode-free-first/health-v1", {
      schemaVersion: 1,
      scope: "fake/fake-free",
      state: "FREE_HEALTHY",
      level: 0,
      lastHealthyAt: clock.now() + 1,
      lastRateLimitAt: before.lastRateLimitAt,
    });
    await engine.refresh();
    assert.equal(engine.status().state, "FREE_HEALTHY", "the foreign recovery was adopted");

    // Any write from this instance must keep the recovery, not resurrect the
    // cooldown it was holding in memory.
    engine.onModelRequest("ses_a", FREE, "primary");
    await clock.advance(0);
    const after = storage.plain()["opencode-free-first/health-v1"];
    assert.equal(after.state, "FREE_HEALTHY");
    assert.equal(after.cooldownUntil, undefined);
  });

  it("a newer real limit replaces a healthy state with a fresh cooldown", async () => {
    const { engine, clock } = await boot();
    await failover(engine, "ses_a");
    await clock.advance(1_500);
    assert.equal(engine.status().state, "FREE_HEALTHY");
    const firstLimit = engine.status().lastRateLimitAt;

    clock.jump(120_000);
    await failover(engine, "ses_b");
    assert.equal(engine.status().state, "FREE_COOLDOWN");
    assert.ok(
      engine.status().lastRateLimitAt > firstLimit,
      "the new limit replaced the old timestamp",
    );
    assert.equal(engine.status().level, 1, "the ladder was reset by the recovery");
  });
});

describe("manual free-model selection", () => {
  it("stays on the free model after an expired cooldown", async () => {
    const { engine, clock, sessions } = await boot();
    await failover(engine, "ses_a");
    await clock.advance(5_000);
    const before = sessions.of("switchModel").length;
    // The user picks the free model by hand and starts a task.
    engine.onModelSelected({ sessionID: "ses_new", model: FREE, previous: OTHER });
    await engine.onPrompt("ses_new");
    assert.equal(sessions.of("switchModel").length, before, "nothing moved it off the free model");
    assert.equal(engine.status().fallbackSessions, 0);
  });

  it("still falls back during a genuinely active cooldown", async () => {
    const { engine, sessions, generate } = await boot();
    await failover(engine, "ses_a", {
      ...rateLimitError(),
      response: { body: JSON.stringify({ retry_after: 3600 }) },
    });
    assert.equal(engine.status().cooldownMs, 3_600_000);
    generate.error = undefined;
    engine.onModelSelected({ sessionID: "ses_b", model: FREE, previous: OTHER });
    await engine.onPrompt("ses_b");
    assert.deepEqual(
      sessions.of("switchModel").map((call) => `${call.sessionID}:${call.model.id}`),
      ["ses_a:fake-paid", "ses_b:fake-paid"],
      "a valid cooldown still avoids spending a free request",
    );
  });

  it("re-enables management when the free model is picked again", async () => {
    const { engine, sessions } = await boot();
    engine.onModelSelected({ sessionID: "ses_a", model: OTHER, previous: FREE });
    assert.equal(engine.status().manualOverrides, 1);
    engine.onModelSelected({ sessionID: "ses_a", model: FREE, previous: OTHER });
    assert.equal(engine.status().manualOverrides, 0);
    assert.equal(engine.status().managedSessions, 1);
    void sessions;
  });
});

describe("transition churn", () => {
  it("records exactly two transitions for one limit cycle and none afterwards", async () => {
    const { engine, clock, sessions } = await boot();
    await failover(engine, "ses_a");
    await clock.advance(5_000);
    assert.equal(engine.status().transitions.length, 2);
    const baseline = sessions.of("switchModel").length;

    for (let index = 0; index < 20; index += 1) {
      await engine.onPrompt(`ses_${index}`);
      engine.onModelRequest(`ses_${index}`, FREE, "primary");
      engine.onHttpResponse({ sessionID: `ses_${index}`, model: FREE, status: 200 });
    }
    assert.equal(
      sessions.of("switchModel").length,
      baseline,
      "healthy free period switches nothing",
    );
    assert.equal(engine.status().transitions.length, 2);
  });

  it("does not busy-loop the scheduler on an elapsed cooldown", async () => {
    const generate = new FakeGenerate();
    generate.error = HOST_REFUSED_PROBE;
    const { engine, clock } = await boot({ generate });
    await failover(engine, "ses_a");
    await clock.advance(1_500);
    // The elapsed cooldown must leave the record, otherwise the scheduler keeps
    // waking for a boundary that is already behind us.
    assert.equal(engine.status().cooldownEndsAt, undefined);
    const pending = clock.pendingTimers;
    await clock.advance(1_000);
    assert.ok(clock.pendingTimers <= 1, `expected no repeating timer, got ${clock.pendingTimers}`);
    void pending;
  });

  it("does not re-block after repeated inconclusive probes", async () => {
    const generate = new FakeGenerate();
    generate.error = HOST_REFUSED_PROBE;
    const { engine, clock, sessions } = await boot({ generate });
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await failover(engine, `ses_${cycle}`);
      await clock.advance(6_000);
      assert.equal(engine.status().state, "FREE_HEALTHY", `cycle ${cycle}`);
      assert.equal(engine.status().cooldownMs, 0, `cycle ${cycle}`);
    }
    assert.equal(engine.status().fallbackSessions, 0, "every session ended up on the free model");
    assert.equal(freeSwitches(sessions).length, 4, "one return per session, no churn");
  });
});
