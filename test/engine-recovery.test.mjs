import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FreeFirstEngine } from "../dist/engine.js";
import {
  engineOptions,
  FakeClock,
  FakeGenerate,
  FakeSessions,
  FakeStorage,
  FREE,
  OTHER,
  PAID,
  rateLimitError,
} from "./fakes.mjs";

async function boot(overrides = {}) {
  const built = engineOptions(overrides);
  const engine = new FreeFirstEngine(built.options);
  await engine.start();
  await built.clock.flush();
  return { engine, ...built };
}

async function failover(engine, sessionID = "ses_a", error = rateLimitError()) {
  engine.onModelRequest(sessionID, FREE, "primary");
  const decision = { retry: false };
  await engine.onRetry({ sessionID, model: FREE, error, attempt: 2, decision });
  return decision;
}

function switchTargets(sessions) {
  return sessions
    .of("switchModel")
    .map((call) => `${call.sessionID}:${call.model.providerID}/${call.model.id}`);
}

describe("recovery", () => {
  it("probes once at cooldown expiry and returns every waiting session to the free model", async () => {
    const { engine, clock, generate, sessions, log } = await boot();
    await failover(engine, "ses_a");
    await failover(engine, "ses_b");
    assert.equal(sessions.of("switchModel").length, 2);

    await clock.advance(1_500);
    assert.equal(generate.calls.length, 1, "exactly one probe for both sessions");
    assert.deepEqual(generate.calls[0].model, FREE);
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.ok(log.has("recovery probe started"));
    assert.ok(log.has("cooldown expired"));

    const back = sessions
      .of("switchModel")
      .slice(2)
      .filter((call) => call.model.id === FREE.id);
    assert.equal(back.length, 2, "each waiting session returned exactly once");
  });

  it("switches back only after the probe confirms recovery", async () => {
    const { engine, clock, sessions } = await boot();
    await failover(engine, "ses_a");
    // Not yet: the cooldown is still running.
    await clock.advance(500);
    assert.equal(sessions.of("switchModel").length, 1);
    await clock.advance(600);
    assert.deepEqual(switchTargets(sessions), ["ses_a:fake/fake-paid", "ses_a:fake/fake-free"]);
  });

  it("keeps the fallback session undisturbed when the probe is rate-limited", async () => {
    const generate = new FakeGenerate();
    generate.error = rateLimitError({ status: 429, type: "provider.rate-limit" });
    const { engine, clock, sessions, log } = await boot({ generate });
    await failover(engine, "ses_a");
    await clock.advance(1_500);
    assert.equal(sessions.of("switchModel").length, 1, "the main session was never touched");
    assert.equal(engine.status().state, "FREE_COOLDOWN");
    assert.equal(engine.status().level, 2);
    assert.ok(log.has("recovery probe rate-limited"));
    assert.ok(engine.status().cooldownMs > 0);
  });

  it("treats an inconclusive probe as neither health nor exhaustion", async () => {
    const generate = new FakeGenerate();
    generate.error = { type: "provider.internal", status: 500, message: "internal server error" };
    const { engine, clock, sessions, log } = await boot({ generate });
    await failover(engine, "ses_a");
    await clock.advance(1_500);
    assert.equal(sessions.of("switchModel").length, 1);
    assert.equal(engine.status().level, 1, "the ladder did not advance");
    assert.ok(log.has("recovery probe inconclusive"));
    assert.ok(engine.status().cooldownMs > 1_000, "a short retry was armed");
  });

  it("wakes up again after an inconclusive probe", async () => {
    const generate = new FakeGenerate();
    generate.error = { type: "provider.transport", message: "socket hang up" };
    const { engine, clock } = await boot({ generate });
    await failover(engine, "ses_a");
    await clock.advance(1_500);
    const probes = generate.calls.length;
    generate.error = undefined;
    await clock.advance(61_000);
    assert.ok(generate.calls.length > probes, "a later probe was attempted");
  });

  it("runs recovery passively when probing is disabled", async () => {
    const { engine, clock, generate, sessions } = await boot({ config: { probe: false } });
    await failover(engine, "ses_a");
    await clock.advance(1_500);
    assert.equal(generate.calls.length, 0);
    assert.equal(
      sessions.of("switchModel").length,
      2,
      "the session returned to free without a probe",
    );
  });

  it("only recovers sessions it adopted, never unrelated ones", async () => {
    const { engine, clock, sessions } = await boot({ config: { adoptFallbackSessions: false } });
    engine.onModelSelected({ sessionID: "ses_other", model: OTHER });
    await clock.advance(1_500);
    assert.equal(sessions.of("switchModel").length, 0);
  });

  it("survives a mid-flight provider outage after failing over", async () => {
    const { engine, clock, generate } = await boot();
    await failover(engine, "ses_a");
    generate.error = new Error("network down");
    await clock.advance(1_500);
    assert.equal(engine.status().state, "FREE_COOLDOWN");
  });
});

