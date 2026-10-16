import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FreeFirstEngine } from "../dist/engine.js";
import {
  engineOptions,
  FakeGenerate,
  FakeSessions,
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

function retry(engine, sessionID, error = rateLimitError()) {
  const decision = { retry: false };
  return engine
    .onRetry({ sessionID, model: FREE, error, attempt: 2, decision })
    .then(() => decision);
}

describe("concurrency", () => {
  it("deduplicates simultaneous 429s from many sessions into one cooldown", async () => {
    const { engine } = await boot();
    const sessions = ["ses_1", "ses_2", "ses_3", "ses_4"];
    for (const sessionID of sessions) engine.onModelRequest(sessionID, FREE, "primary");
    await Promise.all(sessions.map((sessionID) => retry(engine, sessionID)));
    assert.equal(engine.status().level, 1, "the ladder advanced once");
    assert.equal(engine.status().fallbackSessions, 4);
  });

  it("runs at most one probe for a herd of sessions reaching cooldown expiry together", async () => {
    const generate = new FakeGenerate();
    let resolveProbe;
    generate.text = async (input) => {
      generate.calls.push(input);
      await new Promise((resolve) => {
        resolveProbe = resolve;
      });
      return { text: "pong" };
    };
    const { engine, clock, sessions } = await boot({ generate });
    const ids = ["ses_1", "ses_2", "ses_3"];
    for (const sessionID of ids) engine.onModelRequest(sessionID, FREE, "primary");
    for (const sessionID of ids) await retry(engine, sessionID);

    const advance = clock.advance(1_500);
    await clock.flush();
    assert.equal(generate.calls.length, 1, "exactly one probe is in flight");
    resolveProbe();
    await advance;
    assert.equal(generate.calls.length, 1, "the herd reused the single probe result");
    const freeSwitches = sessions.of("switchModel").filter((call) => call.model.id === FREE.id);
    assert.equal(freeSwitches.length, ids.length);
  });

  it("does not start a second probe when one fails", async () => {
    const generate = new FakeGenerate();
    generate.error = rateLimitError();
    const { engine, clock } = await boot({ generate });
    for (const sessionID of ["ses_1", "ses_2"]) {
      engine.onModelRequest(sessionID, FREE, "primary");
      await retry(engine, sessionID);
    }
    await clock.advance(1_500);
    assert.equal(generate.calls.length, 1);
    assert.equal(engine.status().level, 2, "one extension, not one per session");
  });

  it("keeps a productive fallback session running while another session probes", async () => {
    const { engine, clock, sessions } = await boot();
    engine.onModelRequest("ses_busy", FREE, "primary");
    await retry(engine, "ses_busy");
    engine.onModelRequest("ses_busy", PAID, "primary");
    await clock.advance(1_500);
    const switches = sessions
      .of("switchModel")
      .filter((call) => call.sessionID === "ses_busy" && call.model.id === FREE.id);
    assert.equal(switches.length, 1, "exactly one fallback -> free transition");
  });

  it("moves an executing session off the free model when another session discovers a limit", async () => {
    // The cooldown is a property of the provider account, not of one session. A
    // session that is mid-turn has no hook between its steps, and a step
    // boundary is where an automatic compaction resolves its model — so it is
    // moved to its fallback immediately. Idle sessions are left alone: their
    // next activity goes through prompt admission or a request preparation, and
    // both route them.
    const { engine, sessions } = await boot();
    engine.onExecution({ sessionID: "ses_ok", phase: "started" });
    engine.onModelRequest("ses_ok", FREE, "primary");
    engine.onModelRequest("ses_idle", FREE, "primary");
    engine.onModelRequest("ses_bad", FREE, "primary");
    await retry(engine, "ses_bad");
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.sessionID),
      ["ses_bad", "ses_ok"],
    );
    assert.equal(engine.status().cooldownRouting?.runs, 1);
    assert.equal(
      engine.status().cooldownRouting?.routed,
      1,
      "the failing session moved with the failover",
    );
  });

  it("resolves a bad in-flight request against a live execution", async () => {
    const { engine, clock } = await boot();
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, "ses_a");
    engine.onModelRequest("ses_a", PAID, "primary");
    engine.onExecution({ sessionID: "ses_a", phase: "settled", outcome: "succeeded" });
    await clock.advance(1_500);
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().fallbackSessions, 0);
  });

  it("ignores duplicate model-request observations", async () => {
    const { engine, sessions } = await boot();
    for (let index = 0; index < 5; index += 1) engine.onModelRequest("ses_a", FREE, "primary");
    assert.equal(sessions.of("switchModel").length, 0);
    assert.equal(engine.status().managedSessions, 1);
  });

  it("prunes the session map at the configured limit", async () => {
    const { engine } = await boot({ config: { sessionLimit: 3 } });
    for (let index = 0; index < 10; index += 1) {
      engine.onModelRequest(`ses_${index}`, FREE, "primary");
    }
    assert.equal(engine.status().managedSessions, 3);
  });

  it("survives a concurrent dispose", async () => {
    const { engine, clock } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await Promise.all([engine.dispose(), engine.dispose()]);
    await clock.advance(10);
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(clock.pendingTimers, 0);
  });
});

