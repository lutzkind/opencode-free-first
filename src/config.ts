/**
 * Configuration resolution.
 *
 * Values come from the OpenCode plugin entry options
 * (`plugins: [{ package: "opencode-free-first", options: { … } }]`) merged over
 * an optional JSON config file for users who prefer a file. Everything has a
 * working default so an empty configuration is valid.
 *
 * Invalid configuration disables the plugin instead of guessing: free-first
 * must never make OpenCode unusable, and an unresolvable free-model route is
 * worse than no free-first routing at all.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { FreeUsageMode, LogLevel, ModelRef } from "./types.js";

export interface FreeFirstConfig {
  readonly enabled: boolean;
  readonly primary: ModelRef;
  /** Explicit fallback. When absent the session's previous model is used. */
  readonly fallback?: ModelRef;
  /** Publish the primary model as OpenCode's default selection. */
  readonly preferAsDefault: boolean;
  /**
   * Adopt sessions already routed through the fallback model. Off by default so
   * a public install never moves a session the user left on a paid route; an
   * operator who wants the free model preferred everywhere can switch it on.
   */
  readonly adoptFallbackSessions: boolean;
  /** Stop managing a session whose model the user changed by hand. */
  readonly respectExplicitModelSelection: boolean;
  /** Recovery speed: let the next real model call test the free model. */
  readonly passiveRecovery: boolean;
  /** Recovery speed: probe the free model out of band when needed. */
  readonly probe: boolean;
  /** Reclaim a task parked by another plugin's pre-model hold. */
  readonly parkPreemption: boolean;
  /** Bounded backoff ladder used when the provider gives no reset time. */
  readonly backoffMs: readonly number[];
  readonly maxCooldownMs: number;
  readonly jitterRatio: number;
  /** Delay used for the failover retry so the very next attempt is cheap. */
  readonly failoverRetryDelayMs: number;
  /**
   * Window in which a second free-model rate-limit signal counts as the same
   * limit. Concurrent requests for one session (for example the automatic title
   * and the agent loop) observe the same provider window; without this the
   * backoff ladder would advance twice for one limit.
   */
  readonly duplicateLimitWindowMs: number;
  /** Probe request budget. */
  readonly probePrompt: string;
  readonly probeMaxTokens: number;
  /**
   * How long to stop probing after the host refuses the probe path itself.
   * Retrying a structurally refused request every minute is pointless, and
   * passive recovery already covers the case.
   */
  readonly probeUnsupportedBackoffMs: number;
  /**
   * How long the free route stays off after OpenCode's own free-tier
   * eligibility gate refused a real model request. The gate carries no
   * provider reset, so this is the bounded window before the existing recovery
   * path may test the free route again through a real request.
   */
  readonly routeRejectRetryMs: number;
  /** How long a prepared-but-undispatched request counts as parked. */
  readonly parkGraceMs: number;
  /** Window in which a model selection is attributed to this plugin. */
  readonly switchConfirmMs: number;
  readonly continuationText: string;
  readonly cooldownScope: "shared" | "session";
  /** Upper bound on remembered sessions. Oldest entries are evicted. */
  readonly sessionLimit: number;
  readonly logLevel: LogLevel;
  /**
   * When the free route may be used. Defaults to `always-free-first`, so an
   * existing installation keeps its behaviour until it opts into `peak-only`.
   * An explicit mode saved from the TUI or the control RPC overrides this
   * configured value; see ARCHITECTURE.md, "Mode control surface".
   */
  readonly freeUsageMode: FreeUsageMode;
}

export const DEFAULT_PRIMARY: ModelRef = {
  providerID: "opencode",
  id: "deepseek-v4.1-flash-free",
};

export const DEFAULT_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 900_000] as const;

/** Matches the continuation OpenCode itself uses for interrupted work. */
export const DEFAULT_CONTINUATION_TEXT =
  "The previous response was interrupted. Continue from where you left off without repeating completed content.";

export const DEFAULT_CONFIG: FreeFirstConfig = {
  enabled: true,
  primary: DEFAULT_PRIMARY,
  preferAsDefault: true,
  adoptFallbackSessions: false,
  respectExplicitModelSelection: true,
  passiveRecovery: true,
  probe: true,
  parkPreemption: true,
  backoffMs: DEFAULT_BACKOFF_MS,
  maxCooldownMs: 900_000,
  jitterRatio: 0.1,
  failoverRetryDelayMs: 250,
  duplicateLimitWindowMs: 5_000,
  probePrompt: "Reply with the single word: pong",
  probeMaxTokens: 8,
  probeUnsupportedBackoffMs: 21_600_000,
  routeRejectRetryMs: 300_000,
  parkGraceMs: 5_000,
  switchConfirmMs: 10_000,
  continuationText: DEFAULT_CONTINUATION_TEXT,
  cooldownScope: "shared",
  sessionLimit: 200,
  logLevel: "info",
  freeUsageMode: "always-free-first",
};