describe("cache-aware switch minimisation", () => {
  it("never switches while the free model is healthy", async () => {
    const { engine, clock, sessions } = await boot();
    for (let index = 0; index < 20; index += 1) {
      engine.onModelRequest("ses_a", FREE, "primary");
      engine.onHttpResponse({ sessionID: "ses_a", model: FREE, status: 200 });
      await clock.advance(1_000);
    }
    assert.equal(sessions.of("switchModel").length, 0);
  });

  it("performs exactly two transitions per free-limit cycle", async () => {
    const { engine, clock, sessions } = await boot();
    await failover(engine, "ses_a");
    await clock.advance(1_500);
    assert.deepEqual(switchTargets(sessions), ["ses_a:fake/fake-paid", "ses_a:fake/fake-free"]);
    assert.equal(engine.status().level, 0, "recovery reset the ladder");
  });

  it("survives three consecutive cycles without thrashing", async () => {
    const { engine, clock, sessions, log, generate } = await boot();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await failover(engine, "ses_a");
      await clock.advance(3_500);
    }
    assert.equal(sessions.of("switchModel").length, 6, JSON.stringify(engine.status().transitions));
    assert.equal(generate.calls.length, 3, "one probe per cycle");
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(log.detailFor("cooldown started").level, 1);
  });

  it("does not switch a session that is actively streaming on the fallback", async () => {
    const { engine, clock, sessions } = await boot();
    await failover(engine, "ses_a");
    // The fallback request is dispatching and progressing normally.
    engine.onModelRequest("ses_a", PAID, "primary");
    engine.onContext("ses_a", PAID);
    await clock.advance(10_000);
    const freeSwitches = sessions.of("switchModel").filter((call) => call.model.id === FREE.id);
    assert.equal(
      freeSwitches.length,
      1,
      "the session returned in the recovery tick, not mid-request",
    );
  });

  it("never switches in the middle of a prepared fallback attempt", async () => {
    const { engine, clock, sessions } = await boot();
    await failover(engine, "ses_a");
    engine.onContext("ses_a", PAID);
    const before = sessions.of("switchModel").length;
    await engine.onContext("ses_a", PAID);
    assert.equal(sessions.of("switchModel").length, before);
    await clock.advance(1_500);
    assert.equal(sessions.of("switchModel").length, before + 1);
  });
});

