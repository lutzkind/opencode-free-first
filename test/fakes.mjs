/**
 * Deterministic test doubles and fixtures for opencode-free-first.
 *
 * Provider exhaustion is injected, never provoked: every scenario in the test
 * suite runs against these fakes so no real free-tier quota is consumed.
 */

import { DEFAULT_CONFIG } from "../dist/config.js";

export const FREE = { providerID: "fake", id: "fake-free" };
export const PAID = { providerID: "fake", id: "fake-paid" };
export const OTHER = { providerID: "other", id: "other-model" };

/** Deterministic clock with explicit timer control. */
export class FakeClock {
  #now;
  #timers = new Map();
  #next = 1;

  constructor(now = 1_700_000_000_000) {
    this.#now = now;
  }

  now() {
    return this.#now;
  }

  setTimeout(callback, delayMs) {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(handle) {
    this.#timers.delete(handle);
  }

  /** Advance time and run every timer that becomes due, in order. */
  async advance(ms) {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at);
      if (due.length === 0) break;
      const [id, timer] = due[0];
      this.#timers.delete(id);
      this.#now = Math.max(this.#now, timer.at);
      timer.callback();
      await drain();
    }
    this.#now = target;
    await drain();
  }

  /** Run only the microtask queue. */
  async flush() {
    await drain();
  }

  /** Move the clock without firing timers. */
  jump(ms) {
    this.#now += ms;
  }

  get pendingTimers() {
    return this.#timers.size;
  }
}

export function drain() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** In-memory plugin storage. */
export class FakeStorage {
  #data = new Map();
  writes = 0;

  constructor(initial = {}) {
    for (const [key, value] of Object.entries(initial)) this.#data.set(key, value);
  }

  async get(key) {
    return this.#data.get(key);
  }

  async set(key, value) {
    this.writes += 1;
    this.#data.set(key, structuredClone(value));
  }

  async remove(key) {
    this.writes += 1;
    this.#data.delete(key);
  }

  plain() {
    return Object.fromEntries(this.#data);
  }
}

/** Session driver that records every mutation. */
export class FakeSessions {
  calls = [];
  models = new Map();
  #switchErrors = new Map();
  #getErrors = new Set();

  constructor(models = {}) {
    for (const [sessionID, model] of Object.entries(models)) this.models.set(sessionID, model);
  }

  failSwitch(sessionID, times = 1) {
    this.#switchErrors.set(sessionID, times);
  }

  failGet(sessionID) {
    this.#getErrors.add(sessionID);
  }

  async switchModel({ sessionID, model }) {
    this.calls.push({ type: "switchModel", sessionID, model });
    const remaining = this.#switchErrors.get(sessionID) ?? 0;
    if (remaining > 0) {
      this.#switchErrors.set(sessionID, remaining - 1);
      throw new Error("switchModel failed");
    }
    this.models.set(sessionID, model);
  }

  async synthetic({ sessionID, text, delivery, resume }) {
    this.calls.push({ type: "synthetic", sessionID, text, delivery, resume });
  }

  async interrupt({ sessionID }) {
    this.calls.push({ type: "interrupt", sessionID });
    return { interrupted: true };
  }

  async wait({ sessionID }) {
    this.calls.push({ type: "wait", sessionID });
  }

  async get({ sessionID }) {
    if (this.#getErrors.has(sessionID)) throw new Error("session get failed");
    this.calls.push({ type: "get", sessionID });
    const model = this.models.get(sessionID);
    return model === undefined ? {} : { model };
  }

  of(type) {
    return this.calls.filter((call) => call.type === type);
  }
}

/**
 * The neighbour plugin's hold-cancellation port, as opencode-free-first sees it.
 * `result` is what the neighbour answers; `fail` models an absent or older
 * plugin that does not implement the capability at all.
 */
export class FakePaidHolds {
  requests = [];
  #result;
  #fail;
  #capability = "unknown";
  #accepted = 0;
  #committed = 0;
  #unavailable = 0;

  constructor(
    result = { cancelled: true, state: "refused", model: "fake/fake-paid" },
    fail = false,
  ) {
    this.#result = result;
    this.#fail = fail;
  }