export interface ResolvedConfig {
  readonly config: FreeFirstConfig;
  readonly error?: string;
  readonly source?: string;
}

export interface ResolveInput {
  readonly options: Readonly<Record<string, unknown>> | undefined;
  /** Environment used to locate the optional config file. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Reads a JSON file; injected so tests stay hermetic. */
  readonly readFile?: (file: string) => string | undefined;
}

/** Path of the optional global config file. */
export function configFilePath(env: Readonly<Record<string, string | undefined>>): string {
  const base = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? homedir(), ".config");
  return path.join(base, "opencode", "free-first.json");
}

/**
 * Resolve the effective configuration. Never throws: an unreadable or invalid
 * document yields the defaults plus an `error` so the caller can disable the
 * plugin and report the problem.
 */
export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const env = input.env ?? process.env;
  const file = configFilePath(env);
  const readFile = input.readFile ?? defaultReadFile;

  let fromFile: Record<string, unknown> = {};
  let source: string | undefined;
  const raw = readFile(file);
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { config: DEFAULT_CONFIG, error: `${file} must contain a JSON object` };
      }
      const nested = (parsed as { freeFirst?: unknown }).freeFirst;
      fromFile = (nested !== null && typeof nested === "object" ? nested : parsed) as Record<
        string,
        unknown
      >;
      source = file;
    } catch (error) {
      return {
        config: DEFAULT_CONFIG,
        error: `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const merged = { ...fromFile, ...(input.options ?? {}) };
  const validated = validateConfig(merged);
  if (validated.error !== undefined) {
    return { config: DEFAULT_CONFIG, error: validated.error, ...(source ? { source } : {}) };
  }
  return { config: validated.config, ...(source ? { source } : {}) };
}

export interface ValidationResult {
  readonly config: FreeFirstConfig;
  readonly error?: string;
}

/** Thrown by field validators and converted into a `ValidationResult` error. */
class ConfigValidationError extends Error {}

function fail(message: string): never {
  throw new ConfigValidationError(message);
}

/**
 * Validate a raw configuration object. Exported for tests and so the plugin can
 * report exactly which field is wrong. Never throws: an invalid document yields
 * the default configuration plus an `error`.
 */
export function validateConfig(raw: Record<string, unknown>): ValidationResult {
  try {
    return { config: buildConfig(raw) };
  } catch (error) {
    if (error instanceof ConfigValidationError)
      return { config: DEFAULT_CONFIG, error: error.message };
    return {
      config: DEFAULT_CONFIG,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildConfig(raw: Record<string, unknown>): FreeFirstConfig {
  const config: { -readonly [K in keyof FreeFirstConfig]: FreeFirstConfig[K] } = {
    ...DEFAULT_CONFIG,
  };

  if ("enabled" in raw) config.enabled = bool(raw.enabled, "enabled");

  if (raw.primary !== undefined && raw.primary !== null) {
    config.primary = modelRef(raw.primary, "primary");
  }
  if (raw.primaryModel !== undefined && raw.primaryModel !== null) {
    config.primary = modelRef(raw.primaryModel, "primaryModel");
  }
  if (raw.fallback !== undefined && raw.fallback !== null) {
    config.fallback = modelRef(raw.fallback, "fallback");
  }
  if (raw.fallbackModel !== undefined && raw.fallbackModel !== null) {
    config.fallback = modelRef(raw.fallbackModel, "fallbackModel");
  }

  for (const key of [
    "preferAsDefault",
    "adoptFallbackSessions",
    "respectExplicitModelSelection",
    "passiveRecovery",
    "parkPreemption",
  ] as const) {
    if (key in raw) config[key] = bool(raw[key], key);
  }
  if ("probe" in raw) config.probe = bool(raw.probe, "probe");
  if ("recoveryProbe" in raw) config.probe = bool(raw.recoveryProbe, "recoveryProbe");

  if ("backoffMs" in raw) {
    const ladder = numberList(raw.backoffMs, "backoffMs", { min: 250, max: 86_400_000 });
    if (ladder.length === 0) fail("backoffMs must contain at least one delay");
    config.backoffMs = ladder;
  }

  const maxCooldownMs = boundedNumber(raw.maxCooldownMs, "maxCooldownMs", 0, 86_400_000);
  if (maxCooldownMs !== undefined) config.maxCooldownMs = maxCooldownMs;

  const jitterRatio = boundedNumber(raw.jitterRatio, "jitterRatio", 0, 1);
  if (jitterRatio !== undefined) config.jitterRatio = jitterRatio;

  const failoverRetryDelayMs = boundedNumber(
    raw.failoverRetryDelayMs,
    "failoverRetryDelayMs",
    0,
    60_000,
  );
  if (failoverRetryDelayMs !== undefined) config.failoverRetryDelayMs = failoverRetryDelayMs;

  const duplicateLimitWindowMs = boundedNumber(
    raw.duplicateLimitWindowMs,
    "duplicateLimitWindowMs",
    0,
    600_000,
  );
  if (duplicateLimitWindowMs !== undefined) config.duplicateLimitWindowMs = duplicateLimitWindowMs;

  const probeUnsupportedBackoffMs = boundedNumber(
    raw.probeUnsupportedBackoffMs,
    "probeUnsupportedBackoffMs",
    60_000,
    86_400_000,
  );
  if (probeUnsupportedBackoffMs !== undefined) {
    config.probeUnsupportedBackoffMs = probeUnsupportedBackoffMs;
  }

  const routeRejectRetryMs = boundedNumber(
    raw.routeRejectRetryMs,
    "routeRejectRetryMs",
    1_000,
    86_400_000,
  );
  if (routeRejectRetryMs !== undefined) config.routeRejectRetryMs = routeRejectRetryMs;

  const parkGraceMs = boundedNumber(raw.parkGraceMs, "parkGraceMs", 500, 600_000);
  if (parkGraceMs !== undefined) config.parkGraceMs = parkGraceMs;

  const switchConfirmMs = boundedNumber(raw.switchConfirmMs, "switchConfirmMs", 0, 600_000);
  if (switchConfirmMs !== undefined) config.switchConfirmMs = switchConfirmMs;

  const probeMaxTokens = boundedNumber(raw.probeMaxTokens, "probeMaxTokens", 1, 4_096);
  if (probeMaxTokens !== undefined) config.probeMaxTokens = probeMaxTokens;

  const sessionLimit = boundedNumber(raw.sessionLimit, "sessionLimit", 1, 10_000);
  if (sessionLimit !== undefined) config.sessionLimit = Math.floor(sessionLimit);

  config.probePrompt = nonEmptyString(raw.probePrompt, "probePrompt", config.probePrompt);
  config.continuationText = nonEmptyString(
    raw.continuationText,
    "continuationText",
    config.continuationText,
  );

  if ("cooldownScope" in raw) {
    if (raw.cooldownScope !== "shared" && raw.cooldownScope !== "session") {
      fail('cooldownScope must be "shared" or "session"');
    }
    config.cooldownScope = raw.cooldownScope as "shared" | "session";
  }

  if ("logLevel" in raw) {
    const level = raw.logLevel;
    if (level !== "silent" && level !== "error" && level !== "info" && level !== "debug") {
      fail('logLevel must be one of "silent", "error", "info", "debug"');
    }
    config.logLevel = level;
  }

  if ("freeUsageMode" in raw) {
    const mode = raw.freeUsageMode;
    if (mode !== "always-free-first" && mode !== "peak-only" && mode !== "off") {
      fail('freeUsageMode must be "always-free-first", "peak-only", or "off"');
    }
    config.freeUsageMode = mode;
  }
  // `peak-only` consumes the fallback's verified pricing classification, so a
  // concrete paid route is required; the session-previous heuristic cannot be
  // priced ahead of time.
  if (config.freeUsageMode === "peak-only" && config.fallback === undefined) {
    fail('freeUsageMode "peak-only" requires an explicit fallback model');
  }

  return config;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value;
}

function boundedNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be a number`);
  if (value < min || value > max) fail(`${field} must be between ${min} and ${max}`);
  return value;
}