describe("prompt and prepare routing", () => {
  it("downgrades a managed free session before the turn resolves its model", async () => {
    const { engine, sessions } = await boot();
    await failover(engine, "ses_a");
    // The cooldown is still running, so a fresh prompt must not go to the free model.
    await engine.onPrompt("ses_a");
    const downgrades = sessions.of("switchModel").filter((call) => call.model.id === PAID.id);
    assert.equal(downgrades.length, 1, "already on the fallback: no extra switch");
  });

  it("routes a new session to the fallback while the free model is cooling down", async () => {
    const sessions = new FakeSessions({ ses_new: FREE });
    const { engine } = await boot({ sessions });
    await failover(engine, "ses_x");
    await engine.onPrompt("ses_new");
    assert.deepEqual(switchTargets(sessions).slice(-1), ["ses_new:fake/fake-paid"]);
  });

  it("routes an adopted fallback session back to the free model when it is healthy", async () => {
    const sessions = new FakeSessions({ ses_paid: PAID });
    const { engine } = await boot({ sessions });
    await engine.onPrompt("ses_paid");
    assert.deepEqual(switchTargets(sessions), ["ses_paid:fake/fake-free"]);
  });

  it("leaves an unadopted fallback session alone", async () => {
    const sessions = new FakeSessions({ ses_paid: PAID });
    const { engine } = await boot({ config: { adoptFallbackSessions: false }, sessions });
    await engine.onPrompt("ses_paid");
    assert.equal(sessions.of("switchModel").length, 0);
  });

  it("never touches a session the user opted out of", async () => {
    const sessions = new FakeSessions({ ses_a: OTHER });
    const { engine } = await boot({ sessions });
    engine.onModelSelected({ sessionID: "ses_a", model: OTHER });
    await engine.onPrompt("ses_a");
    await failover(engine, "ses_a");
    assert.equal(sessions.of("switchModel").length, 0);
  });

  it("honours a manual override even during a cooldown", async () => {
    const { engine, clock, sessions } = await boot();
    await failover(engine, "ses_a");
    engine.onModelSelected({ sessionID: "ses_a", model: OTHER, previous: PAID });
    const before = sessions.of("switchModel").length;
    engine.onModelRequest("ses_a", OTHER, "primary");
    await clock.advance(5_000);
    await engine.onPrompt("ses_a");
    assert.equal(sessions.of("switchModel").length, before);
    assert.equal(engine.status().fallbackSessions, 0);
  });

  it("does not treat its own switch as a manual override", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    // Simulate the event OpenCode publishes for the plugin's own switch.
    engine.onModelSelected({ sessionID: "ses_a", model: PAID, previous: FREE });
    assert.equal(engine.status().fallbackSessions, 1);
    assert.equal(engine.status().manualOverrides, 0);
    assert.equal(sessions.of("switchModel").length, 1);
  });

  it("keeps managing a fallback session when explicit selection is not respected", async () => {
    const { engine } = await boot({ config: { respectExplicitModelSelection: false } });
    engine.onModelSelected({ sessionID: "ses_a", model: PAID, previous: FREE });
    assert.equal(engine.status().fallbackSessions, 1);
  });

  it("re-enables management when the free model is selected again", async () => {
    const { engine, sessions, clock } = await boot();
    engine.onModelSelected({ sessionID: "ses_a", model: OTHER });
    assert.equal(engine.status().manualOverrides, 1);
    engine.onModelSelected({ sessionID: "ses_a", model: FREE, previous: OTHER });
    assert.equal(engine.status().manualOverrides, 0);
    engine.onModelRequest("ses_a", FREE, "primary");
    await failover(engine, "ses_a");
    assert.ok(sessions.of("switchModel").length >= 1);
    await clock.advance(1_500);
    assert.equal(engine.status().state, "FREE_HEALTHY");
  });
});

