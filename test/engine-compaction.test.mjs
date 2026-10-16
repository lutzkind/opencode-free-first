/**
 * Compaction routing while a free-model cooldown is already known.
 *
 * OpenCode resolves a request's model at the step boundary, before any plugin
 * hook runs, and it issues an automatic compaction at that same boundary
 * (`SessionRunnerLLM.runStep`). A compaction attempt that was already prepared
 * cannot be re-routed either: OpenCode's compaction retry re-sends the request
 * it prepared, so a retried compaction attempt keeps its model. That is why a
 * known cooldown has to be reflected in the *session's* stored model before the
 * boundary, and why a compaction request must not be retried on a free model
 * that has just limited.
 *
 * Everything here runs against fakes: no provider traffic, deterministic clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FreeFirstEngine } from "../dist/engine.js";
import { engineOptions, FakeStorage, FREE, OTHER, PAID, rateLimitError } from "./fakes.mjs";

const HEALTH_KEY = "opencode-free-first/health-v1";
/** The deterministic clock every fixture boots with. */
const START = 1_700_000_000_000;

function healthDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    scope: `${FREE.providerID}/${FREE.id}`,
    state: "FREE_COOLDOWN",
    ...overrides,
  };
}

async function boot(overrides = {}) {
  const built = engineOptions(overrides);
  const engine = new FreeFirstEngine(built.options);
  await engine.start();
  await built.clock.flush();
  return { engine, ...built };
}

/** The retry hook, called the way the server hook does (the engine mutates the decision). */
async function retry(engine, input) {
  const live = { ...input };
  await engine.onRetry(live);
  return live.decision;
}

function failover(engine, sessionID, model = FREE) {
  return retry(engine, {
    sessionID,
    model,
    error: rateLimitError(),
    attempt: 2,
    decision: { retry: false },
  });
}

function switchesFor(sessions, sessionID) {
  return sessions.of("switchModel").filter((call) => call.sessionID === sessionID);
}

describe("known cooldown and compaction", () => {
  it("moves an executing session to its fallback when another session discovers the limit", async () => {
    const { engine, sessions, clock, log } = await boot();
    // Both sessions are mid-turn on the free model when the limit arrives. The
    // second one has no hook between its steps, so a step boundary could issue
    // an automatic compaction against the free model.
    engine.onExecution({ sessionID: "ses_running", phase: "started" });
    engine.onModelRequest("ses_running", FREE, "primary");
    engine.onModelRequest("ses_bad", FREE, "primary");

    await failover(engine, "ses_bad");

    // The session that hit the limit fails over...
    assert.equal(switchesFor(sessions, "ses_bad").at(-1).model.id, PAID.id);
    // ...and the executing turn does not stay represented on a model that is
    // known to be unavailable, where its next step boundary could compact.
    assert.equal(switchesFor(sessions, "ses_running").at(-1).model.id, PAID.id);
    assert.equal(engine.status().cooldownRouting?.runs, 1);
    assert.equal(engine.status().cooldownRouting?.routed, 1);
    assert.equal(log.has("cooldown-guard"), false, "the trigger is recorded on the transition");
    assert.equal(
      engine.status().transitions.filter((line) => line.includes("cooldown-guard")).length,
      1,
    );
    await clock.advance(1_000);
  });

  it("does not switch the same session twice while the cooldown lasts", async () => {
    const { engine, sessions, clock } = await boot();
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    engine.onModelRequest("ses_a", FREE, "primary");
    await failover(engine, "ses_a");
    const total = sessions.of("switchModel").length;
    const paid = sessions.of("switchModel").filter((call) => call.model.id === PAID.id).length;
    assert.equal(paid, 1);

    // Every later hook still runs the pass; nothing may move again.
    await engine.onContext("ses_a", PAID);
    await engine.onContext("ses_a", PAID);
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await clock.flush();

    assert.equal(
      sessions.of("switchModel").filter((call) => call.model.id === PAID.id).length,
      paid,
      "no duplicate switch and no duplicate model event",
    );
    assert.equal(sessions.of("switchModel").length, total);
  });

  it("does not churn an idle session that could not spend a request anyway", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_idle", FREE, "primary");
    engine.onModelRequest("ses_bad", FREE, "primary");
    await failover(engine, "ses_bad");
    assert.equal(
      switchesFor(sessions, "ses_idle").length,
      0,
      "an idle session cannot compact; prompt admission and preparation route it",
    );
  });

  it("leaves a session on another model alone", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_other", OTHER, "primary");
    engine.onModelRequest("ses_bad", FREE, "primary");
    await failover(engine, "ses_bad");
    assert.equal(switchesFor(sessions, "ses_other").length, 0);
    assert.equal(engine.status().manualOverrides, 0, "an unrelated model is not an override");
  });

  it("respects a manual override: an opted-out session keeps its model", async () => {
    const { engine, sessions } = await boot();
    engine.onExecution({ sessionID: "ses_user", phase: "started" });
    engine.onModelRequest("ses_user", FREE, "primary");
    // The user points the session at the paid route deliberately.
    engine.onModelSelected({ sessionID: "ses_user", model: PAID, previous: FREE });
    engine.onModelRequest("ses_user", PAID, "primary");
    const before = switchesFor(sessions, "ses_user").length;

    engine.onModelRequest("ses_bad", FREE, "primary");
    await failover(engine, "ses_bad");

    assert.equal(switchesFor(sessions, "ses_user").length, before, "free-first does not interfere");
    assert.equal(engine.status().manualOverrides, 1);
  });

  it("adopts a cooldown another instance recorded and routes this instance's sessions", async () => {
    const { engine, sessions, storage, log } = await boot();
    engine.onModelRequest("ses_stale", FREE, "primary");
    // Another instance of this plugin records the same provider window.
    await storage.set(HEALTH_KEY, {
      ...healthDocument({ level: 2, lastResetSource: "retry-after" }),
      cooldownUntil: START + 60_000,
      lastRateLimitAt: START - 1_000,
    });

    // The first hook of any kind adopts the shared cooldown...
    await engine.onPrompt("ses_stale");

    assert.equal(log.has("adopted a cooldown recorded by another free-first instance"), true);
    assert.equal(switchesFor(sessions, "ses_stale").at(-1).model.id, PAID.id);
    assert.equal(engine.status().state, "FREE_COOLDOWN");
  });

  it("adopts a shared cooldown at a request preparation too, not only at prompt admission", async () => {
    const { engine, sessions, storage } = await boot();
    // No prompt hook: this is a turn that is already running.
    engine.onExecution({ sessionID: "ses_running", phase: "started" });
    engine.onModelRequest("ses_running", FREE, "primary");
    await storage.set(HEALTH_KEY, {
      ...healthDocument({ level: 2, lastResetSource: "retry-after" }),
      cooldownUntil: START + 60_000,
      lastRateLimitAt: START - 1_000,
    });
    await engine.onContext("ses_running", FREE);
    // The preparation that discovers the shared cooldown is guarded immediately,
    // so this session moves through the context guard rather than the pass.
    assert.equal(engine.status().state, "FREE_COOLDOWN");
    assert.equal(switchesFor(sessions, "ses_running").at(-1).model.id, PAID.id);
    assert.equal(
      engine.status().transitions.some((line) => line.includes("context-guard")),
      true,
    );
  });

  it("does nothing with an expired cooldown and never resurrects it", async () => {
    const storage = new FakeStorage({
      [HEALTH_KEY]: {
        ...healthDocument({ level: 3, lastResetSource: "retry-after" }),
        cooldownUntil: START - 60_000,
        lastRateLimitAt: START - 120_000,
      },
    });
    const { engine, sessions, log } = await boot({ storage });
    engine.onModelRequest("ses_ok", FREE, "primary");
    await engine.onPrompt("ses_ok");
    assert.equal(switchesFor(sessions, "ses_ok").length, 0, "an elapsed cooldown forces nothing");
    assert.equal(log.has("discarded expired free cooldown from persisted state"), true);
    assert.equal(engine.status().state, "FREE_HEALTHY");
  });

  it("stops protecting once the cooldown is over", async () => {
    const { engine, sessions, clock } = await boot();
    engine.onExecution({ sessionID: "ses_b", phase: "started" });
    engine.onModelRequest("ses_a", FREE, "primary");
    engine.onModelRequest("ses_b", FREE, "primary");
    await failover(engine, "ses_a");
    const routed = engine.status().cooldownRouting?.routed;
    assert.equal(routed, 1);

    // The cooldown elapses and recovery returns the sessions to the free model.
    await clock.advance(2_000);
    await engine.onPrompt("ses_b");
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(
      switchesFor(sessions, "ses_b").at(-1).model.id,
      FREE.id,
      "recovery still owns the way back",
    );
  });
});

