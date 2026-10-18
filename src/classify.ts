/**
 * Rate-limit classification and reset-metadata extraction.
 *
 * Classification is deliberately conservative. A free-model failure is acted
 * on only after *positive* identification, and each cause keeps its own
 * category so diagnostics never conflate them:
 *
 *   - `classifyFreeLimit` — exhaustion (429, structured rate-limit/quota,
 *     tightly scoped exhaustion wording). Everything else keeps its real
 *     failure type and stays visible.
 *   - `classifyFreeRouteRejection` — OpenCode's own free-tier eligibility gate
 *     on a real model request.
 *   - `classifyTransientAvailability` — the free route is *temporarily unable*
 *     to service an otherwise valid request: provider/server 5xx, OpenCode's
 *     structured `provider.internal`, structured provider timeouts, and the
 *     transport/connectivity failures OpenCode itself treats as transient.
 *
 * OpenCode 2.0.27+ classifies provider failures into structured types before a
 * retry hook runs (`provider.rate-limit`, `provider.quota`, `provider.auth`,
 * `provider.internal`, `provider.transport`, `provider.timeout`, …) and passes
 * the HTTP status plus the raw response body on the same object. Detection
 * therefore follows this priority order:
 *
 *   1. HTTP status `429`
 *   2. structured rate-limit type
 *   3. structured quota-exhaustion type
 *   4. tightly scoped known provider messages
 */

import type { ResetSource } from "./types.js";

export interface ProviderErrorView {
  readonly type?: string | undefined;
  /** OpenCode's internal discriminant, used for diagnostics only. */
  readonly tag?: string | undefined;
  readonly message?: string | undefined;
  readonly status?: number | undefined;
  readonly response?: { readonly body?: string } | undefined;
}

export type FreeLimitKind = "rate-limit" | "quota";

export interface Classification {
  readonly limited: boolean;
  readonly kind?: FreeLimitKind;
  /** Stable, loggable explanation of why the verdict was reached. */
  readonly reason: string;
}

const STRUCTURED_RATE_LIMIT = "provider.rate-limit";
const STRUCTURED_QUOTA = "provider.quota";

/**
 * Structured OpenCode error types that are explicitly *not* free-tier
 * exhaustion. When one of these is present it wins over every weaker signal so
 * a real fault is never hidden behind fallback behaviour.
 */
const NON_LIMIT_TYPES = new Set([
  "provider.auth",
  "provider.invalid-request",
  "provider.invalid-output",
  "provider.content-filter",
  "provider.transport",
  "provider.internal",
  "provider.unsupported-operation",
  "provider.no-route",
  "provider.timeout",
  "provider.unknown",
  "permission.rejected",
  "tool.execution",
  "unknown",
]);

/**
 * A phrasing that explicitly denies a limit. Checked before the positive
 * patterns so "the request was not rate limited" is never read as exhaustion.
 */