describe("park preemption", () => {
  it("reclaims a parked fallback request once free health is confirmed", async () => {
    const { engine, clock, sessions, log, generate } = await boot();
    // 1. The free model rate limits and the session fails over.
    await failover(engine, "ses_a");
    assert.equal(engine.status().state, "FREE_COOLDOWN");
    // 2. The session is executing and its fallback request is prepared but never
    //    dispatched: another plugin is holding it.
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    engine.onContext("ses_a", PAID);
    assert.equal(sessions.of("interrupt").length, 0, "not before free health is confirmed");
    // 3. The cooldown expires, the probe confirms the free model, and the parked
    //    paid continuation is reclaimed for the same session.
    await clock.advance(1_500);
    assert.equal(generate.calls.length, 1);
    const synthetic = sessions.of("synthetic");
    const interrupts = sessions.of("interrupt");
    assert.equal(synthetic.length, 1, "one invisible continuation was admitted");
    assert.equal(synthetic[0].sessionID, "ses_a");
    assert.equal(synthetic[0].delivery, "steer");
    assert.equal(synthetic[0].resume, true);
    assert.equal(interrupts.length, 1);
    assert.equal(interrupts[0].sessionID, "ses_a");
    assert.ok(log.has("parked fallback request detected"));
    assert.ok(log.has("stale fallback continuation neutralized"));
    assert.ok(log.has("duplicate continuation prevented"));
    assert.equal(engine.status().state, "FREE_HEALTHY");
  });

  it("does not preempt a fallback request that was dispatched", async () => {
    const { engine, clock, sessions } = await boot();
    await failover(engine, "ses_a");
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    engine.onContext("ses_a", PAID);
    engine.onModelRequest("ses_a", PAID, "primary");
    await clock.advance(10_000);
    assert.equal(sessions.of("interrupt").length, 0);
  });

  it("does not preempt while the session is idle", async () => {
    const { engine, clock, sessions } = await boot();
    await failover(engine, "ses_a");
    engine.onContext("ses_a", PAID);
    await clock.advance(10_000);
    assert.equal(sessions.of("interrupt").length, 0);
  });

  it("does not preempt while the free model is not confirmed healthy", async () => {
    const generate = new FakeGenerate();
    generate.error = rateLimitError();
    const { engine, clock, sessions } = await boot({ generate });
    await failover(engine, "ses_a");
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    engine.onContext("ses_a", PAID);
    await clock.advance(20_000);
    assert.equal(sessions.of("interrupt").length, 0);
  });

  it("does not preempt when the feature is disabled", async () => {
    const { engine, clock, sessions } = await boot({ config: { parkPreemption: false } });
    await failover(engine, "ses_a");
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    engine.onContext("ses_a", PAID);
    await clock.advance(20_000);
    assert.equal(sessions.of("interrupt").length, 0);
  });

  it("reports a settled park without inventing work", async () => {
    const sessions = new FakeSessions();
    sessions.interrupt = async ({ sessionID }) => {
      sessions.calls.push({ type: "interrupt", sessionID });
      return { interrupted: false };
    };
    const { engine, clock, log } = await boot({ sessions });
    await failover(engine, "ses_a");
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    engine.onContext("ses_a", PAID);
    await clock.advance(5_000);
    assert.ok(log.has("no active execution to preempt"), JSON.stringify(log.messages()));
    assert.equal(log.has("stale fallback continuation neutralized"), false);
  });
});

