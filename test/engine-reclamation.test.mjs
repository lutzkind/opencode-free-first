/**
 * Reclamation of a peak-held fallback request.
 *
 * The behaviour under test is the one that makes the headless `opencode run`
 * case work: a parked paid request is cancelled through the parking plugin's
 * generic capability, the cancelled attempt is refused at the transport
 * boundary, and the *same execution* continues on the free model. Nothing
 * interrupts the session, and the interrupt-based path stays available as the
 * fallback for a parking plugin without the capability.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FreeFirstEngine } from "../dist/engine.js";
import { engineOptions, FakePaidHolds, FREE, OTHER, PAID, rateLimitError } from "./fakes.mjs";

async function boot(overrides = {}) {
  const built = engineOptions(overrides);
  const engine = new FreeFirstEngine(built.options);
  await engine.start();
  await built.clock.flush();
  return { engine, ...built };
}

async function failover(engine, sessionID, error = rateLimitError()) {
  engine.onModelRequest(sessionID, FREE, "primary");
  return retry(engine, { sessionID, model: FREE, error, attempt: 2, decision: { retry: false } });
}

/** Park a fallback request exactly like another plugin's pre-model hold does. */
function park(engine, sessionID) {
  engine.onExecution({ sessionID, phase: "started" });
  engine.onContext(sessionID, PAID);
}

/**
 * Call the retry hook the way the server hook does: the engine mutates
 * `input.decision` and the caller copies it back onto the live event.
 */
async function retry(engine, input) {
  const live = { ...input };
  await engine.onRetry(live);
  return live.decision;
}

/** The refusal the parking plugin reports: a retryable transport failure. */
function refusedError() {
  return {
    type: "provider.transport",
    message: "ConnectionRefused: Unable to connect. Is the computer able to access the url?",
  };
}

describe("hold cancellation", () => {
  it("cancels a parked request instead of interrupting the session, then resumes on the free model", async () => {
    const paidHolds = new FakePaidHolds();
    const { engine, clock, sessions, log } = await boot({ paidHolds });
    await failover(engine, "ses_a");
    park(engine, "ses_a");

    await clock.advance(1_500);

    assert.equal(log.has("parked fallback request detected"), true);
    assert.equal(paidHolds.requests.length, 1, "the neighbour was asked to cancel the hold");
    assert.equal(paidHolds.requests[0].sessionID, "ses_a");
    assert.equal(sessions.of("interrupt").length, 0, "no session interruption");
    assert.equal(sessions.of("synthetic").length, 0, "no extra continuation input");
    assert.equal(log.has("stale fallback continuation neutralized"), true);
    assert.equal(engine.status().pendingResumes, 1);

    // The cancelled attempt comes back as a refused transport failure.
    const decision = await retry(engine, {
      sessionID: "ses_a",
      model: PAID,
      error: refusedError(),
      attempt: 3,
      decision: { retry: true, delay: 4_229 },
    });
    assert.deepEqual(
      decision,
      { retry: true, delay: 100 },
      "retried immediately on the free model",
    );
    assert.equal(engine.status().pendingResumes, 0);
    assert.equal(
      engine.status().fallbackSessions,
      0,
      "the session is back on the free model inside the same execution",
    );
    // Exactly one model transition: failover to paid, then back to free.
    const switches = sessions.of("switchModel");
    assert.deepEqual(
      switches.map((call) => call.model.id),
      ["fake-paid", "fake-free"],
    );
    assert.equal(log.has("same task resumed on the free model"), true);
  });

  it("leaves the paid work alone when the dispatch decision already won the race", async () => {
    const paidHolds = new FakePaidHolds({ cancelled: false, state: "committed" });
    const { engine, clock, sessions, log } = await boot({ paidHolds });
    await failover(engine, "ses_a");
    park(engine, "ses_a");

    await clock.advance(1_500);
    assert.equal(paidHolds.requests.length, 1);
    assert.equal(sessions.of("interrupt").length, 0, "a committed dispatch is never interrupted");
    assert.equal(sessions.of("synthetic").length, 0);
    assert.equal(engine.status().pendingResumes, 0);
    assert.equal(log.has("parked fallback request was not cancellable"), true);
    assert.equal(log.has("stale fallback continuation neutralized"), false);
  });

  it("keeps the interrupt-based reclamation when the capability is unavailable", async () => {
    const paidHolds = new FakePaidHolds({ cancelled: true, state: "refused" }, true);
    const { engine, clock, sessions, log } = await boot({ paidHolds });
    await failover(engine, "ses_a");
    park(engine, "ses_a");

    await clock.advance(1_500);
    assert.equal(paidHolds.requests.length, 1, "the capability was probed");
    assert.equal(sessions.of("interrupt").length, 1, "documented fallback behaviour is retained");
    assert.equal(sessions.of("synthetic").length, 1);
    assert.equal(log.has("duplicate continuation prevented"), true);
  });

  it("uses the interrupt path when no neighbour is installed", async () => {
    const { engine, clock, sessions } = await boot();
    await failover(engine, "ses_a");
    park(engine, "ses_a");
    await clock.advance(1_500);
    assert.equal(sessions.of("interrupt").length, 1);
    assert.equal(sessions.of("synthetic").length, 1);
  });

  it("reports the cancellation capability in status", async () => {
    const paidHolds = new FakePaidHolds();
    const { engine, clock } = await boot({ paidHolds });
    assert.equal(engine.status().holdCancelCapability, "unknown");
    await failover(engine, "ses_a");
    park(engine, "ses_a");
    await clock.advance(1_500);
    assert.equal(engine.status().holdCancelCapability, "available");
    assert.deepEqual(engine.status().holdCancels, { accepted: 1, committed: 0, unavailable: 0 });
  });
});