const NEGATED_LIMIT =
  /\b(?:not|never|without|isn'?t|aren'?t|wasn'?t)\b[^.;\n]{0,40}\brate[ _-]?limit|\brate[ _-]?limiter\b/i;

/** Messages that must never be read as free-tier exhaustion. */
const UNRELATED_MESSAGE =
  /(context (?:length|window|size)|maximum context|invalid (?:request|api key|model|parameter|argument)|unauthorized|authentication|forbidden|permission denied|internal server error|bad gateway|service unavailable|malformed|tool (?:execution )?failed|timed? ?out)/i;

/** Tightly scoped exhaustion phrasings. Each one requires an explicit signal. */
const LIMIT_MESSAGE: ReadonlyArray<{ readonly kind: FreeLimitKind; readonly pattern: RegExp }> = [
  { kind: "rate-limit", pattern: /\brate[ _-]?limit(?:ed)?\b/i },
  { kind: "rate-limit", pattern: /\brate[ _-]?limit exceeded\b/i },
  { kind: "rate-limit", pattern: /\btoo many requests\b/i },
  {
    kind: "rate-limit",
    pattern: /\brequests? per (?:second|minute|hour|day) (?:exceeded|reached)\b/i,
  },
  {
    kind: "rate-limit",
    pattern: /\b(?:you have )?(?:exceeded|hit|reached) (?:the )?rate limit\b/i,
  },
  { kind: "quota", pattern: /\bquota (?:exceeded|exhausted|reached)\b/i },
  {
    kind: "quota",
    pattern: /\b(?:daily|weekly|monthly|hourly) (?:limit|quota|allowance) (?:exceeded|reached)\b/i,
  },
  { kind: "quota", pattern: /\busage (?:limit|quota) (?:exceeded|reached)\b/i },
  { kind: "quota", pattern: /\b(?:insufficient|out of) (?:quota|credits?|balance)\b/i },
  { kind: "quota", pattern: /\bfree (?:tier|plan) (?:limit|quota) (?:exceeded|reached)\b/i },
];

/**
 * Classify a provider failure. Returns `limited: false` for anything that is
 * not a positive free-tier exhaustion signal.
 */
export function classifyFreeLimit(error: ProviderErrorView | undefined): Classification {
  if (!error) return { limited: false, reason: "no-error" };

  const type = typeof error.type === "string" ? error.type : undefined;
  const message = typeof error.message === "string" ? error.message : "";
  const status = typeof error.status === "number" ? error.status : undefined;

  if (status === 429) {
    return { limited: true, kind: "rate-limit", reason: "http-429" };
  }
  if (type === STRUCTURED_RATE_LIMIT) {
    return { limited: true, kind: "rate-limit", reason: "structured-rate-limit" };
  }
  if (type === STRUCTURED_QUOTA) {
    return { limited: true, kind: "quota", reason: "structured-quota" };
  }
  if (type !== undefined && NON_LIMIT_TYPES.has(type)) {
    return { limited: false, reason: `structured-${type}` };
  }
  if (message.length === 0) {
    return { limited: false, reason: type === undefined ? "no-signal" : `unclassified-${type}` };
  }
  if (UNRELATED_MESSAGE.test(message)) {
    return { limited: false, reason: "unrelated-message" };
  }
  if (NEGATED_LIMIT.test(message)) {
    return { limited: false, reason: "negated-limit" };
  }
  for (const entry of LIMIT_MESSAGE) {
    if (entry.pattern.test(message)) {
      return { limited: true, kind: entry.kind, reason: `message-${entry.kind}` };
    }
  }
  // The message was present but matched nothing: report that honestly rather
  // than claiming there was no signal at all.
  return {
    limited: false,
    reason: type === undefined ? "unclassified-message" : `unclassified-${type}`,
  };
}

/**
 * Outcome of an out-of-band recovery probe.
 *
 * - `limited` — the free model really is rate limited; block and back off.
 * - `transient` — the free route is temporarily unable to serve the request
 *   (provider 5xx, structured provider-internal, qualifying transport/timeout).
 *   The mechanism is working; the route is not. Block for the bounded
 *   transient backoff and let the existing recovery path try again.
 * - `unsupported` — the probe mechanism itself is refused for this model (for
 *   example OpenCode's free tier permits use only from its own agent loop).
 *   Retrying the probe every minute is pointless, so it backs off hard.
 * - `inconclusive` — anything else. Unknown, never *limited*: fail open and let
 *   the next real request decide.
 */
export type ProbeOutcome = "healthy" | "limited" | "transient" | "unsupported" | "inconclusive";

const UNSUPPORTED_TYPES = new Set([
  "provider.invalid-request",
  "provider.auth",
  "provider.no-route",
  "provider.unsupported-operation",
]);

/**
 * OpenCode's own gate on the free tier. The transient generation path is not
 * the agent loop, so the gateway refuses it; that is a property of the probe,
 * not of free-model health.
 */
const PROBE_PATH_REFUSED = /free tier can only be used from within opencode/i;

export function classifyProbeFailure(error: ProviderErrorView | undefined): ProbeOutcome {
  if (classifyFreeLimit(error).limited) return "limited";
  if (error === undefined) return "inconclusive";
  if (typeof error.message === "string" && PROBE_PATH_REFUSED.test(error.message)) {
    return "unsupported";
  }
  if (typeof error.tag === "string" && /unavailable|unsupported/i.test(error.tag)) {
    return "unsupported";
  }
  if (error.type !== undefined && UNSUPPORTED_TYPES.has(error.type)) return "unsupported";
  // The route is temporarily unable to serve the probe: not a verdict about the
  // probe mechanism, and not an unknown. Block for the bounded transient
  // backoff so waiting sessions stay on the fallback without thrashing.
  if (classifyTransientAvailability(error).transient) return "transient";
  return "inconclusive";
}

/**
 * The free-route eligibility gate as it arrives on a *real* OpenCode model
 * request (the agent loop, a title, or a compaction): OpenCode's gateway
 * refuses to serve the free model and states that free use is only permitted
 * from inside OpenCode, which is a transient upstream condition (legitimate
 * OpenCode users receive it too).
 *
 * This is classified separately from a rate limit for diagnosis and recovery:
 *
 *   - a genuine 429/quota signal is a *rate limit*: the ladder, the provider's
 *     reset metadata, and the rate-limit bookkeeping all apply;
 *   - this gate makes the free *route* temporarily unavailable: the same shared
 *     cooldown is armed with `reason: free-route`, managed work moves to the
 *     configured fallback for the bounded retry window, and the existing
 *     recovery path then tests the free route through a real request;
 *   - an ordinary 401/403, an invalid key, an unsupported provider/model, or a
 *     malformed request is an auth-or-config error: it stays visible and never
 *     triggers failover.
 *
 * The match is deliberately exact and scoped to the gate's own sentence, so a
 * generic authentication failure (including a plain `provider.auth` 403) is
 * never re-labelled as a free-route problem. `classifyFreeLimit` intentionally
 * keeps structured non-limit types winning over message phrases; this
 * classifier is consulted *only* for a real model request and only for this one
 * recognised gate.
 */
export interface FreeRouteRejection {
  readonly rejected: boolean;
  /** Stable, loggable explanation of why the verdict was reached. */
  readonly reason: string;
}

const FREE_ROUTE_GATE = /free tier can only be used from within opencode\b/i;

export function classifyFreeRouteRejection(
  error: ProviderErrorView | undefined,
): FreeRouteRejection {
  if (error === undefined) return { rejected: false, reason: "no-error" };
  const message = typeof error.message === "string" ? error.message : "";
  if (message.length > 0 && FREE_ROUTE_GATE.test(message)) {
    return { rejected: true, reason: "free-tier-provenance-gate" };
  }
  return { rejected: false, reason: "no-free-route-gate" };
}

/**
 * Transient free-route availability.
 *
 * The stable category for "the free route cannot currently serve an otherwise
 * valid request": provider/server 5xx, OpenCode's structured
 * `provider.internal` (which OpenCode 2.0.30 constructs for every HTTP status
 * >= 500, for `409`, and for provider-reported network-error finishes), the
 * structured provider timeout, and the transport/connectivity failures that
 * OpenCode itself treats as transient.
 *
 * This is deliberately separate from exhaustion: a provider 500 is not a quota
 * event, carries no reset metadata, and must never be presented as a rate
 * limit. It is also deliberately separate from request/account/configuration
 * defects: a `400`, an ordinary `401`/`403`, an invalid model, a content
 * filter, a context-length error, a tool failure, or a plugin bug stays
 * visible and never fails over.
 *
 * The transport predicate mirrors OpenCode 2.0.30's own transient-connectivity
 * test (its `shouldRetry`/`nn` walk: codes `ECONNRESET`, `ECONNREFUSED`,
 * `ETIMEDOUT`, `EPIPE`, `ConnectionRefused`, `ConnectionClosed`,
 * `FailedToOpenSocket`, any `UND_ERR_*`), because the plugin observes the
 * message, not the code. A transport failure is only classified when OpenCode
 * already labelled it `provider.transport`, so an unqualified message can
 * never reach the failover.
 */
export type TransientCategory = "server" | "timeout" | "transport";

export interface TransientClassification {
  readonly transient: boolean;
  readonly category?: TransientCategory;
  /** Stable, loggable explanation of why the verdict was reached. */
  readonly reason: string;
}

/** HTTP statuses that mean "the server could not serve this request now". */
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

/**
 * Structured OpenCode error types that explicitly deny a transient reading.
 * When one of these is present it wins over every weaker signal, so a real
 * fault is never hidden behind paid routing.
 */
const NON_TRANSIENT_TYPES = new Set([
  "provider.auth",
  "provider.invalid-request",
  "provider.invalid-output",
  "provider.content-filter",
  "provider.unsupported-operation",
  "provider.no-route",
  "provider.rate-limit",
  "provider.quota",
  "permission.rejected",
  "tool.execution",
  "unknown",
]);

/**
 * Transient connectivity codes, mirroring OpenCode's own transient test.
 * `UND_ERR_*` covers undici's socket/page errors.
 */
const TRANSIENT_TRANSPORT_CODE =
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|UND_ERR_[A-Z0-9_]+)\b/i;

