/**
 * Free-model availability state.
 *
 * A single small state machine:
 *
 *   FREE_HEALTHY  -- genuine rate limit -->  FREE_COOLDOWN
 *   FREE_COOLDOWN -- cooldown reached   -->  FREE_PROBE
 *   FREE_PROBE    -- success            -->  FREE_HEALTHY
 *   FREE_PROBE    -- rate limited       -->  FREE_COOLDOWN (level + 1)
 *   FREE_PROBE    -- inconclusive       -->  FREE_COOLDOWN (level unchanged)
 *
 * Everything here is pure and clock-injected so the whole ladder is covered by
 * deterministic tests. Cooldowns are always absolute epoch milliseconds: a
 * matching timer is a convenience, never the source of truth, so a restart or a
 * reload cannot lose or duplicate a cooldown.
 */

import type { FreeState, HealthRecord, ResetSource } from "./types.js";
import { HEALTH_SCHEMA_VERSION } from "./types.js";

export interface HealthOptions {
  readonly backoffMs: readonly number[];
  readonly maxCooldownMs: number;
  readonly jitterRatio: number;
}

/**
 * A fresh instance starts healthy and, deliberately, does **not** claim a
 * recovery: `lastHealthyAt` is only set by an observed success, a successful
 * probe, or an adopted foreign recovery. Claiming one at start-up would let a
 * newly started instance overwrite a cooldown another instance recorded.
 */
export function initialHealth(scope: string, _now: number): HealthRecord {
  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    scope,
    state: "FREE_HEALTHY",
    level: 0,
  };
}

/** Position in the bounded backoff ladder, clamped to the last entry. */
export function backoffFor(level: number, ladder: readonly number[]): number {
  if (ladder.length === 0) return 0;
  const index = Math.min(Math.max(0, Math.floor(level)), ladder.length - 1);
  return ladder[index] ?? ladder[ladder.length - 1] ?? 0;
}

/**
 * Bounded jitter. Symmetric, so the expectation stays on the ladder value, and
 * clamped to `[0, cap]` so jitter can never extend a cooldown past the maximum.
 */
export function withJitter(value: number, ratio: number, random: () => number): number {
  if (ratio <= 0) return Math.round(value);
  const span = value * Math.min(ratio, 1);
  const offset = (random() * 2 - 1) * span;
  return Math.max(0, Math.round(value + offset));
}

export interface LimitedInput {
  readonly now: number;
  /** Authoritative reset time when the provider supplied one. */
  readonly reset?: { readonly until: number; readonly source: ResetSource } | undefined;
  readonly reason: string;
  readonly options: HealthOptions;
  readonly random: () => number;
  /** Shortest cooldown ever applied, so a provider hint of "0s" still waits. */
  readonly minCooldownMs?: number;
}

/**
 * Move to FREE_COOLDOWN after a genuine rate limit.
 *
 * An authoritative reset wins over the ladder: the provider told us when the
 * free model is usable again, so probing earlier buys nothing. When no reset is
 * known, the bounded ladder (with jitter) applies, and the level advances so a
 * repeat failure backs off further.
 */
export function applyLimited(
  health: HealthRecord,
  input: LimitedInput,
): { readonly health: HealthRecord; readonly source: ResetSource; readonly cooldownMs: number } {
  const level = health.level;
  const ladderMs = backoffFor(level, input.options.backoffMs);
  const minCooldownMs = input.minCooldownMs ?? 1_000;

  let until: number;
  let source: ResetSource;
  if (input.reset !== undefined) {
    source = input.reset.source;
    until = Math.max(input.reset.until, input.now + minCooldownMs);
    // An authoritative hint far beyond the ladder is still authoritative, but a
    // nonsense value (already past, or beyond a day) is treated as absent.
    if (!Number.isFinite(until) || until - input.now > 86_400_000) {
      until = input.now + minCooldownMs;
      source = "backoff";
    }
  } else {
    source = "backoff";
    const jittered = withJitter(ladderMs, input.options.jitterRatio, input.random);
    until = input.now + Math.max(minCooldownMs, Math.min(jittered, input.options.maxCooldownMs));
  }

  return {
    health: {
      schemaVersion: HEALTH_SCHEMA_VERSION,
      scope: health.scope,
      state: "FREE_COOLDOWN",
      cooldownUntil: until,
      level: Math.min(level + 1, Math.max(0, input.options.backoffMs.length)),
      lastRateLimitAt: input.now,
      lastRateLimitType: input.reason,
      lastResetSource: source,
      ...(health.lastHealthyAt === undefined ? {} : { lastHealthyAt: health.lastHealthyAt }),
    },
    source,
    cooldownMs: until - input.now,
  };
}