describe("resume-after-refusal policy", () => {
  it("ignores a fallback transport failure that this plugin did not request", async () => {
    const paidHolds = new FakePaidHolds({ cancelled: false, state: "none" });
    const { engine, clock } = await boot({ paidHolds });
    await failover(engine, "ses_a");
    park(engine, "ses_a");
    await clock.advance(1_500);

    const decision = await retry(engine, {
      sessionID: "ses_b",
      model: PAID,
      error: refusedError(),
      attempt: 2,
      decision: { retry: true, delay: 4_229 },
    });
    assert.deepEqual(decision, { retry: true, delay: 4_229 }, "the caller's decision is untouched");
    assert.equal(engine.status().pendingResumes, 0);
  });

  it("does not resume while the free model is cooling down again", async () => {
    const paidHolds = new FakePaidHolds();
    const { engine, clock, log } = await boot({ paidHolds });
    await failover(engine, "ses_a");
    park(engine, "ses_a");
    await clock.advance(1_500);
    assert.equal(engine.status().pendingResumes, 1);

    // The free model limits again while the refusal is still in flight.
    engine.onModelRequest("ses_a", FREE, "primary");
    await engine.onRetry({
      sessionID: "ses_a",
      model: FREE,
      error: rateLimitError(),
      attempt: 3,
      decision: { retry: false },
    });
    const decision = await retry(engine, {
      sessionID: "ses_a",
      model: PAID,
      error: refusedError(),
      attempt: 4,
      decision: { retry: true, delay: 4_229 },
    });
    assert.deepEqual(decision, { retry: true, delay: 4_229 });
    assert.equal(log.has("cannot resume yet"), true);
    assert.equal(engine.status().pendingResumes, 1, "the marker survives for a later attempt");
  });

  it("does not resume a session the user has taken over", async () => {
    const paidHolds = new FakePaidHolds();
    const { engine, clock } = await boot({ paidHolds });
    await failover(engine, "ses_a");
    park(engine, "ses_a");
    await clock.advance(1_500);

    engine.onModelSelected({ sessionID: "ses_a", model: OTHER, previous: PAID });
    const decision = await retry(engine, {
      sessionID: "ses_a",
      model: PAID,
      error: refusedError(),
      attempt: 3,
      decision: { retry: true, delay: 4_229 },
    });
    assert.deepEqual(decision, { retry: true, delay: 4_229 }, "the user's session is left alone");
    assert.equal(engine.status().pendingResumes, 0, "the marker is dropped, never replayed");
  });

  it("does not resume a refused attempt that is not retryable", async () => {
    const paidHolds = new FakePaidHolds();
    const { engine, clock, log } = await boot({ paidHolds });
    await failover(engine, "ses_a");
    park(engine, "ses_a");
    await clock.advance(1_500);

    const decision = await retry(engine, {
      sessionID: "ses_a",
      model: PAID,
      error: { type: "provider.invalid-request", message: "bad request", status: 400 },
      attempt: 3,
      decision: { retry: false },
    });
    assert.deepEqual(decision, { retry: false });
    assert.equal(log.has("is not retryable"), true);
    assert.equal(engine.status().fallbackSessions, 0);
  });
});