/** Message phrases OpenCode treats as transient when a code is not preserved. */
const TRANSIENT_TRANSPORT_PHRASES: ReadonlyArray<{
  readonly slug: string;
  readonly phrase: string;
}> = [
  { slug: "fetch-failed", phrase: "fetch failed" },
  { slug: "failed-to-fetch", phrase: "failed to fetch" },
  { slug: "other-side-closed", phrase: "other side closed" },
  { slug: "socket-hang-up", phrase: "socket hang up" },
  { slug: "sse-read-timed-out", phrase: "sse read timed out" },
  { slug: "headers-timed-out", phrase: "response headers timed out" },
];

/**
 * A message that is only ever emitted for a dropped connection. Matched as the
 * whole message (trimmed, case-insensitive) because the word alone is too
 * broad to qualify.
 */
const TRANSIENT_TRANSPORT_EXACT = new Set(["terminated"]);

/**
 * A transport/timeout wording that qualifies even without a code: the
 * structured type already says the failure happened at the transport layer.
 */
const TRANSIENT_TIMEOUT_PHRASE = /\btimed out\b|\btimeout\b/i;

function matchTransientTransport(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) return undefined;
  const lowered = trimmed.toLowerCase();
  const code = TRANSIENT_TRANSPORT_CODE.exec(trimmed);
  if (code?.[1] !== undefined) return code[1].toLowerCase();
  for (const entry of TRANSIENT_TRANSPORT_PHRASES) {
    if (lowered.includes(entry.phrase)) return entry.slug;
  }
  if (TRANSIENT_TRANSPORT_EXACT.has(lowered)) return "terminated";
  if (TRANSIENT_TIMEOUT_PHRASE.test(trimmed)) return "timeout";
  return undefined;
}

