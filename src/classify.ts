/**
 * Rate-limit classification and reset-metadata extraction.
 *
 * Classification is deliberately conservative. Free-tier rate limits are the
 * only thing this plugin reacts to, so an error must be *positively*
 * identified. Everything else keeps its real failure type and stays visible:
 * auth failures, invalid requests, content filters, tool failures, transport
 * errors, provider 5xx, and plugin bugs are never re-labelled as exhaustion.
 *
 * OpenCode 2.0.27 classifies provider failures into structured types before a
 * retry hook runs (`provider.rate-limit`, `provider.quota`, `provider.auth`,
 * `provider.invalid-request`, `provider.internal`, …) and passes the HTTP
 * status plus the raw response body on the same object. Detection therefore
 * follows this priority order:
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
 * - `unsupported` — the probe mechanism itself is refused for this model (for
 *   example OpenCode's free tier permits use only from its own agent loop).
 *   Retrying the probe every minute is pointless, so it backs off hard.
 * - `inconclusive` — anything else. Unknown, never *limited*: fail open and let
 *   the next real request decide.
 */
export type ProbeOutcome = "healthy" | "limited" | "unsupported" | "inconclusive";

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
  return "inconclusive";
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
