/**
 * Transient free-route availability coverage.
 *
 * The live incident this suite guards against (2026-10-18): the free route
 * answered a real model request with `AI.Error.ProviderInternal` ("Provider
 * request failed with HTTP 500") and the session's turn died, even though the
 * configured fallback was available. The superseded policy failed over only on
 * a rate limit or the free-tier gate, so every provider-side transient failure
 * surfaced as a dead turn.
 *
 * The contract under test:
 *
 *   free request
 *   -> transient availability failure (5xx / structured provider-internal /
 *      structured timeout / qualifying transport failure)
 *   -> the existing shared cooldown is armed with reason
 *      "transient-availability" on its own bounded ladder
 *   -> managed sessions move to the configured fallback
 *   -> the failed turn retries once through normal OpenCode routing
 *   -> the session stays alive, with one prompt and no replayed tool calls
 *   -> after the bounded window the existing recovery path tests FREE
 *   -> the session returns to the free model automatically
 *
 * A request, account, configuration, or plugin defect keeps its real failure
 * type and never fails over. A provider 500 is never recorded as, or presented
 * as, a quota event.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FreeFirstEngine } from "../dist/engine.js";
import {
  authError,
  engineOptions,
  FakeClock,
  FakeGenerate,
  FakePaidHolds,
  FakeSessions,
  FakeStorage,
  FREE,
  OTHER,
  PAID,
} from "./fakes.mjs";

/** The exact shape OpenCode 2.0.30 produces for a provider HTTP failure. */
const internal = (status) => ({
  type: "provider.internal",
  status,
  message: `Provider request failed with HTTP ${status}`,
});

async function boot(overrides = {}) {
  const built = engineOptions(overrides);
  const engine = new FreeFirstEngine(built.options);
  await engine.start();
  await built.clock.flush();
  return { engine, ...built };
}

/** Deliver a failure as a real model request's retry event. */
function retry(engine, sessionID = "ses_a", error = internal(500), overrides = {}) {
  const decision = overrides.decision ?? { retry: false };
  const input = {
    sessionID,
    model: FREE,
    error,
    attempt: 2,
    decision,
    ...overrides,
  };
  return engine.onRetry(input).then(() => input.decision);
}

const targets = (sessions) =>
  sessions
    .of("switchModel")
    .map((call) => `${call.sessionID}:${call.model.providerID}/${call.model.id}`);