describe("explicit user model selection", () => {
  it("respects a manual switch to an unrelated model", async () => {
    const { engine, sessions, clock } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, "ses_a");
    engine.onModelSelected({ sessionID: "ses_a", model: OTHER, previous: PAID });
    await clock.advance(10_000);
    const targets = sessions.of("switchModel").map((call) => call.model.id);
    assert.deepEqual(targets, [PAID.id], "no transition was attempted after the override");
    assert.equal(engine.status().manualOverrides, 1);
  });

  it("respects a manual switch to the paid route", async () => {
    const { engine, sessions, clock } = await boot();
    engine.onModelSelected({ sessionID: "ses_a", model: PAID, previous: FREE });
    await clock.advance(10_000);
    assert.equal(sessions.of("switchModel").length, 0);
    assert.equal(engine.status().fallbackSessions, 0);
  });

  it("does not mistake its own transition for an override", async () => {
    const { engine, clock, generate } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, "ses_a");
    engine.onModelSelected({ sessionID: "ses_a", model: PAID, previous: FREE });
    await clock.advance(1_500);
    assert.equal(generate.calls.length, 1, "recovery still ran");
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().manualOverrides, 0);
  });

  it("ignores a stale switch confirmation outside the confirm window", async () => {
    const { engine, clock } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, "ses_a");
    clock.jump(60_000);
    engine.onModelSelected({ sessionID: "ses_a", model: PAID, previous: PAID });
    assert.equal(engine.status().manualOverrides, 1, "treated as a real selection");
  });
});

describe("failure safety", () => {
  it("survives an unexpected error from the session driver", async () => {
    const sessions = new FakeSessions();
    sessions.get = async () => {
      throw new Error("driver exploded");
    };
    const errors = [];
    const { engine } = await boot({ sessions, onError: (error) => errors.push(error) });
    await engine.onPrompt("ses_unknown");
    assert.equal(errors.length, 1);
    assert.equal(engine.status().state, "FREE_HEALTHY");
  });

  it("survives a probe that throws a non-provider error", async () => {
    const generate = new FakeGenerate();
    generate.error = new TypeError("boom");
    const { engine, clock } = await boot({ generate });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, "ses_a");
    await clock.advance(1_500);
    // Fail open: an unexplained probe failure is unknown, not a limit.
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().level, 1, "an inconclusive probe does not escalate");
    assert.ok(engine.status().probeBackoffUntil > clock.now());
  });

  it("never throws out of an observer", async () => {
    const { engine, clock } = await boot();
    await engine.onPrompt("ses_x");
    await engine.onContext("ses_x", OTHER);
    engine.onModelRequest("ses_x", OTHER);
    engine.onHttpResponse({ sessionID: "ses_x", model: OTHER, status: 500 });
    engine.onExecution({ sessionID: "ses_x", phase: "settled", outcome: "failed" });
    await clock.advance(1_000);
    assert.equal(engine.status().state, "FREE_HEALTHY");
  });

  it("keeps the timers clean through a full cycle", async () => {
    const { engine, clock } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, "ses_a");
    await clock.advance(1_500);
    // Only the write-behind flush may remain.
    assert.ok(clock.pendingTimers <= 1, `unexpected timers: ${clock.pendingTimers}`);
  });
});