describe("compaction retry decisions", () => {
  it("does not retry a compaction on the free model that just limited", async () => {
    const { engine, sessions, log } = await boot();
    // The compaction request reached the provider: its kind is known.
    engine.onModelRequest("ses_a", FREE, "compaction");
    const decision = await retry(engine, {
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: true, delay: 1_000 },
    });

    // The compaction re-sends the model it resolved, so retrying it would only
    // spend more doomed free requests.
    assert.deepEqual(decision, { retry: false });
    // The session is still moved to the fallback, so its *next* compaction is
    // issued on the fallback route.
    assert.equal(switchesFor(sessions, "ses_a").at(-1).model.id, PAID.id);
    assert.equal(engine.status().compactionRetriesSuppressed, 1);
    assert.equal(log.has("compaction request is not retried on a just-limited free model"), true);
    assert.equal(
      engine.status().cooldownRouting?.runs,
      1,
      "the cooldown still routes every session",
    );
  });

  it("keeps the failover retry for a primary request", async () => {
    const { engine } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine, {
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    assert.deepEqual(decision, { retry: true, delay: 100 });
  });

  it("does not mistake a title request for a compaction", async () => {
    const { engine } = await boot();
    engine.onModelRequest("ses_a", FREE, "title");
    const decision = await retry(engine, {
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    assert.deepEqual(decision, { retry: true, delay: 100 });
  });

  it("ignores a stale compaction dispatch from another model", async () => {
    const { engine } = await boot();
    engine.onModelRequest("ses_a", PAID, "compaction");
    const decision = await retry(engine, {
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: false },
    });
    assert.deepEqual(decision, { retry: true, delay: 100 }, "the mark is not for this model");
  });

  it("still vetoes the retry for an opted-out session without touching its model", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_user", FREE, "primary");
    engine.onModelSelected({ sessionID: "ses_user", model: OTHER, previous: FREE });
    engine.onModelRequest("ses_user", FREE, "compaction");
    const before = switchesFor(sessions, "ses_user").length;
    const decision = await retry(engine, {
      sessionID: "ses_user",
      model: FREE,
      error: rateLimitError(),
      attempt: 2,
      decision: { retry: true, delay: 500 },
    });
    assert.deepEqual(decision, { retry: false }, "one doomed request is enough");
    assert.equal(switchesFor(sessions, "ses_user").length, before);
  });
});
