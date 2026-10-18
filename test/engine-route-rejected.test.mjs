/**
 * Free-route rejection coverage.
 *
 * The live incident this suite guards against (2026-10-17): several sessions
 * were genuinely running inside OpenCode, the free route started answering real
 * model requests with OpenCode's own free-tier eligibility gate
 * ("OpenCode's free tier can only be used from within OpenCode"), and every
 * session died because the plugin classified the refusal as a generic
 * authentication failure and left the turn to fail.
 *
 * The contract under test:
 *
 *   real free request
 *   -> exact recognised gate            = free-route unavailable (not a 429)
 *   -> the existing shared cooldown is armed with reason "free-route"
 *   -> managed sessions move to the configured fallback
 *   -> the failed turn retries once through normal OpenCode routing
 *   -> the session stays alive
 *   -> after the bounded retry window the existing recovery path tests FREE
 *   -> the session returns to the free model automatically
 *
 * A generic 401/403, an invalid key, or any other authentication failure must
 * stay visible and must never fail over.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FreeFirstEngine } from "../dist/engine.js";
import {
  authError,
  engineOptions,
  FakeGenerate,
  FakeSessions,
  FakeStorage,
  FREE,
  FREE_ROUTE_GATE_MESSAGE,
  freeRouteGateError,
  rateLimitError,
} from "./fakes.mjs";

const HOST_REFUSED_PROBE = {
  tag: "Generate.UnavailableError",
  message: FREE_ROUTE_GATE_MESSAGE,
};

async function boot(overrides = {}) {
  const built = engineOptions(overrides);
  const engine = new FreeFirstEngine(built.options);
  await engine.start();
  await built.clock.flush();
  return { engine, ...built };
}

/** Deliver the exact gate as a real model request's retry event. */
function gate(engine, sessionID = "ses_a", overrides = {}) {
  const decision = overrides.decision ?? { retry: false };
  const input = {
    sessionID,
    model: FREE,
    error: freeRouteGateError(),
    attempt: 2,
    decision,
    ...overrides,
  };
  return engine.onRetry(input).then(() => input.decision);
}

/** A genuine 429, for contrasts that must keep the old behaviour. */
function limit(engine, sessionID = "ses_a", error = rateLimitError()) {
  const input = { sessionID, model: FREE, error, attempt: 2, decision: { retry: false } };
  return engine.onRetry(input).then(() => input.decision);
}

function targets(sessions) {
  return sessions
    .of("switchModel")
    .map((call) => `${call.sessionID}:${call.model.providerID}/${call.model.id}`);
}

