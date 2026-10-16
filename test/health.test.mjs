import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLimited,
  backoffFor,
  clearElapsedCooldown,
  cooldownElapsed,
  decodeHealth,
  extendCooldown,
  formatDuration,
  healthState,
  inCooldown,
  initialHealth,
  markHealthy,
  markProbeInconclusive,
  probeDeferred,
  remainingCooldown,
  withJitter,
} from "../dist/health.js";

const OPTIONS = { backoffMs: [1_000, 2_000, 5_000], maxCooldownMs: 5_000, jitterRatio: 0 };
const SCOPE = "fake/fake-free";
const NOW = 1_700_000_000_000;

function limited(health, overrides = {}) {
  return applyLimited(health, {
    now: NOW,
    reason: "test",
    options: OPTIONS,
    random: () => 0.5,
    ...overrides,
  });
}

describe("backoff ladder", () => {
  it("walks the configured ladder and clamps at the last step", () => {
    assert.equal(backoffFor(0, OPTIONS.backoffMs), 1_000);
    assert.equal(backoffFor(1, OPTIONS.backoffMs), 2_000);
    assert.equal(backoffFor(2, OPTIONS.backoffMs), 5_000);
    assert.equal(backoffFor(9, OPTIONS.backoffMs), 5_000);
    assert.equal(backoffFor(-3, OPTIONS.backoffMs), 1_000);
    assert.equal(backoffFor(0, []), 0);
  });

  it("applies symmetric bounded jitter", () => {
    assert.equal(
      withJitter(1_000, 0, () => 0.5),
      1_000,
    );
    assert.equal(
      withJitter(1_000, 0.5, () => 0),
      500,
    );
    assert.equal(
      withJitter(1_000, 0.5, () => 1),
      1_500,
    );
    assert.ok(withJitter(1_000, 5, () => 0) >= 0);
  });
});