function numberList(
  value: unknown,
  field: string,
  bounds: { readonly min: number; readonly max: number },
): number[] {
  if (!Array.isArray(value)) fail(`${field} must be an array of numbers`);
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      fail(`${field} must contain only numbers`);
    }
    if (entry < bounds.min || entry > bounds.max) {
      fail(`${field} entries must be between ${bounds.min} and ${bounds.max}`);
    }
    out.push(entry);
  }
  return out;
}

function nonEmptyString(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Accepts `{ providerID, id | modelID, variant }`, `{ provider, model }`, or the
 * `"provider/model"` string form. `variant` is optional everywhere.
 */
function modelRef(value: unknown, field: string): ModelRef {
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) fail(`${field} must be "providerID/modelID"`);
    return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object or "providerID/modelID"`);
  }
  const record = value as Record<string, unknown>;
  const providerID = record.providerID ?? record.provider;
  const id = record.id ?? record.modelID ?? record.model;
  if (typeof providerID !== "string" || providerID.length === 0) {
    fail(`${field}.providerID must be a non-empty string`);
  }
  if (typeof id !== "string" || id.length === 0) {
    fail(`${field}.id must be a non-empty string`);
  }
  const variant = record.variant;
  if (variant !== undefined && (typeof variant !== "string" || variant.length === 0)) {
    fail(`${field}.variant must be a non-empty string`);
  }
  return { providerID, id, ...(typeof variant === "string" ? { variant } : {}) };
}

function defaultReadFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