describe("real-session free-route rejection", () => {
  it("classifies the exact gate as a free-route cooldown and fails the same turn over", async () => {
    const { engine, clock, sessions, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await gate(engine);

    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.equal(engine.status().state, "FREE_COOLDOWN");
    assert.equal(engine.status().cooldownReason, "free-route");
    assert.equal(engine.status().routeRejectedAt, clock.now());
    assert.equal(engine.status().cooldownEndsAt, clock.now() + 3_000);
    assert.equal(engine.status().cooldownMs, 3_000);
    assert.equal(engine.status().fallbackSessions, 1);
    // A rejection is not a rate limit: no ladder move, no reset, no rate-limit
    // metadata, and it is never presented as a rate limit.
    assert.equal(engine.status().lastRateLimitAt, undefined);
    assert.equal(engine.status().lastRateLimitType, undefined);
    assert.equal(engine.status().lastResetSource, undefined);
    assert.equal(engine.status().level, 0);
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid"]);
    assert.ok(log.has("free route rejected"));
    assert.ok(log.has("fallback selected"));
    assert.equal(engine.statusLine(), "FREE unavailable: route rejected (retry in 3s)");
  });

  it("keeps the session alive: one model switch, no interrupt, no synthetic input", async () => {
    const { engine, sessions } = await boot();
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    engine.onModelRequest("ses_a", FREE, "primary");
    await gate(engine);
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid"]);
    assert.equal(sessions.of("synthetic").length, 0, "the turn was not restarted");
    assert.equal(sessions.of("interrupt").length, 0, "the session was not interrupted");
    for (const call of sessions.calls) assert.equal(call.sessionID, "ses_a");
  });

  it("does not fail over on a generic 403", async () => {
    const { engine, sessions, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await gate(engine, "ses_a", {
      error: { type: "provider.auth", status: 403, message: "Forbidden" },
    });
    assert.deepEqual(decision, { retry: false });
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().cooldownReason, undefined);
    assert.equal(sessions.of("switchModel").length, 0);
    assert.ok(log.has("provider failure is not a free-model availability failure"));
  });

  it("does not fail over on a 401 or an invalid API key", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const first = await gate(engine, "ses_a", { error: authError() });
    const second = await gate(engine, "ses_a", {
      error: {
        type: "provider.auth",
        status: 400,
        message: "Invalid API key provided",
      },
    });
    assert.deepEqual(first, { retry: false });
    assert.deepEqual(second, { retry: false });
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(sessions.of("switchModel").length, 0, "the auth failure stayed visible");
  });

  it("does not fail over on an unsupported provider or a malformed request", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await gate(engine, "ses_a", {
      error: { type: "provider.no-route", message: "unsupported provider configuration" },
    });
    await gate(engine, "ses_a", {
      error: { type: "provider.invalid-request", status: 400, message: "malformed request" },
    });
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(sessions.of("switchModel").length, 0);
  });

  it("keeps a genuine 429 on the rate-limit path, untouched", async () => {
    const { engine, clock, sessions, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await limit(engine);
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.equal(engine.status().state, "FREE_COOLDOWN");
    assert.equal(engine.status().cooldownReason, "rate-limit");
    assert.equal(engine.status().cooldownMs, 1_000);
    assert.equal(engine.status().routeRejectedAt, undefined);
    assert.equal(engine.status().level, 1);
    assert.ok(log.has("free rate limit detected"));
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid"]);

    await clock.advance(1_500);
    const transitions = engine.status().transitions;
    assert.equal(transitions.length, 2, "one limit cycle is still exactly two transitions");
    assert.match(transitions[0], /failover -> fake\/fake-paid$/);
    assert.match(transitions[1], /probe-recovery -> fake\/fake-free$/);
  });

  it("never lets a rejection shorten a live rate-limit cooldown", async () => {
    const { engine, clock } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await limit(engine, "ses_a", {
      ...rateLimitError(),
      response: { body: JSON.stringify({ retry_after: 30 }) },
    });
    assert.equal(engine.status().cooldownMs, 30_000);
    await gate(engine, "ses_a");
    assert.equal(engine.status().cooldownReason, "free-route");
    assert.equal(engine.status().cooldownMs, 30_000, "the longer deadline still governs");
    assert.equal(engine.status().lastRateLimitAt, clock.now(), "the genuine limit stays recorded");
  });

  it("suppresses the retry for a compaction that cannot change its model", async () => {
    const { engine, sessions, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "compaction");
    const decision = await gate(engine, "ses_a", { decision: { retry: true, delay: 1_000 } });
    assert.deepEqual(decision, { retry: false });
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid"]);
    assert.equal(engine.status().compactionRetriesSuppressed, 1);
    assert.ok(log.has("compaction request is not retried on a free route that just rejected it"));
  });

  it("surfaces the failure when there is no fallback to switch to", async () => {
    const sessions = new FakeSessions({ ses_a: FREE });
    const { engine, log } = await boot({ config: { fallback: undefined }, sessions });
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await gate(engine);
    assert.deepEqual(decision, { retry: false });
    assert.equal(sessions.of("switchModel").length, 0);
    assert.ok(log.has("no fallback model available"));
    assert.equal(
      engine.status().cooldownReason,
      "free-route",
      "the shared state is still learned for every other session",
    );
  });
});