export function classifyTransientAvailability(
  error: ProviderErrorView | undefined,
): TransientClassification {
  if (!error) return { transient: false, reason: "no-error" };

  const type = typeof error.type === "string" ? error.type : undefined;
  const message = typeof error.message === "string" ? error.message : "";
  const status = typeof error.status === "number" ? error.status : undefined;

  if (type !== undefined && NON_TRANSIENT_TYPES.has(type)) {
    return { transient: false, reason: `structured-${type}` };
  }
  if (type === "provider.timeout") {
    return { transient: true, category: "timeout", reason: "structured-timeout" };
  }
  // The concrete HTTP status is the most precise evidence, so it names the
  // classification when the provider supplied one.
  if (status !== undefined && TRANSIENT_HTTP_STATUSES.has(status)) {
    return { transient: true, category: "server", reason: `http-${status}` };
  }
  // OpenCode only constructs `provider.internal` for a server-side or
  // network-error path (HTTP >= 500, 409, or a network-error finish), so the
  // structured type alone is positive evidence.
  if (type === "provider.internal") {
    return { transient: true, category: "server", reason: "structured-provider-internal" };
  }
  // A definite client-side status is a request/account problem no matter what
  // the message looks like.
  if (status !== undefined && status >= 400 && status < 500) {
    return { transient: false, reason: `http-${status}` };
  }
  if (type === "provider.transport") {
    const match = matchTransientTransport(message);
    if (match !== undefined) {
      return { transient: true, category: "transport", reason: `transport-${match}` };
    }
    return { transient: false, reason: "transport-unqualified" };
  }
  return {
    transient: false,
    reason: type === undefined ? "no-signal" : `unclassified-${type}`,
  };
}

export interface ResetHint {
  readonly until: number;
  readonly source: ResetSource;
}

export interface ResetContext {
  readonly now: number;
  /** Response headers from the provider attempt, lower-cased keys. */
  readonly headers?: Record<string, string> | undefined;
  /** Raw provider error body, when OpenCode captured one. */
  readonly body?: string | undefined;
  /** Free-text provider message. */
  readonly message?: string | undefined;
}

/** Header names that carry an authoritative reset time or delay. */
const HEADER_ORDER: ReadonlyArray<{ readonly name: string; readonly source: ResetSource }> = [
  { name: "retry-after", source: "retry-after" },
  { name: "retry-after-ms", source: "retry-after-ms" },
  { name: "x-ratelimit-reset", source: "x-ratelimit-reset" },
  { name: "x-ratelimit-reset-requests", source: "x-ratelimit-reset-requests" },
  { name: "x-ratelimit-reset-after", source: "retry-after" },
];

/**
 * Extract an authoritative reset time from retry/reset metadata.
 *
 * Prefers `Retry-After`, then explicit reset headers, then a structured reset
 * timestamp in the provider payload, then a trustworthy reset phrase in the
 * message. Returns `undefined` when the provider gives no reset information,
 * which selects the bounded backoff ladder instead.
 */
