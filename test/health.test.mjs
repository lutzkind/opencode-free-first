import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLimited,
  backoffFor,
  cooldownElapsed,
  decodeHealth,
  deferAfterInconclusiveProbe,
  extendCooldown,
  formatDuration,
  healthState,
  inCooldown,
  initialHealth,
  markHealthy,
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

  it("treats an inconclusive probe as not-a-rate-limit", () => {
    const { health } = limited(initialHealth(SCOPE, NOW));
    const deferred = deferAfterInconclusiveProbe(health, NOW, 30_000);
    assert.equal(deferred.state, "FREE_COOLDOWN");
    assert.equal(deferred.level, health.level, "the ladder does not advance");
    assert.equal(deferred.cooldownUntil, NOW + 30_000);
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