  async cancel({ sessionID }) {
    this.requests.push({ sessionID });
    if (this.#fail) {
      this.#capability = "unavailable";
      this.#unavailable += 1;
      return undefined;
    }
    this.#capability = "available";
    if (this.#result?.cancelled === true) this.#accepted += 1;
    else this.#committed += 1;
    return this.#result;
  }

  capability() {
    return this.#capability;
  }

  calls() {
    return { accepted: this.#accepted, committed: this.#committed, unavailable: this.#unavailable };
  }
}

/** Canonical pricing classifier double used by peak-only tests. */
export class FakePricing {
  calls = [];
  state = "PEAK";
  nextTransition;
  error;
  #capability = "available";

  constructor(state = "PEAK") {
    this.state = state;
  }

  set(state, nextTransition) {
    this.state = state;
    this.nextTransition = nextTransition;
  }

  async evaluate(input) {
    this.calls.push({ ...input });
    if (this.error !== undefined) {
      this.#capability = "unavailable";
      throw this.error;
    }
    return {
      state: this.state,
      allowed: this.state === "PEAK",
      policyID: "fake-policy",
      ...(this.nextTransition === undefined ? {} : { nextTransition: this.nextTransition }),
    };
  }

  capability() {
    return this.#capability;
  }
}

/** Transient generation port used for recovery probes. */
export class FakeGenerate {
  calls = [];
  response = { text: "pong" };
  error;

  async text(input) {
    this.calls.push(input);
    if (this.error !== undefined) throw this.error;
    return this.response;
  }
}

export function recorder() {
  const lines = [];
  const push = (level) => (message, detail) => lines.push({ level, message, detail });
  return {
    lines,
    logger: {
      error: push("error"),
      info: push("info"),
      debug: push("debug"),
      enabled: () => true,
    },
    messages() {
      return lines.map((line) => line.message);
    },
    has(fragment) {
      return lines.some((line) => line.message.includes(fragment));
    },
    detailFor(fragment) {
      return lines.find((line) => line.message.includes(fragment))?.detail;
    },
    lastDetailFor(fragment) {
      const matches = lines.filter((line) => line.message.includes(fragment));
      return matches[matches.length - 1]?.detail;
    },
  };
}

/** A 429 failure shaped like the OpenCode provider error contract. */
export function rateLimitError(overrides = {}) {
  return {
    type: "provider.rate-limit",
    message: "Rate limit exceeded. Please try again later.",
    status: 429,
    ...overrides,
  };
}

/**
 * OpenCode's own free-tier eligibility gate, shaped exactly as the live
 * incident delivered it: a 403 authentication-class refusal carrying the free
 * tier's provenance sentence. A real OpenCode model request is the only place
 * this classifies as a free-route rejection.
 */
export const FREE_ROUTE_GATE_MESSAGE =
  "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.";

export function freeRouteGateError(overrides = {}) {
  return {
    type: "provider.auth",
    message: FREE_ROUTE_GATE_MESSAGE,
    status: 403,
    ...overrides,
  };
}

/** An ordinary authentication failure that must never trigger failover. */
export function authError(overrides = {}) {
  return {
    type: "provider.auth",
    message: "Invalid API key provided",
    status: 401,
    ...overrides,
  };
}

export function engineOptions(overrides) {
  const clock = overrides.clock ?? new FakeClock();
  const storage = overrides.storage ?? new FakeStorage();
  const sessions = overrides.sessions ?? new FakeSessions();
  const generate = overrides.generate ?? new FakeGenerate();
  const log = overrides.recorder ?? recorder();
  return {
    options: {
      // Real defaults, so a new option can never be silently absent from a test.
      config: {
        ...DEFAULT_CONFIG,
        primary: FREE,
        fallback: PAID,
        adoptFallbackSessions: true,
        // Fast, deterministic timings for the state machine under test.
        backoffMs: [1_000, 2_000, 5_000],
        maxCooldownMs: 5_000,
        jitterRatio: 0,
        failoverRetryDelayMs: 100,
        duplicateLimitWindowMs: 5_000,
        routeRejectRetryMs: 3_000,
        probePrompt: "ping",
        parkGraceMs: 1_000,
        sessionLimit: 50,
        logLevel: "debug",
        ...(overrides.config ?? {}),
      },
      clock,
      storage,
      sessions,
      generate,
      logger: log.logger,
      random: () => 0.5,
      ...(overrides.paidHolds ? { paidHolds: overrides.paidHolds } : {}),
      ...(overrides.pricing ? { pricing: overrides.pricing } : {}),
      ...(overrides.onError ? { onError: overrides.onError } : {}),
      ...(overrides.onProbeState ? { onProbeState: overrides.onProbeState } : {}),
      ...(overrides.onModeChanged ? { onModeChanged: overrides.onModeChanged } : {}),
    },
    clock,
    storage,
    sessions,
    generate,
    log,
  };
}
