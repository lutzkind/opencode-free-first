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

/**
 * Why the free route is currently unavailable. A genuine provider rate limit
 * (`rate-limit`), OpenCode's free-tier eligibility gate (`free-route`), and a
 * transient provider/server availability failure (`transient-availability`)
 * are different causes with the same consequence: they share the one cooldown
 * mechanism, but diagnostics must never present one as the other.
 */
export type CooldownReason = "rate-limit" | "free-route" | "transient-availability";

/** How a managed session currently routes its model calls. */
export type SessionRoute = "PRIMARY" | "FALLBACK";

/** Why a session stopped being managed by free-first. */
export type OptOutReason = "manual-model-change" | "disabled";

export type LogLevel = "silent" | "error" | "info" | "debug";

/**
 * When the free route may be used.
 *
 * - `always-free-first` — the historical behaviour: prefer the free model
 *   whenever it is healthy, regardless of the paid route's price window.
 * - `peak-only` — spend free quota only while the configured paid fallback is
 *   in a verified DeepSeek PEAK window. Off-peak, weekends, and Chinese public
 *   holidays route straight to the paid fallback and never probe the free route.
 * - `off` — free-first routing is disabled; OpenCode's normal configured
 *   routing applies.
 */
export type FreeUsageMode = "always-free-first" | "peak-only" | "off";

/**
 * The canonical pricing classification owned by `opencode-offpeak`.
 *
 * `FLAT`, `UNTRACKED`, and `UNKNOWN` are deliberately distinct from `OFF_PEAK`:
 * `peak-only` only spends free quota in a positively classified `PEAK` window.
 */
export type PricingState = "PEAK" | "OFF_PEAK" | "FLAT" | "UNTRACKED" | "UNKNOWN";

export interface HealthRecord {
  readonly schemaVersion: number;
  readonly scope: string;
  readonly state: FreeState;
  /** Absolute epoch milliseconds. `undefined` when healthy. */
  readonly cooldownUntil?: number | undefined;
  /** Why the current cooldown was armed: a rate limit or the free-route gate. */
  readonly cooldownReason?: CooldownReason | undefined;
  /** Backoff ladder position, 0-based. */
  readonly level: number;
  readonly lastRateLimitAt?: number;
  readonly lastRateLimitType?: string;
  readonly lastResetSource?: ResetSource;
  readonly lastHealthyAt?: number;
  /**
   * Absolute time of the first recognised free-route rejection of the current
   * episode, for diagnostics ("route-rejected since when").
   */
  readonly routeRejectedAt?: number | undefined;
  /**
   * Consecutive transient availability failures (provider 5xx, structured
   * provider-internal, qualifying transport/timeout). Position on the bounded
   * transient backoff ladder. Kept strictly separate from the rate-limit ladder
   * (`level`), so a provider 500 can never masquerade as a quota event.
   */
  readonly transientFailures?: number | undefined;
  /** Absolute time of the last transient availability failure, for dedup. */
  readonly lastTransientAt?: number | undefined;
  /** Stable classification of the last transient failure, for diagnostics. */
  readonly lastTransientType?: string | undefined;
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

/**
 * An explicit free-usage mode chosen from the TUI or the control RPC.
 *
 * It lives in OpenCode's plugin storage (the same mechanism as the health and
 * session hints), not in the configuration file, so it survives a restart and
 * is shared by every plugin instance without a second configuration service.
 * Precedence is: persisted override > configured `freeUsageMode` > the
 * historical default (`always-free-first`).
 */
export interface ModeOverrideRecord {
  readonly schemaVersion: number;
  readonly mode: FreeUsageMode;
  readonly updatedAt: number;
}

/** Persisted shape version. Bump only with a migration. */
export const HEALTH_SCHEMA_VERSION = 1;
export const SESSION_SCHEMA_VERSION = 1;
export const MODE_SCHEMA_VERSION = 1;
export const HEALTH_STORAGE_KEY = "opencode-free-first/health-v1";
export const SESSION_STORAGE_KEY = "opencode-free-first/sessions-v1";
export const MODE_STORAGE_KEY = "opencode-free-first/mode-v1";

/**
 * User-facing names. `off` is deliberately never presented as just "Off":
 * `/offpeak off` is a different control owned by the neighbouring plugin.
 */
export function freeUsageModeLabel(mode: FreeUsageMode): string {
  switch (mode) {
    case "always-free-first":
      return "Free First";
    case "peak-only":
      return "Peak Only";
    case "off":
      return "Free-first disabled";
  }
}

/**
 * Accept the user-facing aliases as well as the implementation names. The TUI
 * and the RPC both use this so `/free-first mode free-first` and
 * `set-mode always-free-first` mean the same thing.
 */
export function parseFreeUsageMode(value: unknown): FreeUsageMode | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "free-first":
    case "always-free-first":
      return "always-free-first";
    case "peak-only":
      return "peak-only";
    case "disabled":
    case "off":
      return "off";
    default:
      return undefined;
  }
}