describe("transient availability failover", () => {
  it("fails the same turn over for every provider/server 5xx status", async () => {
    for (const status of [500, 502, 503, 504]) {
      const { engine, sessions, log } = await boot();
      engine.onModelRequest("ses_a", FREE, "primary");
      const decision = await retry(engine, "ses_a", internal(status));

      assert.deepEqual(decision, { retry: true, delay: 100 }, `status ${status}`);
      assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid"], `status ${status}`);
      assert.equal(engine.status().state, "FREE_COOLDOWN", `status ${status}`);
      assert.equal(engine.status().cooldownReason, "transient-availability", `status ${status}`);
      assert.equal(engine.status().cooldownMs, 1_000, `status ${status}: first ladder rung`);
      assert.equal(engine.status().transientFailures, 1, `status ${status}`);
      assert.equal(
        engine.status().lastTransientType,
        `failover-http-${status}`,
        `status ${status}`,
      );
      assert.equal(engine.status().lastRateLimitAt, undefined, `status ${status}: not a 429`);
      assert.equal(
        engine.status().level,
        0,
        `status ${status}: the rate-limit ladder is untouched`,
      );
      assert.equal(
        engine.statusLine(),
        "FREE unavailable: transient provider failure (retry in 1s)",
      );
      assert.ok(log.has("free route transient failure detected"), `status ${status}`);
      assert.ok(log.has("fallback selected"), `status ${status}`);
      assert.match(engine.status().transitions[0], /availability-failover -> fake\/fake-paid$/);
    }
  });

  it("classifies a raw 5xx status even without a structured type", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine, "ses_a", { status: 503, message: "upstream unavailable" });
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid"]);
    assert.equal(engine.status().lastTransientType, "failover-http-503");
  });

  it("fails over on OpenCode's structured provider-internal and timeout types", async () => {
    const cases = [
      {
        error: {
          type: "provider.internal",
          message: "Provider reported a network error (finish_reason: network_error)",
        },
        classification: "failover-structured-provider-internal",
      },
      {
        error: { type: "provider.timeout", message: "Timed out waiting for response headers" },
        classification: "failover-structured-timeout",
      },
    ];
    for (const { error, classification } of cases) {
      const { engine, sessions } = await boot();
      engine.onModelRequest("ses_a", FREE, "primary");
      const decision = await retry(engine, "ses_a", error);
      assert.deepEqual(decision, { retry: true, delay: 100 }, classification);
      assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid"], classification);
      assert.equal(engine.status().lastTransientType, classification);
      assert.equal(engine.status().cooldownReason, "transient-availability", classification);
    }
  });

  it("fails over on qualifying transient transport failures", async () => {
    const messages = [
      { message: "ECONNRESET: socket hang up", classification: "failover-transport-econnreset" },
      { message: "fetch failed", classification: "failover-transport-fetch-failed" },
      {
        message: "UND_ERR_SOCKET: other side closed",
        classification: "failover-transport-und_err_socket",
      },
      {
        message: "ConnectionRefused: Unable to connect",
        classification: "failover-transport-connectionrefused",
      },
      { message: "the request timed out", classification: "failover-transport-timeout" },
    ];
    for (const { message, classification } of messages) {
      const { engine, sessions } = await boot();
      engine.onModelRequest("ses_a", FREE, "primary");
      const decision = await retry(engine, "ses_a", { type: "provider.transport", message });
      assert.deepEqual(decision, { retry: true, delay: 100 }, message);
      assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid"], message);
      assert.equal(engine.status().lastTransientType, classification, message);
    }
  });

  it("keeps the same session and turn: one switch, no interrupt, no synthetic input", async () => {
    const { engine, sessions } = await boot();
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine);
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid"]);
    assert.equal(sessions.of("synthetic").length, 0, "the prompt was not re-sent");
    assert.equal(sessions.of("interrupt").length, 0, "the session was not interrupted");
    for (const call of sessions.calls) assert.equal(call.sessionID, "ses_a");
    assert.equal(engine.status().fallbackSessions, 1);
  });
});

describe("must not fail over", () => {
  const visible = [
    {
      label: "a 400 invalid request",
      error: { type: "provider.invalid-request", status: 400, message: "bad request" },
    },
    {
      label: "a 401 authentication failure",
      error: authError(),
    },
    {
      label: "a generic 403",
      error: { type: "provider.auth", status: 403, message: "Forbidden" },
    },
    {
      label: "an invalid credential",
      error: { type: "provider.auth", status: 400, message: "Invalid API key provided" },
    },
    {
      label: "an invalid model or configuration",
      error: { type: "provider.no-route", message: "unsupported provider configuration" },
    },
    {
      label: "a content filter",
      error: { type: "provider.content-filter", message: "content policy violation" },
    },
    {
      label: "a context-length error",
      error: {
        type: "provider.invalid-request",
        status: 400,
        message: "maximum context length exceeded",
      },
    },
    {
      label: "a tool failure",
      error: { type: "tool.execution", message: "tool failed" },
    },
    {
      label: "a plugin bug",
      error: { type: "unknown", message: "TypeError: x is not a function" },
    },
    {
      label: "an unsupported operation",
      error: { type: "provider.unsupported-operation", message: "unsupported operation" },
    },
    {
      label: "an unclassified structured failure",
      error: { type: "provider.unknown", message: "the provider returned an odd shape" },
    },
    {
      label: "an unqualified transport failure",
      error: { type: "provider.transport", message: "invalid URL" },
    },
    {
      label: "an invalid provider output",
      error: { type: "provider.invalid-output", message: "incomplete stream" },
    },
    {
      label: "an error without any signal",
      error: {},
    },
  ];
  for (const { label, error } of visible) {
    it(`keeps ${label} visible`, async () => {
      const { engine, sessions } = await boot();
      engine.onModelRequest("ses_a", FREE, "primary");
      const decision = await retry(engine, "ses_a", error);
      assert.deepEqual(decision, { retry: false }, label);
      assert.equal(sessions.of("switchModel").length, 0, label);
      assert.equal(engine.status().state, "FREE_HEALTHY", label);
      assert.equal(engine.status().cooldownReason, undefined, label);
      assert.equal(engine.status().transientFailures, undefined, label);
    });
  }

  it("lets a structured type win over a 5xx-looking status", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine, "ses_a", {
      type: "provider.invalid-request",
      status: 500,
      message: "upstream returned 500",
    });
    assert.deepEqual(decision, { retry: false });
    assert.equal(sessions.of("switchModel").length, 0);
  });

  it("never classifies a quota exhaustion as a transient failure", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine, "ses_a", {
      type: "provider.quota",
      status: 429,
      message: "quota exceeded",
    });
    // It is a rate limit, so it fails over — through the rate-limit path only.
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.equal(engine.status().cooldownReason, "rate-limit");
    assert.equal(engine.status().transientFailures, undefined);
    assert.equal(sessions.of("switchModel").length, 1);
  });
});