describe("persistence and restart", () => {
  it("restores a future cooldown across a restart", async () => {
    const storage = new FakeStorage();
    const first = await boot({ storage });
    await first.engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    await first.clock.advance(0);
    await first.engine.dispose();
    assert.ok(storage.plain()["opencode-free-first/health-v1"]);

    const clock = new FakeClock(first.clock.now() + 500);
    const second = await boot({ storage, clock, config: { probe: false } });
    assert.equal(second.engine.status().state, "FREE_COOLDOWN");
    assert.equal(second.engine.status().level, 1);
    assert.ok(second.log.has("restored free cooldown from persisted state"));
    assert.equal(second.generate.calls.length, 0, "a restart is not an immediate probe");
  });

  it("discards an expired cooldown on restart", async () => {
    const storage = new FakeStorage();
    const first = await boot({ storage });
    await first.engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    await first.clock.advance(0);
    await first.engine.dispose();

    const clock = new FakeClock(first.clock.now() + 3_600_000);
    const second = await boot({ storage, clock });
    assert.equal(second.engine.status().state, "FREE_HEALTHY");
    assert.equal(second.engine.status().cooldownMs, 0);
    assert.equal(second.engine.status().level, 1, "the ladder position survives");
    assert.equal(second.generate.calls.length, 0, "no probe is triggered by a restart");
    assert.ok(second.log.has("discarded expired free cooldown"));
  });

  it("starts healthy from corrupt persisted state", async () => {
    const storage = new FakeStorage({
      "opencode-free-first/health-v1": "not-an-object",
      "opencode-free-first/sessions-v1": { schemaVersion: 99 },
    });
    const { engine, log } = await boot({ storage });
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.ok(log.has("discarded incompatible persisted free state"));
  });

  it("persists the schema version and session routes", async () => {
    const storage = new FakeStorage();
    const { engine, clock } = await boot({ storage });
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    await clock.advance(0);
    const sessions = storage.plain()["opencode-free-first/sessions-v1"];
    assert.equal(sessions.schemaVersion, 1);
    assert.equal(sessions.sessions.ses_a.managed, true);
    assert.equal(sessions.sessions.ses_a.route, "FALLBACK");
  });

  it("does not act on a persisted hint before evidence arrives", async () => {
    const storage = new FakeStorage({
      "opencode-free-first/health-v1": {
        schemaVersion: 1,
        scope: "fake/fake-free",
        state: "FREE_HEALTHY",
        level: 0,
      },
      "opencode-free-first/sessions-v1": {
        schemaVersion: 1,
        sessions: { ses_old: { managed: true, route: "FALLBACK", updatedAt: 1 } },
      },
    });
    const { engine, clock, sessions } = await boot({
      storage,
      config: { probe: false, adoptFallbackSessions: false },
    });
    await clock.advance(60_000);
    assert.equal(sessions.of("switchModel").length, 0);
    assert.equal(engine.status().fallbackSessions, 1, "the hint is reported but not acted on");
  });

  it("survives a storage failure", async () => {
    const storage = new FakeStorage();
    storage.get = async () => {
      throw new Error("storage unavailable");
    };
    storage.set = async () => {
      throw new Error("storage unavailable");
    };
    const { engine } = await boot({ storage });
    assert.equal(engine.status().state, "FREE_HEALTHY");
    await engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    assert.equal(engine.status().state, "FREE_COOLDOWN");
  });
});

describe("lifecycle", () => {
  it("clears every timer on dispose", async () => {
    const { engine, clock } = await boot();
    await engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    assert.ok(clock.pendingTimers > 0);
    await engine.dispose();
    assert.equal(clock.pendingTimers, 0);
  });

  it("does nothing at all while disabled", async () => {
    const { engine, sessions, clock, generate } = await boot();
    engine.setEnabled(false);
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    await engine.onPrompt("ses_a");
    await clock.advance(10_000);
    assert.equal(sessions.of("switchModel").length, 0);
    assert.equal(generate.calls.length, 0);
    assert.equal(engine.statusLine(), "disabled");
  });

  it("reports a useful status line", async () => {
    const { engine, clock } = await boot();
    assert.match(engine.statusLine(), /^FREE \(fake\/fake-free\)$/);
    await engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError({
        response: { body: JSON.stringify({ reset_at: clock.now() + 480_000 }) },
      }),
      attempt: 2,
      decision: { retry: false },
    });
    assert.equal(engine.statusLine(), "FREE cooldown: 8m");
    clock.jump(480_001);
    assert.equal(engine.statusLine(), "probing FREE");
  });

  it("exposes diagnostics without prompts or credentials", async () => {
    const { engine } = await boot();
    const status = engine.status();
    assert.equal(status.primary, "fake/fake-free");
    assert.equal(status.fallback, "fake/fake-paid");
    assert.equal(status.enabled, true);
    assert.equal(status.cooldownScope, undefined);
    assert.ok(Array.isArray(status.transitions));
  });

  it("records model transitions for switch-churn assertions", async () => {
    const { engine, clock } = await boot();
    await engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    await clock.advance(1_500);
    const transitions = engine.status().transitions;
    assert.equal(transitions.length, 2);
    assert.match(transitions[0], /failover -> fake\/fake-paid$/);
    assert.match(transitions[1], /probe-recovery -> fake\/fake-free$/);
  });
});
