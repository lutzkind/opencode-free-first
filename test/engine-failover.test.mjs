import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FreeFirstEngine } from "../dist/engine.js";
import { engineOptions, FakeSessions, FREE, OTHER, PAID, rateLimitError } from "./fakes.mjs";

async function boot(overrides = {}) {
  const built = engineOptions(overrides);
  const engine = new FreeFirstEngine(built.options);
  await engine.start();
  await built.clock.flush();
  return { engine, ...built };
}

function retry(engine, overrides = {}) {
  const decision = overrides.decision ?? { retry: false };
  const input = {
    sessionID: "ses_a",
    model: FREE,
    error: rateLimitError(),
    attempt: 2,
    decision,
    ...overrides,
  };
  return engine.onRetry(input).then(() => input.decision);
}

describe("failover", () => {
  it("switches the same session to the fallback and forces a cheap retry", async () => {
    const { engine, sessions, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine);

    assert.deepEqual(decision, { retry: true, delay: 100 });
    const switches = sessions.of("switchModel");
    assert.equal(switches.length, 1);
    assert.equal(switches[0].sessionID, "ses_a");
    assert.deepEqual(switches[0].model, PAID);
    assert.ok(log.has("free rate limit detected"));
    assert.ok(log.has("cooldown started"));
    assert.ok(log.has("fallback selected"));
  });

  it("retains the session: the failover is a model switch, never a new session", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    for (const call of sessions.calls) assert.equal(call.sessionID, "ses_a");
    assert.equal(sessions.of("switchModel").length, 1);
  });

  it("honours Retry-After from the provider response", async () => {
    const { engine, clock, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    engine.onHttpHeaders("ses_a", { "retry-after": "30" });
    await retry(engine);
    const detail = log.detailFor("free rate limit detected");
    assert.equal(detail.resetSource, "retry-after");
    assert.equal(detail.cooldown, "30s");
    assert.equal(engine.status().cooldownEndsAt, clock.now() + 30_000);
  });

  it("falls back to the bounded ladder when no reset is known", async () => {
    const { engine, clock, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, {
      error: {
        type: "provider.rate-limit",
        message: "Rate limit exceeded. Please try again later.",
      },
    });
    assert.equal(log.detailFor("free rate limit detected").resetSource, "backoff");
    assert.equal(engine.status().cooldownEndsAt, clock.now() + 1_000);
  });

  it("does not fail over on an unrelated 400", async () => {
    const { engine, sessions, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine, {
      error: { type: "provider.invalid-request", status: 400, message: "bad request" },
    });
    assert.deepEqual(decision, { retry: false });
    assert.equal(sessions.of("switchModel").length, 0);
    assert.ok(log.has("provider failure is not a free-model rate limit"));
  });

  it("does not fail over on a 401", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, {
      error: { type: "provider.auth", status: 401, message: "authentication failed" },
    });
    assert.equal(sessions.of("switchModel").length, 0);
  });

  it("does not fail over on a generic 500", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, {
      error: { type: "provider.internal", status: 500, message: "internal server error" },
    });
    assert.equal(sessions.of("switchModel").length, 0);
  });

  it("does not fail over on a tool failure or a plugin bug", async () => {
    const { engine, sessions } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine, { error: { type: "tool.execution", message: "tool failed" } });
    await retry(engine, { error: { type: "unknown", message: "TypeError: boom" } });
    assert.equal(sessions.of("switchModel").length, 0);
  });

  it("surfaces the failure when there is no fallback to switch to", async () => {
    const { engine, sessions, log } = await boot({
      config: { fallback: undefined },
      sessions: new FakeSessions({ ses_a: FREE }),
    });
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine);
    assert.deepEqual(decision, { retry: false });
    assert.equal(sessions.of("switchModel").length, 0);
    assert.ok(log.has("no fallback model available"));
  });

  it("keeps the failure visible when the switch itself fails", async () => {
    const sessions = new FakeSessions();
    sessions.failSwitch("ses_a");
    const { engine, log } = await boot({ sessions });
    engine.onModelRequest("ses_a", FREE, "primary");
    const decision = await retry(engine);
    assert.deepEqual(decision, { retry: false });
    assert.ok(log.has("failed to switch session to the fallback model"));
  });

  it("uses the session's previous model when no fallback is configured", async () => {
    const sessions = new FakeSessions({ ses_a: OTHER });
    const { engine } = await boot({ config: { fallback: undefined }, sessions });
    engine.onModelSelected({ sessionID: "ses_a", model: FREE, previous: OTHER });
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    assert.deepEqual(sessions.of("switchModel")[0].model, OTHER);
  });

  it("uses OpenCode's captured default model as the last resort", async () => {
    const sessions = new FakeSessions();
    const { engine } = await boot({ config: { fallback: undefined }, sessions });
    engine.rememberDefault(OTHER);
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    assert.deepEqual(sessions.of("switchModel")[0].model, OTHER);
  });
});

describe("classification boundaries", () => {
  it("only reacts to the configured primary model", async () => {
    const { engine, sessions } = await boot();
    await retry(engine, { model: PAID });
    await retry(engine, { model: OTHER });
    assert.equal(sessions.of("switchModel").length, 0);
  });

  it("does not advance the ladder twice for one provider window", async () => {
    const { engine, log } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    const first = log.detailFor("cooldown started").level;
    await retry(engine, { sessionID: "ses_b" });
    assert.equal(engine.status().level, first, "the ladder did not advance again");
    assert.equal(log.lastDetailFor("free rate limit detected").duplicate, true);
  });

  it("advances the ladder once the duplicate window has passed", async () => {
    const { engine, clock } = await boot();
    engine.onModelRequest("ses_a", FREE, "primary");
    await retry(engine);
    const first = engine.status().level;
    // Move past the duplicate window without firing the recovery timer, so the
    // ladder position is observable in isolation.
    clock.jump(6_000);
    await retry(engine, { sessionID: "ses_b" });
    assert.equal(engine.status().level, first + 1);
  });
});