describe("cooldown bookkeeping", () => {
  it("keeps the transient ladder separate from the rate-limit ladder", async () => {
    const { engine, clock, generate } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    assert.equal(engine.status().transientFailures, 1);
    assert.equal(engine.status().level, 0);
    assert.equal(engine.status().lastRateLimitAt, undefined);

    // Recover, then a genuine 429: only the rate-limit ladder moves.
    await clock.advance(1_001);
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(generate.calls.length, 1);
    assert.equal(engine.status().transientFailures, 0, "a confirmed success resets the ladder");

    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, "ses_a", { type: "provider.rate-limit", status: 429, message: "429" });
    assert.equal(engine.status().cooldownReason, "rate-limit");
    assert.equal(engine.status().level, 1);
    assert.equal(
      engine.status().transientFailures,
      0,
      "the 429 did not touch the transient ladder",
    );
    assert.equal(
      engine.status().lastTransientType,
      "failover-http-500",
      "the outage stays visible as history, never as rate-limit metadata",
    );
  });

  it("does not advance the transient ladder twice for one provider incident", async () => {
    const { engine, clock, log } = await boot();
    engine.onModelRequest("ses_1", FREE, "primary");
    await retry(engine, "ses_1");
    engine.onModelRequest("ses_2", FREE, "primary");
    const decision = await retry(engine, "ses_2");
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.equal(engine.status().transientFailures, 1, "one incident, one ladder step");
    assert.equal(engine.status().cooldownMs, 1_000, "the window was not extended");
    assert.equal(log.lastDetailFor("free route transient failure detected").duplicate, true);
    void clock;
  });

  it("escalates the bounded ladder across repeated incidents and clamps at the maximum", async () => {
    const { engine, clock } = await boot({ config: { probe: false } });
    const observed = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      engine.onModelRequest("ses_a", FREE, "primary");
      await retry(engine);
      observed.push(engine.status().cooldownMs);
      await clock.advance(6_000);
      assert.equal(engine.status().cooldownMs, 0, `cycle ${cycle}: the window elapsed`);
    }
    assert.deepEqual(observed, [1_000, 2_000, 5_000, 5_000]);
    assert.equal(engine.status().transientFailures, 3, "clamped at the ladder length");
  });

  it("never shortens or relabels a live rate-limit cooldown", async () => {
    const { engine } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    engine.onHttpHeaders("ses_a", { "retry-after": "30" });
    await retry(engine, "ses_a", { type: "provider.rate-limit", status: 429, message: "429" });
    assert.equal(engine.status().cooldownMs, 30_000);

    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, "ses_a", internal(500));
    assert.equal(engine.status().cooldownMs, 30_000, "the longer deadline still governs");
    assert.equal(
      engine.status().cooldownReason,
      "rate-limit",
      "the cause that owns the deadline keeps the label",
    );
    assert.equal(engine.status().lastRateLimitAt !== undefined, true, "the limit stays recorded");
    assert.equal(engine.status().transientFailures, 1, "the outage is still recorded separately");
    assert.equal(engine.status().lastTransientType, "failover-http-500");
  });

  it("does not shorten a live transient cooldown with a later free-route refusal", async () => {
    const { engine } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine); // 1s transient window
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, "ses_a", {
      type: "provider.auth",
      status: 403,
      message:
        "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
    });
    assert.equal(engine.status().cooldownMs, 3_000, "the refusal armed its own bounded window");
    assert.equal(engine.status().cooldownReason, "free-route");
    assert.equal(engine.status().transientFailures, 1, "the transient history is untouched");
  });
});