describe("state transitions", () => {
  it("FREE_HEALTHY -> FREE_COOLDOWN on a genuine rate limit", () => {
    const healthy = initialHealth(SCOPE, NOW);
    assert.equal(healthy.state, "FREE_HEALTHY");
    const { health, source, cooldownMs } = limited(healthy);
    assert.equal(health.state, "FREE_COOLDOWN");
    assert.equal(source, "backoff");
    assert.equal(cooldownMs, 1_000);
    assert.equal(health.level, 1);
    assert.equal(health.lastRateLimitAt, NOW);
  });

  it("FREE_COOLDOWN -> FREE_PROBE once the cooldown elapses", () => {
    const { health } = limited(initialHealth(SCOPE, NOW));
    assert.equal(healthState(health, NOW), "FREE_COOLDOWN");
    assert.equal(inCooldown(health, NOW), true);
    assert.equal(cooldownElapsed(health, NOW), false);
    assert.equal(healthState(health, NOW + 1_000), "FREE_PROBE");
    assert.equal(inCooldown(health, NOW + 1_000), false);
    assert.equal(cooldownElapsed(health, NOW + 1_000), true);
    assert.equal(remainingCooldown(health, NOW + 400), 600);
  });

  it("FREE_PROBE success -> FREE_HEALTHY resets the ladder", () => {
    const { health } = limited(limited(initialHealth(SCOPE, NOW)).health);
    assert.equal(health.level, 2);
    const recovered = markHealthy(health, NOW + 10_000);
    assert.equal(recovered.state, "FREE_HEALTHY");
    assert.equal(recovered.level, 0);
    assert.equal(recovered.lastHealthyAt, NOW + 10_000);
    assert.equal(recovered.lastRateLimitAt, NOW, "the last limit is still reported");
  });

  it("FREE_PROBE rate limit -> FREE_COOLDOWN with a higher level", () => {
    const first = limited(initialHealth(SCOPE, NOW));
    const second = extendCooldown(first.health, {
      now: NOW + 2_000,
      reason: "again",
      options: OPTIONS,
      random: () => 0.5,
    });
    assert.equal(second.health.state, "FREE_COOLDOWN");
    assert.equal(second.health.level, 2);
    assert.equal(second.cooldownMs, 2_000);
  });

  it("grows the backoff across repeated limits and enforces the maximum", () => {
    let health = initialHealth(SCOPE, NOW);
    const observed = [];
    for (let index = 0; index < 6; index += 1) {
      const applied = limited(health, { now: NOW + index * 100_000 });
      observed.push(applied.cooldownMs);
      health = applied.health;
    }
    assert.deepEqual(observed, [1_000, 2_000, 5_000, 5_000, 5_000, 5_000]);
    assert.ok(Math.max(...observed) <= OPTIONS.maxCooldownMs);
  });

  it("honours an authoritative reset over the ladder", () => {
    const { health, source, cooldownMs } = limited(initialHealth(SCOPE, NOW), {
      reset: { until: NOW + 42_000, source: "retry-after" },
    });
    assert.equal(source, "retry-after");
    assert.equal(cooldownMs, 42_000);
    assert.equal(health.cooldownUntil, NOW + 42_000);
  });

  it("uses the absolute reset even when it exceeds the ladder maximum", () => {
    const { cooldownMs } = limited(initialHealth(SCOPE, NOW), {
      reset: { until: NOW + 3_600_000, source: "retry-after" },
    });
    assert.equal(cooldownMs, 3_600_000);
  });

  it("falls back to the ladder when the reset value is nonsense", () => {
    const { source, cooldownMs } = limited(initialHealth(SCOPE, NOW), {
      reset: { until: Number.NaN, source: "retry-after" },
    });
    assert.equal(source, "backoff");
    assert.equal(cooldownMs, 1_000);
  });

  it("never applies a zero-length cooldown", () => {
    const { cooldownMs } = limited(initialHealth(SCOPE, NOW), {
      reset: { until: NOW, source: "retry-after" },
    });
    assert.ok(cooldownMs >= 1_000);
  });

  it("treats an inconclusive probe as unknown, never as a limit", () => {
    const { health } = limited(initialHealth(SCOPE, NOW));
    const deferred = markProbeInconclusive(health, {
      now: NOW,
      retryMs: 30_000,
      outcome: "inconclusive:unclassified-message",
    });
    // The free model stays usable: an inconclusive probe is not evidence of a
    // limit, so it must never keep the free model blocked.
    assert.equal(deferred.state, "FREE_HEALTHY");
    assert.equal(deferred.cooldownUntil, undefined);
    assert.equal(inCooldown(deferred, NOW), false);
    assert.equal(deferred.level, health.level, "the ladder does not advance");
    assert.equal(deferred.probeBackoffUntil, NOW + 30_000);
    assert.equal(deferred.inconclusiveProbes, 1);
    assert.equal(probeDeferred(deferred, NOW), true);
    assert.equal(probeDeferred(deferred, NOW + 30_001), false);
    assert.equal(deferred.lastProbeOutcome, "inconclusive:unclassified-message");
  });

  it("keeps a probe back-off from ever becoming a routing block", () => {
    let health = limited(initialHealth(SCOPE, NOW)).health;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      health = markProbeInconclusive(health, {
        now: NOW + attempt * 100_000,
        retryMs: 60_000,
        outcome: "unsupported:unclassified-message",
      });
      assert.equal(inCooldown(health, NOW + attempt * 100_000), false, `attempt ${attempt}`);
      assert.equal(health.state, "FREE_HEALTHY");
    }
    assert.equal(health.inconclusiveProbes, 5);
  });

  it("drops an elapsed cooldown from the record", () => {
    const { health } = limited(initialHealth(SCOPE, NOW));
    assert.equal(clearElapsedCooldown(health, NOW + 500).state, "FREE_COOLDOWN", "still blocking");
    const cleared = clearElapsedCooldown(health, NOW + 1_000);
    assert.equal(cleared.state, "FREE_HEALTHY");
    assert.equal(cleared.cooldownUntil, undefined);
    assert.equal(cleared.level, health.level, "the ladder survives");
    assert.equal(inCooldown(cleared, NOW + 1_000), false);
    assert.equal(healthState(cleared, NOW + 1_000), "FREE_HEALTHY");
    // Idempotent, and a healthy record is returned untouched.
    assert.equal(clearElapsedCooldown(cleared, NOW + 2_000), cleared);
  });

  it("keeps the probe bookkeeping when an elapsed cooldown is dropped", () => {
    const deferred = markProbeInconclusive(limited(initialHealth(SCOPE, NOW)).health, {
      now: NOW,
      retryMs: 60_000,
      outcome: "unsupported:unclassified-message",
    });
    const backToCooldown = applyLimited(deferred, {
      now: NOW + 1_000,
      reason: "again",
      options: OPTIONS,
      random: () => 0.5,
    }).health;
    assert.equal(backToCooldown.probeBackoffUntil, deferred.probeBackoffUntil);
    const cleared = clearElapsedCooldown(backToCooldown, NOW + 10_000);
    assert.equal(cleared.state, "FREE_HEALTHY");
    assert.equal(cleared.probeBackoffUntil, deferred.probeBackoffUntil);
    assert.equal(cleared.lastProbeOutcome, "unsupported:unclassified-message");
  });

  it("clears the probe back-off when health is confirmed", () => {
    const deferred = markProbeInconclusive(limited(initialHealth(SCOPE, NOW)).health, {
      now: NOW,
      retryMs: 60_000,
      outcome: "inconclusive",
    });
    const healthy = markHealthy(deferred, NOW + 1_000);
    assert.equal(healthy.probeBackoffUntil, undefined);
    assert.equal(healthy.inconclusiveProbes, 0);
    assert.equal(healthy.lastProbeOutcome, undefined);
    assert.equal(healthy.lastHealthyAt, NOW + 1_000);
  });
});

