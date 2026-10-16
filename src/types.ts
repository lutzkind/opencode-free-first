/**
 * Shared types for opencode-free-first.
 *
 * The plugin owns exactly one concern: whether the configured free model is
 * usable right now, and how a session moves between the free model and the
 * configured fallback model around a genuine free-tier rate limit. It never
 * schedules, delays, or prices paid work; that stays with whatever cost/time
 * policy plugin the user also runs.
 */

/** A concrete model selection. `variant` is the OpenCode model variant id. */
export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

/** `provider/model` display form, used for logs and persisted scope. */
export function modelRefKey(ref: Pick<ModelRef, "providerID" | "id">): string {
  return `${ref.providerID}/${ref.id}`;
}

export function sameModel(
  left: Pick<ModelRef, "providerID" | "id"> | undefined,
  right: Pick<ModelRef, "providerID" | "id"> | undefined,
): boolean {
  if (!left || !right) return false;
  return left.providerID === right.providerID && left.id === right.id;
}

/**
 * Free-model availability. Deliberately small: the plugin only needs to know
 * whether the free model may be used and, if not, until when.
 */
export type FreeState = "FREE_HEALTHY" | "FREE_COOLDOWN" | "FREE_PROBE";

/** How a managed session currently routes its model calls. */
export type SessionRoute = "PRIMARY" | "FALLBACK";

/** Why a session stopped being managed by free-first. */
export type OptOutReason = "manual-model-change" | "disabled";

export type LogLevel = "silent" | "error" | "info" | "debug";

export interface HealthRecord {
  readonly schemaVersion: number;
  readonly scope: string;
  readonly state: FreeState;
  /** Absolute epoch milliseconds. `undefined` when healthy. */
  readonly cooldownUntil?: number | undefined;
  /** Backoff ladder position, 0-based. */
  readonly level: number;
  readonly lastRateLimitAt?: number;
  readonly lastRateLimitType?: string;
  readonly lastResetSource?: ResetSource;
  readonly lastHealthyAt?: number;
  /**
   * Absolute time before which the recovery probe must stay quiet. A probe
   * back-off never blocks the free model; it only schedules the next attempt.
   */
  readonly probeBackoffUntil?: number | undefined;
  /** Consecutive inconclusive probes, used to escalate the probe back-off. */
  readonly inconclusiveProbes?: number | undefined;
  /** Why the last probe was inconclusive, for diagnostics. */
  readonly lastProbeOutcome?: string | undefined;
}

export type ResetSource =
  | "retry-after"
  | "retry-after-ms"
  | "x-ratelimit-reset"
  | "x-ratelimit-reset-requests"
  | "reset-timestamp"
  | "backoff";

export interface SessionRecord {
  /** Whether free-first manages this session's model routing. */
  readonly managed: boolean;
  readonly route: SessionRoute;
  readonly updatedAt: number;
  readonly optOut?: OptOutReason;
}

export interface SessionDocument {
  readonly schemaVersion: number;
  readonly sessions: Record<string, SessionRecord>;
}

/** Persisted shape version. Bump only with a migration. */
export const HEALTH_SCHEMA_VERSION = 1;
export const SESSION_SCHEMA_VERSION = 1;
export const HEALTH_STORAGE_KEY = "opencode-free-first/health-v1";
export const SESSION_STORAGE_KEY = "opencode-free-first/sessions-v1";