export function extractReset(context: ResetContext): ResetHint | undefined {
  const headers = context.headers ?? {};

  for (const entry of HEADER_ORDER) {
    const raw = headers[entry.name];
    if (raw === undefined) continue;
    const until =
      entry.source === "retry-after-ms"
        ? parseMilliseconds(raw, context.now)
        : parseResetValue(raw, context.now);
    if (until !== undefined) return { until, source: entry.source };
  }

  const body = parseBody(context.body);
  if (body !== undefined) {
    const until = parseResetValue(body, context.now);
    if (until !== undefined) return { until, source: "reset-timestamp" };
  }

  if (typeof context.message === "string" && context.message.length > 0) {
    const fromRelative = parseRelativePhrase(context.message, context.now);
    if (fromRelative !== undefined) return { until: fromRelative, source: "retry-after" };
    const fromAbsolute = parseAbsolutePhrase(context.message, context.now);
    if (fromAbsolute !== undefined) return { until: fromAbsolute, source: "reset-timestamp" };
  }

  return undefined;
}

/**
 * Parse a millisecond delay, tolerating a Go duration or an absolute instant.
 * A negative or unparseable value yields `undefined`.
 */
export function parseMilliseconds(raw: string, now: number): number | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  const go = parseGoDuration(value);
  if (go !== undefined) return now + go;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  if (numeric === 0) return now;
  if (numeric >= 1e12) return numeric; // epoch milliseconds
  if (numeric >= 1e9) return numeric * 1000; // epoch seconds
  return now + numeric;
}

/** Parse a duration (seconds, milliseconds, or Go-style `1m30s`). */
export function parseDelay(raw: string, now: number): number | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;

  const go = parseGoDuration(value);
  if (go !== undefined) return now + go;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  if (numeric === 0) return now;
  // A `Retry-After` header is defined in whole seconds. Very large values are
  // interpreted as an already-millisecond delay because providers that emit
  // `retry-after-ms`-style numbers on the seconds header would otherwise park
  // the free model for days.
  if (numeric > 86_400) return now + numeric;
  return now + numeric * 1000;
}

/**
 * Parse a reset value that is either a delay or an absolute instant. Accepts
 * HTTP-date, ISO-8601, epoch seconds, and epoch milliseconds.
 */
export function parseResetValue(raw: string, now: number): number | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;

  const go = parseGoDuration(value);
  if (go !== undefined) return now + go;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^[+-]?[\d.]+$/.test(value)) {
    if (numeric >= 1e12) return numeric; // epoch milliseconds
    if (numeric >= 1e9) return numeric * 1000; // epoch seconds
    if (numeric >= 0) return now + numeric * 1000; // delay in seconds
    return undefined;
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    // A date header that already passed still yields a usable upper bound.
    return parsed;
  }
  return undefined;
}

const GO_DURATION =
  /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/;

function parseGoDuration(value: string): number | undefined {
  if (!/[hms]/.test(value)) return undefined;
  const match = GO_DURATION.exec(value);
  if (!match || match[0].length === 0) return undefined;
  const [, hours, minutes, seconds, millis] = match;
  if (
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined &&
    millis === undefined
  ) {
    return undefined;
  }
  const total =
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1_000 +
    Number(millis ?? 0);
  return Number.isFinite(total) ? total : undefined;
}

const RESET_BODY_KEYS = [
  "retry_after",
  "retryAfter",
  "retry_after_ms",
  "reset",
  "reset_at",
  "resetAt",
  "resets_at",
  "resetsAt",
  "reset_in",
  "resetIn",
];

function parseBody(body: string | undefined): string | undefined {
  if (body === undefined || body.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const phrase =
      /"?(?:retry_after|retryAfter|reset_at|resetAt|reset|resets_at)"?\s*[:=]\s*"?([^",}\s]+)"?/.exec(
        body,
      );
    return phrase?.[1];
  }
  for (const container of [parsed, (parsed as { error?: unknown })?.error]) {
    const found = findResetKey(container);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findResetKey(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of RESET_BODY_KEYS) {
    const entry = record[key];
    if (typeof entry === "string" || typeof entry === "number") return String(entry);
  }
  for (const entry of Object.values(record)) {
    const found = findResetKey(entry, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const RELATIVE_PHRASE =
  /\b(?:try again|retry|resets?|available|come back)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|m|hours?|h)\b/i;

function parseRelativePhrase(message: string, now: number): number | undefined {
  const match = RELATIVE_PHRASE.exec(message);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = unit.startsWith("ms")
    ? 1
    : unit.startsWith("s")
      ? 1_000
      : unit.startsWith("m")
        ? 60_000
        : 3_600_000;
  return now + amount * multiplier;
}

const ABSOLUTE_PHRASE =
  /\b(?:resets?|reset at|available at|try again at)\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[^\s,;)]+)/i;

function parseAbsolutePhrase(message: string, _now: number): number | undefined {
  const match = ABSOLUTE_PHRASE.exec(message);
  if (!match?.[1]) return undefined;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}
