import type { LogLevel } from "./types.js";

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 };

export interface Logger {
  error(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  debug(message: string, detail?: Record<string, unknown>): void;
  /** True when `level` would be emitted; used to skip expensive detail building. */
  enabled(level: LogLevel): boolean;
}

/**
 * Structured, prefixed logger. Every field is redacted through `scrub` so a
 * provider error body, header map, or configuration value cannot leak a
 * credential into the log stream.
 */
export function createLogger(level: LogLevel, sink?: (...args: unknown[]) => void): Logger {
  const write = sink ?? console.error;
  const threshold = RANK[level] ?? RANK.info;
  const emit = (at: LogLevel, message: string, detail?: Record<string, unknown>): void => {
    if ((RANK[at] ?? 0) > threshold || threshold === 0) return;
    const payload = detail === undefined ? undefined : scrub(detail);
    if (payload === undefined) write(`[opencode-free-first] ${message}`);
    else write(`[opencode-free-first] ${message}`, payload);
  };
  return {
    error: (message, detail) => emit("error", message, detail),
    info: (message, detail) => emit("info", message, detail),
    debug: (message, detail) => emit("debug", message, detail),
    enabled: (at) => (RANK[at] ?? 0) <= threshold && threshold > 0,
  };
}

const SECRET_KEY = /(key|token|secret|password|authorization|cookie|credential)/i;
const MAX_STRING = 200;

/**
 * Redact anything that looks like a credential and bound string length so a
 * provider message cannot dump a prompt or a header value into a log line.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (typeof value === "string") return bound(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.slice(0, 10).map((entry) => scrub(entry, depth + 1));
  if (typeof value !== "object") return String(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (key === "body" || key === "response" || key === "headers") {
      out[key] = "[omitted]";
      continue;
    }
    out[key] = scrub(entry, depth + 1);
  }
  return out;
}

function bound(value: string): string {
  if (value.length <= MAX_STRING) return value;
  return `${value.slice(0, MAX_STRING)}…(${value.length} chars)`;
}