describe("compaction", () => {
  it("suppresses the retry for a compaction that cannot change its model", async () => {
    const { engine, sessions, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "compaction");
    const decision = await retry(engine, "ses_a", internal(500), {
      decision: { retry: true, delay: 1_000 },
    });
    assert.deepEqual(decision, { retry: false });
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid"]);
    assert.equal(engine.status().compactionRetriesSuppressed, 1);
    assert.ok(log.has("compaction request is not retried on a transiently unavailable free model"));
  });
});

describe("sessions that must not move", () => {
  it("surfaces the failure when there is no fallback, but records the shared outage", async () => {
    const sessions = new FakeSessions({ ses_a: FREE });
    const { engine, log } = await boot({ config: { fallback: undefined }, sessions });
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine);
    assert.deepEqual(decision, { retry: false });
    assert.equal(sessions.of("switchModel").length, 0);
    assert.ok(log.has("no fallback model available"));
    assert.equal(
      engine.status().cooldownReason,
      "transient-availability",
      "every other session still routes from the shared state",
    );
  });

  it("records the outage but never moves a session the user repointed", async () => {
    const sessions = new FakeSessions({ ses_a: OTHER });
    const { engine } = await boot({ sessions });
    engine.onModelSelected({ sessionID: "ses_a", model: OTHER });
    engine.onModelRequest("ses_a", OTHER, "primary");
    const decision = await retry(engine);
    assert.deepEqual(decision, { retry: false });
    assert.equal(sessions.of("switchModel").length, 0);
    assert.equal(engine.status().cooldownReason, "transient-availability");
    assert.equal(engine.status().fallbackSessions, 0);
  });

  it("respects a manual model change made during the transient cooldown", async () => {
    const { engine, clock, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    engine.onModelSelected({ sessionID: "ses_a", model: OTHER, previous: PAID });
    const before = sessions.of("switchModel").length;
    await engine.onPrompt("ses_a");
    await clock.advance(10_000);
    assert.equal(sessions.of("switchModel").length, before);
    assert.equal(engine.status().fallbackSessions, 0);
    assert.equal(engine.status().manualOverrides, 1);
  });
});