describe("persistence", () => {
  it("round-trips a cooldown", () => {
    const { health } = limited(initialHealth(SCOPE, NOW), {
      reset: { until: NOW + 8_000, source: "retry-after" },
    });
    const decoded = decodeHealth(JSON.parse(JSON.stringify(health)), SCOPE);
    assert.deepEqual(decoded, health);
  });

  it("round-trips the probe back-off bookkeeping", () => {
    const deferred = markProbeInconclusive(limited(initialHealth(SCOPE, NOW)).health, {
      now: NOW,
      retryMs: 120_000,
      outcome: "unsupported:unclassified-message",
    });
    const decoded = decodeHealth(JSON.parse(JSON.stringify(deferred)), SCOPE);
    assert.deepEqual(decoded, deferred);
  });

  it("drops corrupt probe bookkeeping without losing the cooldown", () => {
    const base = limited(initialHealth(SCOPE, NOW)).health;
    // Probe bookkeeping cannot affect routing safety, so a damaged value is
    // dropped rather than discarding a real cooldown along with it.
    for (const damaged of [
      { probeBackoffUntil: -5 },
      { probeBackoffUntil: "soon" },
      { inconclusiveProbes: -1 },
      { inconclusiveProbes: "many" },
      { lastProbeOutcome: 42 },
    ]) {
      const decoded = decodeHealth({ ...base, ...damaged }, SCOPE);
      assert.equal(decoded.state, "FREE_COOLDOWN", JSON.stringify(damaged));
      assert.equal(decoded.cooldownUntil, base.cooldownUntil, JSON.stringify(damaged));
      assert.equal(decoded.probeBackoffUntil, undefined, JSON.stringify(damaged));
      assert.equal(decoded.inconclusiveProbes, undefined, JSON.stringify(damaged));
      assert.equal(decoded.lastProbeOutcome, undefined, JSON.stringify(damaged));
    }
  });

  it("discards state for another scope", () => {
    const { health } = limited(initialHealth(SCOPE, NOW));
    assert.equal(decodeHealth(JSON.parse(JSON.stringify(health)), "other/model"), undefined);
  });

  it("discards an unknown schema version", () => {
    const { health } = limited(initialHealth(SCOPE, NOW));
    assert.equal(decodeHealth({ ...health, schemaVersion: 99 }, SCOPE), undefined);
  });

  it("discards corrupt state instead of throwing", () => {
    for (const value of [
      undefined,
      null,
      42,
      "nope",
      [],
      { schemaVersion: 1, scope: SCOPE, state: "WAT", level: 0 },
      { schemaVersion: 1, scope: SCOPE, state: "FREE_COOLDOWN", level: 0 },
      { schemaVersion: 1, scope: SCOPE, state: "FREE_HEALTHY", level: -1 },
      { schemaVersion: 1, scope: SCOPE, state: "FREE_HEALTHY", level: 0, cooldownUntil: "soon" },
    ]) {
      assert.equal(decodeHealth(value, SCOPE), undefined, JSON.stringify(value));
    }
  });

  it("formats durations for logs and status", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(45_000), "45s");
    assert.equal(formatDuration(8 * 60_000), "8m");
    assert.equal(formatDuration(62 * 60_000), "1h2m");
  });
});