/** Move to FREE_HEALTHY and reset the ladder. */
export function markHealthy(health: HealthRecord, now: number): HealthRecord {
  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    scope: health.scope,
    state: "FREE_HEALTHY",
    level: 0,
    lastHealthyAt: now,
    ...(health.lastRateLimitAt === undefined ? {} : { lastRateLimitAt: health.lastRateLimitAt }),
    ...(health.lastRateLimitType === undefined
      ? {}
      : { lastRateLimitType: health.lastRateLimitType }),
    ...(health.lastResetSource === undefined ? {} : { lastResetSource: health.lastResetSource }),
  };
}

/** Re-arm a cooldown after a rate limit discovered by an active probe. */
export function extendCooldown(
  health: HealthRecord,
  input: LimitedInput,
): {
  readonly health: HealthRecord;
  readonly source: ResetSource;
  readonly cooldownMs: number;
} {
  return applyLimited(health, input);
}

/**
 * A probe that failed for a reason unrelated to free-tier exhaustion is
 * inconclusive: the free model may be perfectly usable, but the provider is
 * unhealthy. Keep the current level and retry soon instead of escalating.
 */
export function deferAfterInconclusiveProbe(
  health: HealthRecord,
  now: number,
  retryMs: number,
): HealthRecord {
  return {
    ...health,
    state: "FREE_COOLDOWN",
    cooldownUntil: now + Math.max(1_000, retryMs),
    lastResetSource: "backoff",
  };
}

/** True when the free model must not be used yet. */
export function inCooldown(health: HealthRecord, now: number): boolean {
  if (health.state === "FREE_HEALTHY") return false;
  if (health.cooldownUntil === undefined) return false;
  return health.cooldownUntil > now;
}

/** True when the cooldown has elapsed and the free model may be tested again. */
export function cooldownElapsed(health: HealthRecord, now: number): boolean {
  return health.state === "FREE_COOLDOWN" && !inCooldown(health, now);
}

/** Remaining cooldown in milliseconds, `0` when none. */
export function remainingCooldown(health: HealthRecord, now: number): number {
  if (health.state === "FREE_HEALTHY") return 0;
  if (health.cooldownUntil === undefined) return 0;
  return Math.max(0, health.cooldownUntil - now);
}

/**
 * Decode persisted state. Anything malformed is discarded (returning
 * `undefined`) so a corrupt document degrades to "no cooldown" — the plugin
 * then behaves exactly like a fresh install instead of holding a bogus
 * cooldown or crashing.
 */
export function decodeHealth(value: unknown, scope: string): HealthRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== HEALTH_SCHEMA_VERSION) return undefined;
  if (record.scope !== scope) return undefined;
  const state = record.state;
  if (state !== "FREE_HEALTHY" && state !== "FREE_COOLDOWN" && state !== "FREE_PROBE") {
    return undefined;
  }
  const level = record.level;
  if (typeof level !== "number" || !Number.isFinite(level) || level < 0) return undefined;
  const cooldownUntil = record.cooldownUntil;
  if (
    cooldownUntil !== undefined &&
    (typeof cooldownUntil !== "number" || !Number.isFinite(cooldownUntil))
  ) {
    return undefined;
  }
  if (state === "FREE_COOLDOWN" && cooldownUntil === undefined) return undefined;
  const nullableNumber = (key: string): number | undefined => {
    const entry = record[key];
    return typeof entry === "number" && Number.isFinite(entry) ? entry : undefined;
  };

  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    scope,
    state,
    level: Math.floor(level),
    ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
    ...(nullableNumber("lastRateLimitAt") === undefined
      ? {}
      : { lastRateLimitAt: nullableNumber("lastRateLimitAt") as number }),
    ...(typeof record.lastRateLimitType === "string"
      ? { lastRateLimitType: record.lastRateLimitType }
      : {}),
    ...(isResetSource(record.lastResetSource) ? { lastResetSource: record.lastResetSource } : {}),
    ...(nullableNumber("lastHealthyAt") === undefined
      ? {}
      : { lastHealthyAt: nullableNumber("lastHealthyAt") as number }),
  };
}

function isResetSource(value: unknown): value is ResetSource {
  return (
    value === "retry-after" ||
    value === "retry-after-ms" ||
    value === "x-ratelimit-reset" ||
    value === "x-ratelimit-reset-requests" ||
    value === "reset-timestamp" ||
    value === "backoff"
  );
}

/** Current state label, for logs and status output. */
export function healthState(health: HealthRecord, now: number): FreeState {
  if (health.state === "FREE_HEALTHY") return "FREE_HEALTHY";
  return inCooldown(health, now) ? "FREE_COOLDOWN" : "FREE_PROBE";
}

/** `8m`, `45s`, `1h2m` — human scale for logs and status output. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