describe("recovery from a transient outage", () => {
  it("probes once after the window and returns the session to the free model", async () => {
    const { engine, clock, generate, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    assert.equal(generate.calls.length, 0, "no probe while the window is open");

    await clock.advance(1_001);
    assert.equal(generate.calls.length, 1, "exactly one conservative test");
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().cooldownReason, undefined, "the block left the record");
    assert.equal(engine.status().transientFailures, 0);
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid", "ses_a:fake/fake-free"]);
    assert.match(engine.status().transitions[0], /availability-failover -> fake\/fake-paid$/);
    assert.match(engine.status().transitions[1], /probe-recovery -> fake\/fake-free$/);
    assert.equal(engine.statusLine(), "FREE (fake/fake-free)");
  });

  it("keeps the fallback and re-arms a longer window when the probe still fails transiently", async () => {
    const generate = new FakeGenerate();
    generate.error = internal(503);
    const { engine, clock, sessions, log } = await boot({ generate });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);

    await clock.advance(1_001);
    assert.equal(generate.calls.length, 1);
    assert.equal(engine.status().state, "FREE_COOLDOWN", "the session stays on the fallback");
    assert.equal(engine.status().fallbackSessions, 1, "nothing moved mid-outage");
    assert.equal(engine.status().cooldownReason, "transient-availability");
    assert.equal(engine.status().cooldownMs, 2_000, "the window escalated");
    assert.equal(engine.status().transientFailures, 2);
    assert.equal(engine.status().lastTransientType, "probe-http-503");
    assert.equal(engine.status().lastRateLimitAt, undefined, "still not a quota event");
    assert.ok(log.has("recovery probe hit a transient availability failure"));

    // Repeated outages keep escalating, bounded, without switching anything.
    await clock.advance(2_001);
    assert.equal(generate.calls.length, 2);
    assert.equal(engine.status().cooldownMs, 5_000, "bounded at the ladder maximum");
    await clock.advance(5_001);
    assert.equal(generate.calls.length, 3);
    assert.equal(engine.status().cooldownMs, 5_000);
    assert.equal(engine.status().transientFailures, 3);
    assert.deepEqual(
      targets(sessions),
      ["ses_a:fake/fake-paid"],
      "one switch for the whole outage",
    );

    // The route comes back: the existing recovery path reclaims the session.
    generate.error = undefined;
    await clock.advance(5_001);
    assert.equal(generate.calls.length, 4);
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.equal(engine.status().fallbackSessions, 0);
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid", "ses_a:fake/fake-free"]);
  });

  it("a successful recovery clears the transient state for the next isolated failure", async () => {
    const { engine, clock } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    await clock.advance(1_001);
    assert.equal(engine.status().transientFailures, 0);

    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    assert.equal(engine.status().cooldownMs, 1_000, "the first rung applies again");
    assert.equal(engine.status().transientFailures, 1);
  });

  it("recovers passively when probing is disabled", async () => {
    const { engine, clock, generate, sessions } = await boot({ config: { probe: false } });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    await clock.advance(1_001);
    assert.equal(generate.calls.length, 0);
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid", "ses_a:fake/fake-free"]);
    assert.match(engine.status().transitions[1], /passive-recovery -> fake\/fake-free$/);
  });

  it("keeps the host-refused probe path passive, never blocking FREE", async () => {
    const generate = new FakeGenerate();
    generate.error = {
      tag: "Generate.UnavailableError",
      message:
        "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
    };
    const { engine, clock, sessions } = await boot({ generate });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    await clock.advance(1_001);
    assert.equal(generate.calls.length, 1, "one honest attempt, then the passive path");
    assert.equal(engine.status().state, "FREE_HEALTHY");
    assert.match(engine.status().lastProbeOutcome, /^unsupported:/);
    assert.equal(engine.status().fallbackSessions, 0, "the session still returned to free");
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid", "ses_a:fake/fake-free"]);
  });

  it("reclaims held paid work after a transient failover, without interrupting the session", async () => {
    const paidHolds = new FakePaidHolds();
    const { engine, clock, sessions, log } = await boot({ paidHolds });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    // Another plugin holds the fallback request: prepared, never dispatched.
    engine.onExecution({ sessionID: "ses_a", phase: "started" });
    engine.onContext("ses_a", PAID);

    await clock.advance(1_001);
    assert.equal(log.has("parked fallback request detected"), true);
    assert.equal(paidHolds.requests.length, 1, "the neighbour was asked to cancel the hold");
    assert.equal(sessions.of("interrupt").length, 0, "no session interruption");

    // The cancelled attempt returns as a refused transport failure and resumes
    // on the free model inside the same execution.
    const decision = await retry(
      engine,
      "ses_a",
      {
        type: "provider.transport",
        message: "ConnectionRefused: Unable to connect. Is the computer able to access the url?",
      },
      { model: PAID, attempt: 3, decision: { retry: true, delay: 4_229 } },
    );
    assert.deepEqual(decision, { retry: true, delay: 100 });
    assert.equal(engine.status().fallbackSessions, 0);
    assert.deepEqual(targets(sessions), ["ses_a:fake/fake-paid", "ses_a:fake/fake-free"]);
  });
});