describe("concurrent sessions and the shared rejection", () => {
  it("learns the rejection once and moves every executing session to the fallback", async () => {
    const { engine, sessions } = await boot();
    for (const sessionID of ["ses_1", "ses_2", "ses_3"]) {
      engine.onExecution({ sessionID, phase: "started" });
      engine.onModelRequest(sessionID, FREE, "primary");
    }
    const decision = await gate(engine, "ses_1");
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.deepEqual(
      targets(sessions),
      ["ses_1:fake/fake-paid", "ses_2:fake/fake-paid", "ses_3:fake/fake-paid"],
      "one discovery routed every session, with one switch each",
    );
    assert.equal(engine.status().fallbackSessions, 3);
    assert.equal(
      engine.status().transitions.length,
      3,
      "no session was switched twice and no extra attempt was made",
    );

    // A later prompt cannot spend another doomed free request either.
    const before = sessions.of("switchModel").length;
    await engine.onPrompt("ses_2");
    assert.equal(sessions.of("switchModel").length, before);
  });

  it("treats a second session's rejection as a duplicate of one episode", async () => {
    const { engine, clock, log } = await boot();
    engine.onModelRequest("ses_1", FREE, "primary");
    await gate(engine, "ses_1");
    const firstStart = engine.status().routeRejectedAt;
    const firstRetryAt = engine.status().cooldownEndsAt;
    clock.jump(1_000);

    engine.onModelRequest("ses_2", FREE, "primary");
    const decision = await gate(engine, "ses_2");
    // The second session was already in flight, so it fails over too — but the
    // episode is not restarted and the retry window is not extended, so the
    // shared state never becomes a schedule the provider did not give.
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.equal(engine.status().routeRejectedAt, firstStart);
    assert.equal(engine.status().cooldownEndsAt, firstRetryAt);
    assert.equal(log.lastDetailFor("free route rejected").duplicate, true);
  });

  it("only the first rejection spends a doomed free request", async () => {
    // Three sessions are already executing; the shared state learns the
    // rejection from the first one, and the other two are moved before their
    // next request resolves a model.
    const { engine, sessions, clock, log } = await boot();
    for (const sessionID of ["ses_1", "ses_2", "ses_3"]) {
      engine.onExecution({ sessionID, phase: "started" });
      engine.onModelRequest(sessionID, FREE, "primary");
    }
    await gate(engine, "ses_1");
    const switches = sessions.of("switchModel").length;
    assert.equal(switches, 3, "one switch per session, none repeated");
    clock.jump(1_000);
    await engine.onPrompt("ses_2");
    await engine.onPrompt("ses_3");
    assert.equal(sessions.of("switchModel").length, switches, "no additional switches");
    assert.equal(
      sessions.of("switchModel").filter((call) => call.model.id === FREE.id).length,
      0,
      "no session was ever moved back to a rejected free route",
    );
    assert.equal(log.lines.filter((line) => line.message === "free route rejected").length, 1);
    assert.equal(engine.status().fallbackSessions, 3);
  });

  it("routes a new session to the fallback without touching the free route", async () => {
    const { engine, sessions, generate } = await boot();
    engine.onModelRequest("ses_1", FREE, "primary");
    await gate(engine, "ses_1");
    const before = sessions.of("switchModel").length;
    await engine.onPrompt("ses_new");
    assert.deepEqual(targets(sessions).slice(before), ["ses_new:fake/fake-paid"]);
    assert.equal(generate.calls.length, 0, "no probe was spent on the new session");
  });

  it("does not repeat rejected free calls while the shared state holds", async () => {
    const { engine, clock, generate, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await gate(engine);
    const before = sessions.of("switchModel").length;
    for (let index = 0; index < 10; index += 1) {
      await engine.onPrompt(`ses_${index}`);
      await clock.advance(100);
    }
    assert.equal(sessions.of("switchModel").length, before + 10, "each new session moved once");
    assert.equal(generate.calls.length, 0, "no probe inside the window");
    assert.equal(engine.status().cooldownReason, "free-route");
  });
});

describe("recovery from a free-route rejection", () => {
  it("probes once after the retry window and returns the session to the free model", async () => {
    const { engine, clock, generate, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await gate(engine);
    assert.equal(generate.calls.length, 0, "no probe while the retry window is open");

    await clock.advance(3_001);
    assert.equal(generate.calls.length, 1, "exactly one conservative test");
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().cooldownReason, undefined, "the block left the record");
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid", "ses_a:fake/fake-free"]);
    assert.match(engine.status().transitions[0], /route-reject-failover -> fake\/fake-paid$/);
    assert.match(engine.status().transitions[1], /probe-recovery -> fake\/fake-free$/);
    assert.equal(engine.statusLine(), "FREE (fake/fake-free)");
  });

  it("falls back to passive recovery when probing is disabled", async () => {
    const { engine, clock, generate, sessions } = await boot({ config: { probe: false } });
    engine.onModelRequest("ses_a", FREE, "primary");
    await gate(engine);
    await clock.advance(3_001);
    assert.equal(generate.calls.length, 0);
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid", "ses_a:fake/fake-free"]);
    assert.match(engine.status().transitions[1], /passive-recovery -> fake\/fake-free$/);
  });

  it("returns to free, and a later rejection cycle costs exactly two transitions", async () => {
    const { engine, clock, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await gate(engine);
    await clock.advance(3_001);
    assert.equal(engine.status().transitions.length, 2);
    assert.equal(engine.status().fallbackSessions, 0);

    engine.onModelRequest("ses_a", FREE, "primary");
    await gate(engine, "ses_a");
    await clock.advance(3_001);
    assert.equal(engine.status().transitions.length, 4, "two transitions per refusal cycle");
    assert.deepEqual(targets(sessions), [
      "ses_a:fake/fake-paid",
      "ses_a:fake/fake-free",
      "ses_a:fake/fake-paid",
      "ses_a:fake/fake-free",
    ]);
  });

  it("recovers passively when the host refuses the probe path", async () => {
    const generate = new FakeGenerate();
    generate.error = HOST_REFUSED_PROBE;
    const { engine, clock, sessions, log } = await boot({ generate });
    engine.onModelRequest("ses_a", FREE, "primary");
    await gate(engine);
    await clock.advance(3_001);
    assert.equal(generate.calls.length, 1, "one honest attempt, not a loop");
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.match(engine.status().lastProbeOutcome, /^unsupported:/);
    assert.ok(log.has("the recovery probe is not permitted for this model"));
    assert.equal(engine.status().fallbackSessions, 0, "the session still came back to free");

    // The refused probe backs off hard (the existing fix), so the next cycle
    // does not retry it inside the window and recovery stays passive.
    engine.onModelRequest("ses_b", FREE, "primary");
    await gate(engine, "ses_b");
    await clock.advance(3_001);
    assert.equal(generate.calls.length, 1, "the refused probe is not retried inside its back-off");
    assert.ok(engine.status().probeBackoffUntil > clock.now());
    assert.equal(engine.status().fallbackSessions, 0, "passive recovery still works");
    assert.deepEqual(
      sessions.of("switchModel").map((call) => call.model.id),
      ["fake-paid", "fake-free", "fake-paid", "fake-free"],
    );
  });

  it("treats a probe refusal as probe-path-unsupported, never as a route rejection", async () => {
    const generate = new FakeGenerate();
    generate.error = HOST_REFUSED_PROBE;
    const { engine, clock, log } = await boot({ generate });
    engine.onModelRequest("ses_a", FREE, "primary");
    await limit(engine);
    await clock.advance(1_500);
    assert.equal(engine.status().state, "FREE_HEALTHY", "fail open, never blocked");
    assert.equal(engine.status().cooldownReason, undefined);
    assert.equal(engine.status().routeRejectedAt, undefined);
    assert.match(engine.status().lastProbeOutcome, /^unsupported:/);
    assert.equal(log.has("free route rejected"), false);
  });

  it("a refused probe path does not suppress a real session rejection", async () => {
    const generate = new FakeGenerate();
    generate.error = HOST_REFUSED_PROBE;
    const { engine, clock } = await boot({ generate });
    // Establish the unsupported probe verdict with a genuine 429 cycle.
    engine.onModelRequest("ses_a", FREE, "primary");
    await limit(engine);
    await clock.advance(1_500);
    assert.match(engine.status().lastProbeOutcome, /^unsupported:/);
    assert.equal(engine.status().state, "FREE_HEALTHY");

    // Now a real model request hits the gate: it must still fail over.
    engine.onModelRequest("ses_b", FREE, "primary");
    const decision = await gate(engine, "ses_b");
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.equal(engine.status().cooldownReason, "free-route");
    assert.equal(engine.status().fallbackSessions, 1);
    assert.equal(generate.calls.length, 1, "the gate did not trigger another probe");
  });

  it("keeps the share of recovery work bounded when several sessions wait", async () => {
    const { engine, clock, generate, sessions } = await boot();
    for (const sessionID of ["ses_1", "ses_2", "ses_3"]) {
      engine.onModelRequest(sessionID, FREE, "primary");
      await gate(engine, sessionID);
    }
    await clock.advance(3_001);
    assert.equal(generate.calls.length, 1, "one probe decides for every waiting session");
    assert.equal(engine.status().fallbackSessions, 0);
    const freeSwitches = sessions.of("switchModel").filter((call) => call.model.id === FREE.id);
    assert.equal(freeSwitches.length, 3, "each session returned exactly once");
  });
});

describe("restart and cross-instance behaviour", () => {
  it("persists the free-route cooldown and restores it across a restart", async () => {
    const storage = new FakeStorage();
    const first = await boot({ storage });
    first.engine.onModelRequest("ses_a", FREE, "primary");
    await gate(first.engine);
    await first.clock.advance(0);
    const stored = storage.plain()["opencode-free-first/health-v1"];
    assert.equal(stored.state, "FREE_COOLDOWN");
    assert.equal(stored.cooldownReason, "free-route");
    assert.equal(stored.routeRejectedAt, first.clock.now());

    const second = await boot({ storage, clock: first.clock });
    assert.equal(second.engine.status().cooldownReason, "free-route");
    assert.equal(second.engine.status().state, "FREE_COOLDOWN");
  });

  it("does not re-probe a refused probe path before its back-off elapses after a restart", async () => {
    const storage = new FakeStorage();
    const generate = new FakeGenerate();
    generate.error = HOST_REFUSED_PROBE;
    const first = await boot({ storage, generate });
    first.engine.onModelRequest("ses_a", FREE, "primary");
    await limit(first.engine);
    await first.clock.advance(1_500);
    assert.equal(generate.calls.length, 1);
    const backoff = first.engine.status().probeBackoffUntil;
    assert.ok(backoff > first.clock.now());
    await first.engine.dispose();
    await first.clock.flush();

    const second = await boot({ storage, generate, clock: first.clock });
    assert.equal(second.engine.status().probeBackoffUntil, backoff, "the shared back-off survives");
    second.engine.onModelRequest("ses_b", FREE, "primary");
    await limit(second.engine, "ses_b");
    await second.clock.advance(2_000);
    assert.equal(generate.calls.length, 1, "the shared back-off prevented a second probe");
  });

  it("adopts a rejection recorded by another instance before its own decision", async () => {
    const storage = new FakeStorage();
    const first = await boot({ storage });
    first.engine.onModelRequest("ses_a", FREE, "primary");
    await gate(first.engine);
    await first.clock.advance(0);

    const second = await boot({ storage, clock: first.clock });
    assert.equal(second.engine.status().cooldownReason, "free-route");
    const before = second.sessions.of("switchModel").length;
    await second.engine.onPrompt("ses_new");
    assert.equal(
      second.sessions.of("switchModel").length,
      before + 1,
      "the new session was routed from the shared state, not from the free route",
    );
  });

  it("lets an operator reset clear a free-route cooldown", async () => {
    const { engine } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await gate(engine);
    assert.equal(engine.status().cooldownReason, "free-route");
    engine.markHealthy("rpc-reset");
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().cooldownMs, 0);
  });
});