describe("persistence and cross-instance behaviour", () => {
  it("persists the transient cooldown and restores it across a restart", async () => {
    const storage = new FakeStorage();
    const first = await boot({ storage });
    first.engine.onModelRequest("ses_a", FREE, "primary");
    await retry(first.engine);
    await first.clock.advance(0);
    const stored = storage.plain()["opencode-free-first/health-v1"];
    assert.equal(stored.state, "FREE_COOLDOWN");
    assert.equal(stored.cooldownReason, "transient-availability");
    assert.equal(stored.transientFailures, 1);
    assert.equal(stored.lastRateLimitAt, undefined);
    assert.equal(stored.lastTransientAt, first.clock.now());

    const second = await boot({ storage, clock: new FakeClock(first.clock.now() + 500) });
    assert.equal(second.engine.status().state, "FREE_COOLDOWN");
    assert.equal(second.engine.status().cooldownReason, "transient-availability");
    assert.ok(second.log.has("restored free cooldown from persisted state"));
  });

  it("discards an expired transient cooldown on restart and keeps the ladder position", async () => {
    const storage = new FakeStorage();
    const first = await boot({ storage });
    first.engine.onModelRequest("ses_a", FREE, "primary");
    await retry(first.engine);
    await first.clock.advance(0);
    await first.engine.dispose();

    const second = await boot({ storage, clock: new FakeClock(first.clock.now() + 6_000) });
    assert.equal(second.engine.status().state, "FREE_HEALTHY");
    assert.equal(second.engine.status().transientFailures, 1, "the outage history survives");
    assert.ok(second.log.has("discarded expired free cooldown"));

    second.engine.onModelRequest("ses_b", FREE, "primary");
    await retry(second.engine, "ses_b");
    assert.equal(second.engine.status().cooldownMs, 2_000, "the ladder kept escalating");
  });

  it("adopts a transient cooldown recorded by another instance before deciding a route", async () => {
    const storage = new FakeStorage();
    const { engine, clock, sessions } = await boot({ storage });
    await storage.set("opencode-free-first/health-v1", {
      schemaVersion: 1,
      scope: "fake/fake-free",
      state: "FREE_COOLDOWN",
      cooldownUntil: clock.now() + 30_000,
      cooldownReason: "transient-availability",
      transientFailures: 2,
      lastTransientAt: clock.now(),
      lastTransientType: "failover-http-502",
      level: 0,
    });
    await engine.onPrompt("ses_new");
    assert.equal(engine.status().state, "FREE_COOLDOWN");
    assert.equal(engine.status().cooldownReason, "transient-availability");
    assert.equal(engine.status().transientFailures, 2, "the shared ladder is adopted");
    assert.deepEqual(targets(sessions), ["ses_new:fake/fake-paid"]);
  });

  it("does not re-adopt a transient outage that a newer recovery already cleared", async () => {
    const storage = new FakeStorage();
    const { engine, clock, sessions } = await boot({ storage });
    // Another instance recorded an outage, then confirmed a recovery after it.
    await storage.set("opencode-free-first/health-v1", {
      schemaVersion: 1,
      scope: "fake/fake-free",
      state: "FREE_HEALTHY",
      level: 0,
      transientFailures: 0,
      lastTransientAt: clock.now() - 60_000,
      lastHealthyAt: clock.now() - 30_000,
      lastRateLimitAt: 0,
    });
    await engine.refresh();
    assert.equal(engine.status().state, "FREE_HEALTHY");
    await engine.onPrompt("ses_new");
    assert.equal(sessions.of("switchModel").length, 0, "the cleared outage routed nothing");
  });
});

describe("scheduler hygiene", () => {
  it("an elapsed cooldown with no waiting session leaves the record and stops waking", async () => {
    class CountingClock extends FakeClock {
      fires = 0;
      setTimeout(callback, delayMs) {
        return super.setTimeout(() => {
          this.fires += 1;
          callback();
        }, delayMs);
      }
    }
    const clock = new CountingClock();
    const built = engineOptions({ clock, config: { fallback: undefined } });
    const engine = new FreeFirstEngine(built.options);
    await engine.start();
    await built.clock.flush();

    // An opted-out session observes the outage: shared state is recorded, but
    // nothing is switched, so no session waits on the fallback.
    engine.onModelSelected({ sessionID: "ses_a", model: OTHER });
    engine.onModelRequest("ses_a", OTHER, "primary");
    const decision = { retry: false };
    await engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: internal(500),
      attempt: 2,
      decision,
    });
    assert.deepEqual(decision, { retry: false });
    assert.equal(engine.status().state, "FREE_COOLDOWN");
    assert.equal(engine.status().fallbackSessions, 0);

    await clock.advance(1_001);
    assert.equal(engine.status().state, "FREE_HEALTHY", "the elapsed record left");
    assert.equal(engine.status().cooldownEndsAt, undefined);
    const fires = clock.fires;
    await clock.advance(1_000);
    assert.ok(
      clock.fires - fires <= 1,
      `expected no repeating wake-up, got ${clock.fires - fires} in one second`,
    );
    await engine.dispose();
  });
});
