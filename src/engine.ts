/**
 * opencode-free-first engine.
 *
 * Owns exactly one concern: free-model availability. It decides when the
 * configured free model may be used, moves a session to the configured fallback
 * model when the free model genuinely rate limits, and returns the same session
 * to the free model once recovery is confirmed — without touching the user's
 * prompt, the conversation history, the agent, the working directory, or any
 * other plugin's scheduling.
 *
 * Every side effect is injected, so the state machine, the failover path, the
 * recovery path, and the concurrency behaviour all run under deterministic
 * tests with no provider traffic.
 */

import type {
  FreeRouteRejection,
  ProbeOutcome,
  ProviderErrorView,
  ResetHint,
  TransientClassification,
} from "./classify.js";
import {
  classifyFreeLimit,
  classifyFreeRouteRejection,
  classifyProbeFailure,
  classifyTransientAvailability,
  extractReset,
} from "./classify.js";
import type { FreeFirstConfig } from "./config.js";
import {
  applyFreeRouteUnavailable,
  applyLimited,
  applyTransientUnavailable,
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
} from "./health.js";
import type { Logger } from "./log.js";
import type { CancelHoldResult, PaidHoldPort, PricingPort, PricingSnapshot } from "./offpeak.js";
import type {
  FreeState,
  FreeUsageMode,
  HealthRecord,
  ModelRef,
  PricingState,
  SessionRecord,
  SessionRoute,
} from "./types.js";
import {
  HEALTH_SCHEMA_VERSION,
  HEALTH_STORAGE_KEY,
  modelRefKey,
  SESSION_SCHEMA_VERSION,
  SESSION_STORAGE_KEY,
  sameModel,
} from "./types.js";

/* ------------------------------------------------------------------ ports */

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StateStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface SessionDriver {
  /** Route later model calls in this session through `model`. */
  switchModel(input: { readonly sessionID: string; readonly model: ModelRef }): Promise<void>;
  /** Admit an invisible continuation input and optionally wake the session. */
  synthetic(input: {
    readonly sessionID: string;
    readonly text: string;
    readonly delivery: "steer" | "queue";
    readonly resume: boolean;
  }): Promise<void>;
  /** Interrupt active execution owned by this process. */
  interrupt(input: { readonly sessionID: string }): Promise<{ readonly interrupted: boolean }>;
  /** Resolve once the session has no active execution owned by this process. */
  wait(input: { readonly sessionID: string }): Promise<void>;
  /** Current session state, used to verify hints before acting on them. */
  get(input: { readonly sessionID: string }): Promise<{ readonly model?: ModelRef | undefined }>;
}

export interface GeneratePort {
  /** Transient generation: no session, no tools, no history. */
  text(input: {
    readonly model: ModelRef;
    readonly prompt: string;
  }): Promise<{ readonly text: string }>;
}

/* --------------------------------------------------------------- engine IO */

export interface RetryInput {
  readonly sessionID: string;
  readonly model: ModelRef;
  readonly error: ProviderErrorView;
  readonly attempt: number;
  /** Mutable retry decision owned by the caller. */
  decision: { retry: false } | { retry: true; delay: number };
}

export interface ModelSelectionEvent {
  readonly sessionID: string;
  readonly model: ModelRef;
  readonly previous?: ModelRef | undefined;
}

export interface HttpResponseEvent {
  readonly sessionID: string;
  readonly model: ModelRef;
  readonly status: number;
}

export interface ExecutionEvent {
  readonly sessionID: string;
  readonly phase: "started" | "settled";
  readonly outcome?: "succeeded" | "failed" | "interrupted";
}

export interface EngineOptions {
  readonly config: FreeFirstConfig;
  readonly clock: Clock;
  readonly storage: StateStore;
  readonly sessions: SessionDriver;
  readonly generate: GeneratePort;
  /**
   * The neighbour plugin that owns paid holds, when it is installed. Optional:
   * without it reclamation keeps its interrupt-based fallback behaviour.
   */
  readonly paidHolds?: PaidHoldPort;
  /** Canonical PEAK/OFF_PEAK classification, used only by `peak-only`. */
  readonly pricing?: PricingPort;
  readonly logger: Logger;
  readonly random: () => number;
  readonly onError?: (error: unknown) => void;
  /** Notified while an out-of-band recovery probe is in flight. */
  readonly onProbeState?: (active: boolean) => void;
}

export interface EngineStatus {
  readonly enabled: boolean;
  readonly state: FreeState;
  readonly status: string;
  readonly primary: string;
  readonly fallback: string;
  /** Configured free-usage policy. */
  readonly freeUsageMode: FreeUsageMode;
  /** Canonical pricing classification, present in `peak-only` mode. */
  readonly pricingState?: PricingState;
  readonly pricingNextTransition?: number;
  readonly pricingPolicyID?: string;
  readonly pricingReason?: string;
  /** What new traffic routes to right now: FREE, GO, MIXED, or NONE. */
  readonly activeRoute: "FREE" | "GO" | "MIXED" | "NONE";
  readonly cooldownMs: number;
  readonly cooldownEndsAt?: number;
  readonly nextProbeAt?: number;
  readonly level: number;
  readonly lastRateLimitAt?: number;
  readonly lastRateLimitType?: string;
  readonly lastResetSource?: string;
  readonly lastHealthyAt?: number;
  /** Why the current cooldown was armed: a rate limit, the gate, or a transient outage. */
  readonly cooldownReason?: string;
  /** First recognised free-route rejection of the current episode. */
  readonly routeRejectedAt?: number;
  /** Consecutive transient availability failures (its own bounded ladder). */
  readonly transientFailures?: number;
  /** When the last transient availability failure was seen. */
  readonly lastTransientAt?: number;
  /** Stable classification of the last transient failure. */
  readonly lastTransientType?: string;
  readonly probedAt?: number;
  readonly probeBackoffUntil?: number;
  readonly inconclusiveProbes?: number;
  readonly lastProbeOutcome?: string;
  /** Capability of the neighbour plugin's generic hold cancellation. */
  readonly holdCancelCapability?: "unknown" | "available" | "unavailable";
  /** Cancellations accepted / settled by dispatch / unavailable. */
  readonly holdCancels?: { accepted: number; committed: number; unavailable: number };
  /** Sessions waiting for a refused fallback attempt to return to the free model. */
  readonly pendingResumes?: number;
  /**
   * While a cooldown is active, sessions moved to the fallback so no request —
   * including an automatic compaction — resolves the free model at a step
   * boundary that has no hook.
   */
  readonly cooldownRouting?: { runs: number; routed: number };
  /** Compaction attempts whose retry was suppressed because the model cannot change. */
  readonly compactionRetriesSuppressed?: number;
  readonly managedSessions: number;
  readonly fallbackSessions: number;
  readonly managedSessionIds: readonly string[];
  readonly fallbackSessionIds: readonly string[];
  readonly manualOverrides: number;
  readonly transitions: readonly string[];
}

interface SessionState {
  managed: boolean;
  route: SessionRoute;
  model?: ModelRef;
  optOut: "manual-model-change" | "disabled" | undefined;
  updatedAt: number;
}

interface PrepareMark {
  readonly model: ModelRef;
  readonly at: number;
  dispatched: boolean;
}

const MAX_TRANSITIONS = 40;
/**
 * How long a confirmed dispatch stays recent enough to decide whether a retry
 * can change anything. OpenCode re-resolves the model for every retried primary
 * attempt, but a compaction attempt re-sends the model it was prepared with.
 */
const COMPACTION_RETRY_WINDOW_MS = 60_000;
/**
 * How long a cancellation request stays eligible for its refused attempt to
 * come back through the retry hook. A refusal is a transport failure that
 * arrives within one attempt, so this only bounds a lost race.
 */
const REFUSAL_RESUME_WINDOW_MS = 60_000;
/** Upper bound on waiting for a preempted session to settle. */
const PARK_SETTLE_TIMEOUT_MS = 15_000;

function emptySession(now: number): SessionState {
  return { managed: false, route: "PRIMARY", optOut: undefined, updatedAt: now };
}

/* ------------------------------------------------------------------ engine */

export class FreeFirstEngine {
  readonly #config: FreeFirstConfig;
  readonly #clock: Clock;
  readonly #storage: StateStore;
  readonly #sessions: SessionDriver;
  readonly #generate: GeneratePort;
  readonly #paidHolds: PaidHoldPort | undefined;
  readonly #pricingPort: PricingPort | undefined;
  readonly #logger: Logger;
  readonly #random: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #onProbeState: (active: boolean) => void;

  #enabled: boolean;
  #health: HealthRecord;
  readonly #sessionsState = new Map<string, SessionState>();
  readonly #pendingSwitch = new Map<string, { readonly model: ModelRef; readonly at: number }>();
  readonly #prepared = new Map<string, PrepareMark>();
  readonly #executing = new Set<string>();
  readonly #lastHeaders = new Map<string, Record<string, string>>();
  readonly #previousModels = new Map<string, ModelRef>();
  readonly #variantIndex = new Map<string, readonly string[]>();
  /**
   * Sessions whose parked paid request this plugin just asked to cancel. The
   * resulting refusal is a transport failure, and this marker keeps the resume
   * policy narrow: only a fallback failure that follows our own cancellation
   * returns the session to the free model.
   */
  readonly #pendingResumes = new Map<string, number>();
  /**
   * The last request this instance confirmed as dispatching, with its kind.
   * The retry decision depends on it: a primary request is re-resolved by the
   * runner when it is retried, while a compaction request re-sends its own
   * prepared model.
   */
  readonly #lastDispatch = new Map<
    string,
    { kind: string; model: ModelRef; at: number; freeEligible: boolean }
  >();
  /** One cooldown routing pass at a time; a request during a pass re-runs it. */
  #cooldownRouting: Promise<void> | undefined;
  #cooldownRoutingPending = false;
  #cooldownRoutingRuns = 0;
  #cooldownRoutedSessions = 0;
  #compactionRetriesSuppressed = 0;

  #transitions: string[] = [];
  #loggedExpiry: number | undefined;
  #timer: unknown;
  #timerDueAt: number | undefined;
  #flushTimer: unknown;
  #probe: Promise<ProbeOutcome> | undefined;
  #probedAt: number | undefined;
  #pricing: PricingSnapshot | undefined;
  #pricingValidUntil = 0;
  #pricingRefresh: Promise<PricingSnapshot | undefined> | undefined;
  #defaultModel: ModelRef | undefined;
  #disposed = false;
  #dirty = false;

  constructor(options: EngineOptions) {
    this.#config = options.config;
    this.#clock = options.clock;
    this.#storage = options.storage;
    this.#sessions = options.sessions;
    this.#generate = options.generate;
    this.#paidHolds = options.paidHolds;
    this.#pricingPort = options.pricing;
    this.#logger = options.logger;
    this.#random = options.random;
    this.#onError = options.onError ?? (() => {});
    this.#onProbeState = options.onProbeState ?? (() => {});
    this.#enabled = options.config.enabled;
    this.#health = initialHealth(modelRefKey(options.config.primary), this.#clock.now());
  }

  /* ------------------------------------------------------------ lifecycle */

  /** Restore persisted derived state, then arm the recovery scheduler. */
  async start(): Promise<void> {
    const now = this.#clock.now();
    const [rawHealth, rawSessions] = await Promise.all([
      this.#safeGet(HEALTH_STORAGE_KEY),
      this.#safeGet(SESSION_STORAGE_KEY),
    ]);

    const restored = decodeHealth(rawHealth, modelRefKey(this.#config.primary));
    if (restored !== undefined) {
      this.#health = restored;
      if (restored.state === "FREE_COOLDOWN" && restored.cooldownUntil !== undefined) {
        if (restored.cooldownUntil > now) {
          this.#log("info", "restored free cooldown from persisted state", {
            remaining: formatDuration(restored.cooldownUntil - now),
            level: restored.level,
            resetSource: restored.lastResetSource ?? "backoff",
          });
        } else {
          // Never probe merely because OpenCode restarted. The expired cooldown
          // is dropped and the next real request decides; the ladder position is
          // kept so a repeat limit still backs off further.
          this.#log("info", "discarded expired free cooldown from persisted state");
          this.#health = {
            schemaVersion: HEALTH_SCHEMA_VERSION,
            scope: restored.scope,
            state: "FREE_HEALTHY",
            level: restored.level,
            ...(restored.lastRateLimitAt === undefined
              ? {}
              : { lastRateLimitAt: restored.lastRateLimitAt }),
            ...(restored.lastRateLimitType === undefined
              ? {}
              : { lastRateLimitType: restored.lastRateLimitType }),
            ...(restored.lastResetSource === undefined
              ? {}
              : { lastResetSource: restored.lastResetSource }),
            ...(restored.lastHealthyAt === undefined
              ? {}
              : { lastHealthyAt: restored.lastHealthyAt }),
            ...(restored.routeRejectedAt === undefined
              ? {}
              : { routeRejectedAt: restored.routeRejectedAt }),
            ...(restored.transientFailures === undefined
              ? {}
              : { transientFailures: restored.transientFailures }),
            ...(restored.lastTransientAt === undefined
              ? {}
              : { lastTransientAt: restored.lastTransientAt }),
            ...(restored.lastTransientType === undefined
              ? {}
              : { lastTransientType: restored.lastTransientType }),
          };
        }
      }
    } else if (rawHealth !== undefined) {
      this.#log("info", "discarded incompatible persisted free state; starting healthy");
    }

    for (const [sessionID, state] of this.#decodeSessions(rawSessions, now)) {
      this.#sessionsState.set(sessionID, state);
    }
    this.#schedule();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerDueAt = undefined;
    if (this.#flushTimer !== undefined) this.#clock.clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    await this.#flush();
  }

  /* ------------------------------------------------------------- observers */

  /**
   * Prompt admission. Runs before the turn resolves its model, which makes this
   * the only place a downgrade can happen without spending a request against a
   * free model that is known to be cooling down.
   */
  async onPrompt(sessionID: string): Promise<void> {
    if (!this.#active()) return;
    await this.refreshPricing();
    // OpenCode loads one plugin instance per location and every instance shares
    // this plugin's storage, so a cooldown another instance recorded must apply
    // to this prompt. One keyed read per prompt is the price of a shared
    // cooldown across a long-lived service.
    await this.#adoptPersistedCooldown();
    if (this.#pricingBlocksFree()) {
      // Off-peak: the free route stays untouched. Expire an elapsed cooldown
      // without probing it, then make sure every managed session that could
      // reach a step boundary is on the paid route.
      this.#normaliseElapsedCooldown();
      const state = await this.#stateWithModel(sessionID);
      await this.#applyRouting(sessionID, state, "off-peak-guard");
      await this.#enforceCooldownRouting("off-peak-guard");
      return;
    }
    // Settling recovery here (when no probe is already in flight) is deliberate:
    // it decides this very prompt, so it must not be skipped. The work is one
    // tiny request.
    if (this.#expireCooldown() && this.#probe === undefined) await this.#recovery();
    const state = await this.#stateWithModel(sessionID);
    await this.#applyRouting(sessionID, state, "prompt-admission");
    // Prompt admission is followed by the step boundary that resolves the model
    // for the turn — including for an automatic compaction. Keep every other
    // managed session on the fallback too, so none of them can spend a doomed
    // free request at that boundary.
    await this.#enforceCooldownRouting("cooldown-guard");
  }

  /**
   * Prompt admission is the last moment before OpenCode resolves the model for
   * the turn, so it is where routing converges: a managed session is moved to
   * the free model when it is usable, and to the fallback model when it is not.
   */
  async #applyRouting(sessionID: string, state: SessionState, trigger: string): Promise<void> {
    if (state.optOut !== undefined) return;
    await this.#adoptPersistedCooldown();
    if (this.#pricingBlocksFree()) {
      if (this.#isPrimary(state.model ?? this.#config.primary)) {
        await this.#downgrade(sessionID, trigger);
      }
      return;
    }
    if (this.#inCooldown()) {
      if (this.#isPrimary(state.model ?? this.#config.primary)) {
        await this.#downgrade(sessionID, trigger);
      }
      return;
    }
    if (!state.managed) return;
    // A probe in flight decides for everyone: never move a session ahead of it.
    if (this.#probe !== undefined) return;
    if (state.route === "FALLBACK") await this.#upgrade(sessionID, trigger);
  }

  /**
   * Prepare started for a model request. OpenCode resolves the model before the
   * `model.request` hooks run, so a switch here lands on the next attempt or
   * step — a safe boundary. This is also the only reliable signal that a
   * request was prepared but never dispatched, which is exactly the shape of a
   * request parked by another plugin's pre-model hold.
   */
  async onContext(sessionID: string, model: ModelRef): Promise<void> {
    if (!this.#active()) return;
    if (this.#config.freeUsageMode === "peak-only") await this.refreshPricing();
    const now = this.#clock.now();
    if (!this.#isRelevant(model)) {
      this.#prepared.delete(sessionID);
      return;
    }
    this.#prepared.set(sessionID, { model, at: now, dispatched: false });
    if (this.#logger.enabled("debug")) {
      this.#log("debug", "request prepared", {
        sessionID,
        model: modelRefKey(model),
        health: this.#health.state,
      });
    }
    this.#schedule();

    // Another instance may hold a cooldown this one has not seen yet. Every
    // request preparation refreshes that view — in both directions, because a
    // preparation on the free model must not be sent while FREE is known to be
    // unavailable, and a preparation on the fallback is where recovery is
    // decided. This is the read that makes a shared cooldown authoritative
    // before the *next* step boundary resolves a model.
    await this.#adoptPersistedCooldown();

    const state = await this.#stateWithModel(sessionID);
    if (this.#pricingBlocksFree()) {
      // Off-peak: never recover and never probe. A request already resolved to
      // the free model is left to finish (the turn is in flight); the session
      // is moved for the next attempt or step.
      if (
        this.#isPrimary(model) &&
        state.optOut === undefined &&
        (state.managed || this.#isPrimary(state.model ?? model))
      ) {
        await this.#downgrade(sessionID, "off-peak-guard");
      }
      await this.#enforceCooldownRouting("off-peak-guard");
      return;
    }
    if (this.#isFallback(model) && state.managed && state.route === "FALLBACK") {
      // The cooldown has elapsed, so the free model may be tested again and this
      // session should stop paying for the fallback. Recovery is centralised so
      // a passive path can never overtake an in-flight probe.
      if (this.#expireCooldown() && this.#probe === undefined) await this.#recovery();
      else this.#schedule();
      return;
    }
    if (this.#isPrimary(model) && state.managed && this.#inCooldown()) {
      await this.#downgrade(sessionID, "context-guard");
    }
    await this.#enforceCooldownRouting("cooldown-guard");
  }

  /** The request is about to be dispatched: no plugin is holding it. */
  onModelRequest(sessionID: string, model: ModelRef, kind?: string): void {
    if (!this.#active()) return;
    if (this.#logger.enabled("debug")) {
      this.#log("debug", "model request dispatching", {
        sessionID,
        model: modelRefKey(model),
        kind: kind ?? "unknown",
        inCooldown: this.#inCooldown(),
      });
    }
    const mark = this.#prepared.get(sessionID);
    if (mark !== undefined && sameModel(mark.model, model)) mark.dispatched = true;
    // Remember what kind of request is actually on the wire: the retry decision
    // below has to know whether the model of the retried attempt can change.
    this.#lastDispatch.set(sessionID, {
      kind: kind ?? "unknown",
      model,
      at: this.#clock.now(),
      // A request dispatched while the free route is known to be cooling down
      // cannot later prove free health. OpenCode 2.1 issues concurrent
      // title/auxiliary requests; one of those succeeding must not clear a real
      // cooldown or race a recovery probe.
      freeEligible: !this.#inCooldown() && this.#probe === undefined,
    });

    const state = this.#stateFor(sessionID);
    if (this.#isPrimary(model)) {
      state.model = model;
      // An explicit opt-out is only cleared by an explicit selection event, so
      // a stale in-flight request cannot silently re-adopt the session.
      if (state.optOut === undefined && (!state.managed || state.route !== "PRIMARY")) {
        state.managed = true;
        state.route = "PRIMARY";
        state.updatedAt = this.#clock.now();
        this.#log("info", "free model selected", { sessionID, model: modelRefKey(model) });
        this.#markDirty();
      }
    } else if (this.#isFallback(model)) {
      // A request this plugin just asked the parking plugin to cancel is
      // obsolete work: it reached the boundary only to be refused, and it must
      // not be mistaken for the model the session is actually on.
      if (!this.#pendingResumes.has(sessionID)) state.model = model;
    }
    this.#schedule();
  }

  /** Provider response observed. A non-error response proves free health. */
  onHttpResponse(event: HttpResponseEvent): void {
    if (!this.#active()) return;
    if (!this.#isPrimary(event.model)) return;
    if (event.status === 429) return; // the retry hook owns this transition
    // While a probe is in flight it is the only verdict about free health.
    // OpenCode 2.1 also issues concurrent title requests; they must not clear a
    // cooldown or overtake the probe.
    if (this.#probe !== undefined) return;
    const dispatched = this.#lastDispatch.get(event.sessionID);
    if (dispatched?.freeEligible === false) return;
    if (event.status < 400) this.#notePrimarySuccess("provider-2xx");
  }

  /** Header snapshot from the provider attempt, for reset metadata. */
  onHttpHeaders(sessionID: string, headers: Readonly<Record<string, string>>): void {
    const lowered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase()] = value;
    this.#lastHeaders.set(sessionID, lowered);
    if (this.#lastHeaders.size > this.#config.sessionLimit) {
      const oldest = this.#lastHeaders.keys().next().value;
      if (oldest !== undefined) this.#lastHeaders.delete(oldest);
    }
  }

  /** Explicit model selection, including the plugin's own switches. */
  onModelSelected(event: ModelSelectionEvent): void {
    if (!this.#active()) return;
    const now = this.#clock.now();
    const state = this.#stateFor(event.sessionID);
    if (event.previous !== undefined && !this.#isPrimary(event.previous)) {
      this.rememberPrevious(event.sessionID, event.previous);
    }
    state.model = event.model;
    state.updatedAt = now;

    const pending = this.#pendingSwitch.get(event.sessionID);
    const pluginInitiated =
      pending !== undefined &&
      sameModel(pending.model, event.model) &&
      now - pending.at <= this.#config.switchConfirmMs;
    if (pending !== undefined) this.#pendingSwitch.delete(event.sessionID);

    if (this.#isPrimary(event.model)) {
      const returning = state.route === "FALLBACK" || state.optOut !== undefined;
      state.managed = true;
      state.route = "PRIMARY";
      state.optOut = undefined;
      this.#log("info", returning ? "returned to free model" : "free model selected", {
        sessionID: event.sessionID,
        model: modelRefKey(event.model),
        pluginInitiated,
      });
    } else if (this.#isFallback(event.model) && pluginInitiated) {
      state.managed = true;
      state.route = "FALLBACK";
      if (this.#logger.enabled("debug")) {
        this.#log("debug", "failover switch confirmed", { sessionID: event.sessionID });
      }
    } else if (this.#isFallback(event.model) && !this.#config.respectExplicitModelSelection) {
      // The operator asked free-first to keep managing the session through a
      // manual change, so it stays eligible for recovery to the free model.
      state.managed = true;
      state.route = "FALLBACK";
    } else {
      state.managed = false;
      state.route = "PRIMARY";
      state.optOut = "manual-model-change";
      this.#log("info", "explicit manual override detected; free-first stops managing session", {
        sessionID: event.sessionID,
        model: modelRefKey(event.model),
      });
    }
    this.#markDirty();
    this.#schedule();
  }

  /** Session execution lifecycle, used for park detection and health proof. */
  onExecution(event: ExecutionEvent): void {
    if (!this.#active()) return;
    if (event.phase === "started") {
      this.#executing.add(event.sessionID);
      this.#schedule();
      // A turn can reach a step boundary — and therefore an automatic
      // compaction — without any prompt admission in between, so routing the
      // known sessions here is another chance to be on the fallback before that
      // boundary resolves a model. It is a push, not a guarantee: a pass that
      // loses the race is still correct, because the compaction's own failure
      // classifies the limit and routes the session for the next attempt.
      void this.#enforceCooldownRouting("cooldown-guard").catch(this.#onError);
      return;
    }
    this.#executing.delete(event.sessionID);
    this.#prepared.delete(event.sessionID);
    // A settled execution cannot be resumed by a refused attempt any more.
    this.#pendingResumes.delete(event.sessionID);
    this.#lastDispatch.delete(event.sessionID);
    // A settled execution is deliberately NOT a free-health proof: the turn may
    // have succeeded on the fallback model. Only a response from the free model
    // itself, or a probe, may clear a cooldown.
  }

  /**
   * Retry decision. This is where failover happens: a genuine free-model rate
   * limit switches the same session to the fallback model and forces one cheap
   * immediate retry, so OpenCode re-resolves the model and continues the same
   * turn with full history, the same agent, the same working directory, and no
   * duplicated prompt or tool call.
   */
  async onRetry(input: RetryInput): Promise<void> {
    if (!this.#active()) return;
    await this.refreshPricing();
    if (this.#isFallback(input.model)) {
      await this.#resumeOnFreeAfterRefusal(input);
      return;
    }
    if (!this.#isPrimary(input.model)) return;

    const state = this.#stateFor(input.sessionID);
    const now = this.#clock.now();
    const classification = classifyFreeLimit(input.error);
    let trigger = "failover";
    if (!classification.limited) {
      // Not a rate limit. Two other causes reach the failover: OpenCode's own
      // free-tier eligibility gate (the free *route* is refused) and a
      // transient availability failure (the free route cannot serve an
      // otherwise valid request right now). A 401, a generic 403, an invalid
      // key, a malformed request, a content filter, a context-length error, a
      // tool failure, or a configuration error must never reach it.
      const rejection = classifyFreeRouteRejection(input.error);
      if (rejection.rejected) {
        await this.#recordFreeRouteUnavailable(input, rejection, now);
        trigger = "route-reject-failover";
      } else {
        const transient = classifyTransientAvailability(input.error);
        if (!transient.transient) {
          if (this.#logger.enabled("debug")) {
            this.#log("debug", "provider failure is not a free-model availability failure", {
              sessionID: input.sessionID,
              type: input.error.type ?? "unknown",
              status: input.error.status ?? 0,
              classification: classification.reason,
              availability: transient.reason,
              attempt: input.attempt,
            });
          }
          return;
        }
        await this.#recordTransientUnavailable(input, transient, now);
        trigger = "availability-failover";
      }
    } else {
      await this.#recordRateLimit(input, classification, now);
    }
    // A compaction request cannot change its model when OpenCode retries it: the
    // compaction re-sends the request it prepared. Retrying it on the free model
    // after that model just limited would only spend more doomed free requests,
    // and would expose the same failure again. A primary request is different —
    // the runner re-resolves it for the retried attempt — so it keeps the retry.
    const dispatched = this.#lastDispatch.get(input.sessionID);
    const fixedModel =
      dispatched !== undefined &&
      dispatched.kind === "compaction" &&
      sameModel(dispatched.model, input.model) &&
      now - dispatched.at <= COMPACTION_RETRY_WINDOW_MS;
    if (fixedModel) {
      this.#compactionRetriesSuppressed += 1;
      const cause =
        trigger === "failover"
          ? "a just-limited free model"
          : trigger === "route-reject-failover"
            ? "a free route that just rejected it"
            : "a transiently unavailable free model";
      this.#log("info", `compaction request is not retried on ${cause}`, {
        sessionID: input.sessionID,
        model: modelRefKey(input.model),
        dispatchKind: dispatched?.kind,
      });
    }

    if (state.optOut !== undefined) {
      // The user pointed this session at another model. The limit is real and the
      // cooldown is shared, but moving this session is not free-first's call.
      this.#log("info", "session is not managed by free-first; leaving its model unchanged", {
        sessionID: input.sessionID,
        optOut: state.optOut,
      });
      if (fixedModel) input.decision = { retry: false };
      this.#schedule();
      return;
    }

    const fallback = await this.#resolveFallback(input.sessionID, state.model);
    if (fallback === undefined) {
      // Nothing to fail over to. Surfacing the real error beats retrying a free
      // model that just refused the request.
      this.#log("error", "no fallback model available; surfacing the free-model failure", {
        sessionID: input.sessionID,
      });
      input.decision = { retry: false };
      this.#schedule();
      return;
    }

    try {
      await this.#switch(input.sessionID, this.#withVariant(fallback, state.model), trigger);
      state.managed = true;
      state.route = "FALLBACK";
      state.model = fallback;
      state.updatedAt = now;
      this.#markDirty();
      input.decision = fixedModel
        ? { retry: false }
        : { retry: true, delay: this.#config.failoverRetryDelayMs };
      this.#log("info", "fallback selected", {
        sessionID: input.sessionID,
        model: modelRefKey(fallback),
        trigger,
        retryDelayMs: fixedModel ? undefined : this.#config.failoverRetryDelayMs,
      });
    } catch (error) {
      this.#log("error", "failed to switch session to the fallback model", {
        sessionID: input.sessionID,
        model: modelRefKey(fallback),
      });
      this.#onError(error);
      input.decision = { retry: false };
    }
    // The cooldown is now authoritative here, so every managed session this
    // instance knows stops being represented on the free model immediately
    // instead of at its next hook. That is what keeps an automatic compaction
    // from resolving the free model at a step boundary.
    await this.#enforceCooldownRouting("cooldown-guard");
    this.#schedule();
  }

  /** Record a genuine rate limit on the shared health record. */
  async #recordRateLimit(
    input: RetryInput,
    classification: { readonly kind?: string; readonly reason: string },
    now: number,
  ): Promise<void> {
    // Another free-first instance (OpenCode loads one per location) may already
    // have recorded this provider window. Adopting it keeps the ladder and the
    // cooldown shared instead of each location discovering the limit alone.
    await this.#adoptPersistedCooldown();
    const reset = extractReset({
      now,
      headers: this.#lastHeaders.get(input.sessionID),
      body: input.error.response?.body,
      message: input.error.message,
    });
    const last = this.#health.lastRateLimitAt;
    // A duplicate is only a duplicate while a cooldown from the same provider
    // window is still running; a later limit is a fresh signal and must arm a
    // real (bounded) cooldown.
    const duplicate =
      last !== undefined &&
      now - last < this.#config.duplicateLimitWindowMs &&
      inCooldown(this.#health, now);
    if (duplicate) {
      // Concurrent requests (for example the session title and the agent loop)
      // can observe the same window. Do not advance the ladder twice for one
      // limit; a later authoritative reset still extends the cooldown.
      const until =
        reset === undefined
          ? this.#health.cooldownUntil
          : Math.max(reset.until, this.#health.cooldownUntil ?? 0);
      this.#health = {
        ...this.#health,
        state: "FREE_COOLDOWN",
        cooldownReason: "rate-limit",
        ...(until === undefined ? {} : { cooldownUntil: until }),
      };
      this.#markDirty();
      this.#log("info", "free rate limit detected", {
        sessionID: input.sessionID,
        kind: classification.kind ?? "rate-limit",
        classification: classification.reason,
        status: input.error.status ?? 0,
        attempt: input.attempt,
        duplicate: true,
        cooldown: formatDuration(remainingCooldown(this.#health, now)),
      });
      return;
    }
    const applied = applyLimited(this.#health, {
      now,
      ...(reset === undefined ? {} : { reset }),
      reason: `failover-${classification.reason}`,
      options: this.#config,
      random: this.#random,
    });
    this.#health = applied.health;
    this.#markDirty();
    this.#log("info", "free rate limit detected", {
      sessionID: input.sessionID,
      kind: classification.kind ?? "rate-limit",
      classification: classification.reason,
      status: input.error.status ?? 0,
      attempt: input.attempt,
      resetSource: applied.source,
      cooldown: formatDuration(applied.cooldownMs),
    });
    this.#log("info", "cooldown started", {
      until: this.#health.cooldownUntil,
      level: this.#health.level,
    });
  }

  /**
   * Record OpenCode's free-tier eligibility gate on a real model request.
   *
   * The existing shared cooldown is armed with `reason: free-route`, so every
   * session and instance routes from it until the bounded retry window elapses,
   * and the existing recovery path then tests the free route through a real
   * request. The first conclusive rejection establishes the episode; a
   * duplicate while the window is live keeps its start time and never extends
   * it, so a herd of sessions cannot turn the gate into a schedule the provider
   * never gave.
   */
  async #recordFreeRouteUnavailable(
    input: RetryInput,
    rejection: FreeRouteRejection,
    now: number,
  ): Promise<void> {
    await this.#adoptPersistedCooldown();
    const duplicate =
      this.#health.state === "FREE_COOLDOWN" &&
      this.#health.cooldownReason === "free-route" &&
      inCooldown(this.#health, now);
    if (duplicate) {
      this.#log("info", "free route rejected", {
        sessionID: input.sessionID,
        classification: rejection.reason,
        type: input.error.type ?? "unknown",
        status: input.error.status ?? 0,
        attempt: input.attempt,
        duplicate: true,
        since: this.#health.routeRejectedAt,
      });
      return;
    }
    const applied = applyFreeRouteUnavailable(this.#health, {
      now,
      retryMs: this.#config.routeRejectRetryMs,
    });
    this.#health = applied.health;
    this.#markDirty();
    this.#log("info", "free route rejected", {
      sessionID: input.sessionID,
      classification: rejection.reason,
      type: input.error.type ?? "unknown",
      status: input.error.status ?? 0,
      attempt: input.attempt,
      retryIn: formatDuration(applied.retryMs),
    });
  }

  /**
   * Record a transient free-route availability failure: the free route cannot
   * currently serve an otherwise valid request (provider/server 5xx, OpenCode's
   * structured `provider.internal`, a qualifying transport or timeout failure).
   *
   * The existing shared cooldown is armed with `reason: transient-availability`
   * for the first rung of the bounded ladder, so every session and instance
   * routes from it, the failed turn continues on the configured fallback, and
   * the existing recovery path then tests the free route again. The bookkeeping
   * stays separate from a rate limit: the transient ladder advances, the
   * rate-limit ladder, its reset source, and `lastRateLimit*` are untouched, so
   * a provider 500 can never be presented as a quota event.
   *
   * A second signal inside `duplicateLimitWindowMs` while a cooldown from the
   * same outage is still running is a duplicate: it does not advance the ladder
   * again, so a herd of sessions observing one provider incident cannot turn
   * the ladder into a schedule the provider never gave.
   */
  async #recordTransientUnavailable(
    input: RetryInput,
    transient: TransientClassification,
    now: number,
  ): Promise<void> {
    await this.#adoptPersistedCooldown();
    const last = this.#health.lastTransientAt;
    const duplicate =
      last !== undefined && now - last < this.#config.duplicateLimitWindowMs && this.#inCooldown();
    if (duplicate) {
      this.#log("info", "free route transient failure detected", {
        sessionID: input.sessionID,
        classification: transient.reason,
        category: transient.category ?? "server",
        type: input.error.type ?? "unknown",
        status: input.error.status ?? 0,
        attempt: input.attempt,
        duplicate: true,
        cooldown: formatDuration(remainingCooldown(this.#health, now)),
      });
      return;
    }
    const applied = applyTransientUnavailable(this.#health, {
      now,
      reason: `failover-${transient.reason}`,
      options: this.#config,
      random: this.#random,
    });
    this.#health = applied.health;
    this.#markDirty();
    this.#log("info", "free route transient failure detected", {
      sessionID: input.sessionID,
      classification: transient.reason,
      category: transient.category ?? "server",
      type: input.error.type ?? "unknown",
      status: input.error.status ?? 0,
      attempt: input.attempt,
      cooldown: formatDuration(applied.cooldownMs),
      transientFailures: this.#health.transientFailures,
    });
    this.#log("info", "cooldown started", {
      until: this.#health.cooldownUntil,
      transientFailures: this.#health.transientFailures,
    });
  }

  /* -------------------------------------------------------------- controls */

  /**
   * Re-read shared health. Diagnostics and the RPC call this so a reported
   * state reflects the whole OpenCode instance, not one location's memory.
   */
  async refresh(): Promise<void> {
    await this.#adoptPersistedCooldown();
    await this.#enforceCooldownRouting("cooldown-guard");
    this.#schedule();
  }

  /**
   * Refresh the canonical PEAK/OFF_PEAK classification. Only `peak-only`
   * consumes it; every other mode leaves the free route independent of price.
   *
   * The answer is cached until the earlier of the owner's next transition and a
   * short freshness window, so a policy edit or a missed reload cannot leave a
   * stale classification for longer than a minute. No timer is created.
   */
  async refreshPricing(force = false): Promise<PricingSnapshot | undefined> {
    if (this.#config.freeUsageMode !== "peak-only") return undefined;
    const now = this.#clock.now();
    if (!force && this.#pricing !== undefined && now < this.#pricingValidUntil) {
      return this.#pricing;
    }
    if (this.#pricingRefresh !== undefined) return this.#pricingRefresh;

    const fallback = this.#config.fallback;
    const run = (async (): Promise<PricingSnapshot | undefined> => {
      const answer =
        fallback === undefined || this.#pricingPort === undefined
          ? undefined
          : await this.#pricingPort.evaluate({
              providerID: fallback.providerID,
              id: fallback.id,
            });
      const next: PricingSnapshot =
        answer === undefined
          ? {
              state: "UNKNOWN",
              allowed: false,
              reason:
                fallback === undefined
                  ? "peak-only requires an explicit fallback model"
                  : "the canonical opencode-offpeak pricing capability is unavailable",
            }
          : answer;
      const previous = this.#pricing?.state;
      this.#pricing = next;
      const boundary = next.nextTransition;
      this.#pricingValidUntil = Math.max(
        now + 1_000,
        Math.min(boundary === undefined ? now + 60_000 : boundary, now + 60_000),
      );
      if (previous !== next.state) {
        this.#log("info", "free usage pricing changed", {
          freeUsageMode: this.#config.freeUsageMode,
          pricingState: next.state,
          nextTransition: next.nextTransition,
          policyID: next.policyID,
        });
      }
      return next;
    })();
    this.#pricingRefresh = run;
    try {
      return await run;
    } finally {
      if (this.#pricingRefresh === run) this.#pricingRefresh = undefined;
    }
  }

  /**
   * The model new sessions should start on. In `peak-only` off-peak, that is
   * the paid fallback; the free route is never published as the default when it
   * is not eligible.
   */
  defaultTarget(): ModelRef {
    if (
      this.#config.freeUsageMode === "peak-only" &&
      this.#pricingBlocksFree() &&
      this.#config.fallback !== undefined
    ) {
      return this.#config.fallback;
    }
    return this.#config.primary;
  }

  /** Clear any cooldown because an operator says the limit is lifted. */
  markHealthy(reason: string): void {
    this.#notePrimarySuccess(reason);
    const cleared = { ...this.#health };
    cleared.probeBackoffUntil = undefined;
    cleared.inconclusiveProbes = 0;
    cleared.lastProbeOutcome = undefined;
    this.#health = cleared;
    this.#markDirty();
    this.#schedule();
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    this.#log("info", enabled ? "free-first enabled" : "free-first disabled");
    this.#schedule();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setVariantIndex(index: ReadonlyMap<string, readonly string[]>): void {
    this.#variantIndex.clear();
    for (const [key, value] of index) this.#variantIndex.set(key, value);
  }

  /** Remember OpenCode's own default so a session can fall back to it. */
  rememberDefault(model: ModelRef | undefined): void {
    if (model === undefined || this.#isPrimary(model)) return;
    this.#defaultModel = model;
  }

  /** Remember the model a session used before it moved to the free model. */
  rememberPrevious(sessionID: string, model: ModelRef): void {
    if (this.#isPrimary(model)) return;
    this.#previousModels.set(sessionID, model);
  }

  /** Snapshot for diagnostics. Never contains prompts or credentials. */
  status(): EngineStatus {
    const now = this.#clock.now();
    const fallbackSessionIds: string[] = [];
    let primarySessions = 0;
    let manualOverrides = 0;
    for (const [sessionID, state] of this.#sessionsState) {
      if (state.managed && state.route === "FALLBACK") fallbackSessionIds.push(sessionID);
      else if (state.managed && state.route === "PRIMARY") primarySessions += 1;
      if (state.optOut !== undefined) manualOverrides += 1;
    }
    const activeRoute: EngineStatus["activeRoute"] =
      !this.#enabled || this.#config.freeUsageMode === "off"
        ? "NONE"
        : this.#pricingBlocksFree() && this.#config.fallback !== undefined
          ? "GO"
          : primarySessions > 0 && fallbackSessionIds.length > 0
            ? "MIXED"
            : fallbackSessionIds.length > 0
              ? "GO"
              : primarySessions > 0
                ? "FREE"
                : "FREE";
    const nextProbeAt = this.#nextProbeAt();
    return {
      enabled: this.#enabled,
      state: healthState(this.#health, now),
      status: this.statusLine(),
      primary: modelRefKey(this.#config.primary),
      fallback:
        this.#config.fallback === undefined
          ? "session-previous-or-default"
          : modelRefKey(this.#config.fallback),
      freeUsageMode: this.#config.freeUsageMode,
      ...(this.#config.freeUsageMode === "peak-only"
        ? {
            pricingState: this.#pricing?.state ?? ("UNKNOWN" as const),
            ...(this.#pricing?.nextTransition === undefined
              ? {}
              : { pricingNextTransition: this.#pricing.nextTransition }),
            ...(this.#pricing?.policyID === undefined
              ? {}
              : { pricingPolicyID: this.#pricing.policyID }),
            ...(this.#pricing?.reason === undefined ? {} : { pricingReason: this.#pricing.reason }),
          }
        : {}),
      activeRoute,
      cooldownMs: remainingCooldown(this.#health, now),
      ...(this.#health.cooldownUntil === undefined
        ? {}
        : { cooldownEndsAt: this.#health.cooldownUntil }),
      ...(nextProbeAt === undefined ? {} : { nextProbeAt }),
      level: this.#health.level,
      ...(this.#health.lastRateLimitAt === undefined
        ? {}
        : { lastRateLimitAt: this.#health.lastRateLimitAt }),
      ...(this.#health.lastRateLimitType === undefined
        ? {}
        : { lastRateLimitType: this.#health.lastRateLimitType }),
      ...(this.#health.lastResetSource === undefined
        ? {}
        : { lastResetSource: this.#health.lastResetSource }),
      ...(this.#health.lastHealthyAt === undefined
        ? {}
        : { lastHealthyAt: this.#health.lastHealthyAt }),
      ...(this.#health.cooldownReason === undefined
        ? {}
        : { cooldownReason: this.#health.cooldownReason }),
      ...(this.#health.routeRejectedAt === undefined
        ? {}
        : { routeRejectedAt: this.#health.routeRejectedAt }),
      ...(this.#health.transientFailures === undefined
        ? {}
        : { transientFailures: this.#health.transientFailures }),
      ...(this.#health.lastTransientAt === undefined
        ? {}
        : { lastTransientAt: this.#health.lastTransientAt }),
      ...(this.#health.lastTransientType === undefined
        ? {}
        : { lastTransientType: this.#health.lastTransientType }),
      ...(this.#probedAt === undefined ? {} : { probedAt: this.#probedAt }),
      ...(this.#health.probeBackoffUntil === undefined
        ? {}
        : { probeBackoffUntil: this.#health.probeBackoffUntil }),
      inconclusiveProbes: this.#health.inconclusiveProbes ?? 0,
      ...(this.#paidHolds === undefined
        ? {}
        : { holdCancelCapability: this.#paidHolds.capability() }),
      ...(this.#paidHolds === undefined ? {} : { holdCancels: this.#paidHolds.calls() }),
      pendingResumes: this.#pendingResumes.size,
      cooldownRouting: {
        runs: this.#cooldownRoutingRuns,
        routed: this.#cooldownRoutedSessions,
      },
      compactionRetriesSuppressed: this.#compactionRetriesSuppressed,
      ...(this.#health.lastProbeOutcome === undefined
        ? {}
        : { lastProbeOutcome: this.#health.lastProbeOutcome }),
      managedSessions: this.#sessionsState.size,
      managedSessionIds: [...this.#sessionsState.keys()],
      fallbackSessions: fallbackSessionIds.length,
      fallbackSessionIds,
      manualOverrides,
      transitions: [...this.#transitions],
    };
  }

  /** One-line status suitable for a log line or a status widget. */
  statusLine(): string {
    if (!this.#enabled) return "disabled";
    if (this.#config.freeUsageMode === "off") return "disabled (free usage mode off)";
    const heuristic = this.#sessionsState.size > 0 ? this.#config.primary : this.#config.primary;
    const state = healthState(this.#health, this.#clock.now());
    if (this.#config.freeUsageMode === "peak-only") {
      const pricing = this.#pricing?.state ?? "UNKNOWN";
      if (pricing !== "PEAK") {
        return `FREE policy: PEAK_ONLY | Pricing: ${pricing} | Active route: GO | Free preserved until PEAK`;
      }
      if (state === "FREE_HEALTHY") {
        return `FREE policy: PEAK_ONLY | Pricing: PEAK | Active route: FREE (${modelRefKey(heuristic)})`;
      }
      const remaining = remainingCooldown(this.#health, this.#clock.now());
      if (remaining > 0) {
        if (this.#health.cooldownReason === "free-route") {
          return `FREE policy: PEAK_ONLY | Pricing: PEAK | Active route: GO | Free route rejected (retry in ${formatDuration(remaining)})`;
        }
        if (this.#health.cooldownReason === "transient-availability") {
          return `FREE policy: PEAK_ONLY | Pricing: PEAK | Active route: GO | Free transient provider failure (retry in ${formatDuration(remaining)})`;
        }
        return `FREE policy: PEAK_ONLY | Pricing: PEAK | Active route: GO | Free cooldown ${formatDuration(remaining)}`;
      }
      return "FREE policy: PEAK_ONLY | Pricing: PEAK | Active route: GO | probing FREE";
    }
    if (state === "FREE_HEALTHY") return `FREE (${modelRefKey(heuristic)})`;
    const remaining = remainingCooldown(this.#health, this.#clock.now());
    if (remaining > 0) {
      if (this.#health.cooldownReason === "free-route") {
        return `FREE unavailable: route rejected (retry in ${formatDuration(remaining)})`;
      }
      if (this.#health.cooldownReason === "transient-availability") {
        return `FREE unavailable: transient provider failure (retry in ${formatDuration(remaining)})`;
      }
      return `FREE cooldown: ${formatDuration(remaining)}`;
    }
    return "probing FREE";
  }

  /* ------------------------------------------------------------- internals */

  #active(): boolean {
    return this.#enabled && this.#config.freeUsageMode !== "off" && !this.#disposed;
  }

  /**
   * True when `peak-only` has no positive PEAK classification. `undefined`
   * pricing is unknown, and unknown must never spend the free quota: only a
   * verified PEAK window authorizes it.
   */
  #pricingBlocksFree(): boolean {
    if (this.#config.freeUsageMode !== "peak-only") return false;
    return this.#pricing?.state !== "PEAK";
  }

  #pricingAllowsFree(): boolean {
    return !this.#pricingBlocksFree();
  }

  /** Both a live cooldown and an ineligible price state route to the fallback. */
  #mustUseFallback(): boolean {
    return this.#inCooldown() || this.#pricingBlocksFree();
  }

  #stateFor(sessionID: string): SessionState {
    let state = this.#sessionsState.get(sessionID);
    if (state === undefined) {
      state = emptySession(this.#clock.now());
      this.#sessionsState.set(sessionID, state);
      this.#pruneSessions();
    }
    return state;
  }

  /**
   * Session state with a verified model. A session free-first has never seen has
   * no recorded model, so the live session is read once before any routing
   * decision: acting on a guess could move a session the user deliberately left
   * on another model.
   */
  async #stateWithModel(sessionID: string): Promise<SessionState> {
    const state = this.#stateFor(sessionID);
    if (state.model !== undefined) return state;
    try {
      const session = await this.#sessions.get({ sessionID });
      if (session.model !== undefined) {
        state.model = session.model;
        if (this.#isPrimary(session.model)) {
          state.managed = true;
          state.route = "PRIMARY";
        } else if (this.#isFallback(session.model)) {
          // A session the operator asked free-first to adopt keeps its fallback
          // route until the free model is usable again. Without adoption it is
          // only recorded, never moved.
          state.route = "FALLBACK";
          state.managed = state.managed || this.#config.adoptFallbackSessions;
        }
        state.updatedAt = this.#clock.now();
      }
    } catch (error) {
      this.#onError(error);
    }
    return state;
  }

  #isPrimary(model: Pick<ModelRef, "providerID" | "id"> | undefined): boolean {
    return sameModel(model, this.#config.primary);
  }

  #isFallback(model: Pick<ModelRef, "providerID" | "id"> | undefined): boolean {
    return this.#config.fallback !== undefined && sameModel(model, this.#config.fallback);
  }

  #isRelevant(model: Pick<ModelRef, "providerID" | "id">): boolean {
    return this.#isPrimary(model) || this.#isFallback(model);
  }

  #expireCooldown(): boolean {
    if (this.#health.state !== "FREE_COOLDOWN") return false;
    if (!cooldownElapsed(this.#health, this.#clock.now())) return false;
    // Several observers can notice the same expiry; report it once per cooldown.
    if (this.#loggedExpiry !== this.#health.cooldownUntil) {
      this.#loggedExpiry = this.#health.cooldownUntil;
      this.#log("info", "cooldown expired");
    }
    return true;
  }

  #inCooldown(): boolean {
    return inCooldown(this.#health, this.#clock.now());
  }

  /**
   * Keep managed sessions on the fallback model while a cooldown is active.
   *
   * OpenCode resolves a request's model at the step boundary, before any plugin
   * hook runs, and an automatic compaction is issued at that same boundary. A
   * compaction attempt that was already prepared cannot be re-routed either: its
   * retry re-sends the model it resolved. The only supported way to keep a
   * compaction off a free model that is known to be unavailable is therefore to
   * have the session represented on the fallback *before* the boundary.
   *
   * This pass is the proactive half of that: as soon as a cooldown is known —
   * established here or adopted from another instance — every managed session
   * with an active execution that is still represented on the free model is
   * moved to its fallback. Executing turns are the ones that can reach a step
   * boundary with no hook in between; an idle session cannot compact, and its
   * next activity goes through prompt admission or a request preparation, both
   * of which route it. Restricting the pass this way keeps a limit cycle from
   * churning sessions that were never going to spend a request.
   *
   * It is idempotent (a session already on the fallback is left alone, so no
   * duplicate switch or event is produced) and it never upgrades: recovery keeps
   * owning the way back to the free model.
   */
  async #enforceCooldownRouting(trigger: string): Promise<void> {
    if (!this.#active()) return;
    if (!this.#mustUseFallback()) return;
    if (this.#cooldownRouting !== undefined) {
      // A pass is already running; it will run again to pick up anything that
      // appeared while it was working, including state it just learned.
      this.#cooldownRoutingPending = true;
      return this.#cooldownRouting;
    }
    this.#cooldownRouting = (async () => {
      try {
        do {
          this.#cooldownRoutingPending = false;
          this.#cooldownRoutingRuns += 1;
          for (const sessionID of [...this.#sessionsState.keys()]) {
            if (!this.#active() || !this.#mustUseFallback()) return;
            if (!this.#executing.has(sessionID)) continue;
            const state = await this.#stateWithModel(sessionID);
            if (state.optOut !== undefined) continue;
            if (!state.managed) continue;
            // Only a session represented on the free model is at risk; a session
            // on another model is deliberately not touched, and a model that
            // cannot be verified is never guessed at.
            if (!this.#isPrimary(state.model)) continue;
            const wasFallback = state.route === "FALLBACK";
            await this.#downgrade(sessionID, trigger);
            if (!wasFallback && state.route === "FALLBACK") this.#cooldownRoutedSessions += 1;
          }
        } while (this.#cooldownRoutingPending && this.#active() && this.#mustUseFallback());
      } finally {
        this.#cooldownRouting = undefined;
      }
    })();
    return this.#cooldownRouting;
  }

  async #downgrade(sessionID: string, trigger: string): Promise<void> {
    const state = this.#stateFor(sessionID);
    const fallback = await this.#resolveFallback(sessionID, state.model);
    if (fallback === undefined) return;
    const target = this.#withVariant(fallback, state.model);
    if (state.route === "FALLBACK" && sameModel(state.model, target)) return;
    try {
      await this.#switch(sessionID, target, trigger);
      state.managed = true;
      state.route = "FALLBACK";
      state.model = target;
      state.updatedAt = this.#clock.now();
      this.#markDirty();
      this.#log("info", "fallback selected", {
        sessionID,
        trigger,
        model: modelRefKey(target),
      });
    } catch (error) {
      this.#log("error", "failed to route session to the fallback model", {
        sessionID,
        trigger,
        model: modelRefKey(target),
      });
      this.#onError(error);
    }
  }

  /**
   * A cancelled paid hold comes back as a refused attempt: the parking plugin
   * lets the request reach the transport boundary but refuses to send it, so
   * OpenCode reports a retryable transport failure and asks for a retry
   * decision. This is where the task returns to the free model inside the same
   * execution — no session interruption, no extra input, and the parked paid
   * request was never dispatched.
   *
   * The marker set by `#cancelHeldRequest` keeps this narrow: only a fallback
   * failure that follows our own cancellation is resumed here, so ordinary
   * fallback failures keep whatever the user and OpenCode chose.
   */
  async #resumeOnFreeAfterRefusal(input: RetryInput): Promise<void> {
    const requestedAt = this.#pendingResumes.get(input.sessionID);
    if (requestedAt === undefined) return;
    const now = this.#clock.now();
    if (now - requestedAt > REFUSAL_RESUME_WINDOW_MS) {
      this.#pendingResumes.delete(input.sessionID);
      return;
    }
    const state = this.#sessionsState.get(input.sessionID);
    if (state === undefined || !state.managed || state.optOut !== undefined) {
      this.#pendingResumes.delete(input.sessionID);
      return;
    }
    const retryable = input.decision.retry === true || input.error.type === "provider.transport";
    if (!retryable) {
      this.#pendingResumes.delete(input.sessionID);
      this.#log(
        "info",
        "refused fallback attempt is not retryable; leaving the decision to OpenCode",
        {
          sessionID: input.sessionID,
          type: input.error.type ?? "unknown",
          status: input.error.status ?? 0,
        },
      );
      return;
    }
    const dispatched = this.#lastDispatch.get(input.sessionID);
    const cancelledCompaction =
      dispatched !== undefined &&
      dispatched.kind === "compaction" &&
      sameModel(dispatched.model, input.model) &&
      now - dispatched.at <= COMPACTION_RETRY_WINDOW_MS;
    if (cancelledCompaction) {
      // The cancelled request was a compaction. OpenCode re-sends a compaction
      // attempt's own prepared model when it retries, so authorizing the retry
      // here would dispatch exactly the paid request that was just cancelled.
      // Fail this attempt instead, resume the turn once, and let the compaction
      // run on the free model the session is now routed to.
      this.#pendingResumes.delete(input.sessionID);
      this.#compactionRetriesSuppressed += 1;
      input.decision = { retry: false };
      this.#log(
        "info",
        "cancelled compaction attempt is not retried; resuming the task on the free model",
        {
          sessionID: input.sessionID,
          model: modelRefKey(input.model),
          dispatchKind: dispatched?.kind,
        },
      );
      try {
        await this.#sessions.synthetic({
          sessionID: input.sessionID,
          text: this.#config.continuationText,
          delivery: "steer",
          resume: true,
        });
      } catch (error) {
        this.#log("error", "failed to resume the task after a cancelled compaction", {
          sessionID: input.sessionID,
        });
        this.#onError(error);
      }
      return;
    }
    if (inCooldown(this.#health, now)) {
      // The free model is not usable yet after all. Keep the marker: the retry
      // may reach this hook again once recovery has settled.
      this.#log(
        "info",
        "refused fallback attempt cannot resume yet; free model is still cooling down",
        {
          sessionID: input.sessionID,
          cooldown: formatDuration(remainingCooldown(this.#health, now)),
        },
      );
      return;
    }
    if (!this.#pricingAllowsFree()) {
      // Off-peak: a refusal that was armed before the boundary must not pull
      // the session back to a free route the policy has closed.
      this.#pendingResumes.delete(input.sessionID);
      this.#log("info", "refused fallback attempt stays on the paid route off-peak", {
        sessionID: input.sessionID,
        pricingState: this.#pricing?.state ?? "UNKNOWN",
      });
      return;
    }
    this.#pendingResumes.delete(input.sessionID);
    await this.#upgrade(input.sessionID, "refused-fallback");
    input.decision = { retry: true, delay: this.#config.failoverRetryDelayMs };
    this.#log(
      "info",
      "same task resumed on the free model after its fallback attempt was refused",
      {
        sessionID: input.sessionID,
        type: input.error.type ?? "unknown",
        attempt: input.attempt,
        retryDelayMs: this.#config.failoverRetryDelayMs,
      },
    );
  }

  /**
   * Ask the plugin that owns the parked paid request to cancel it. Returns
   * `undefined` when there is no such capability, in which case the caller
   * keeps its interrupt-based reclamation.
   */
  async #cancelHeldRequest(sessionID: string): Promise<CancelHoldResult | undefined> {
    const port = this.#paidHolds;
    if (port === undefined) return undefined;
    const result = await port.cancel({ sessionID });
    if (result?.cancelled === true) {
      this.#pendingResumes.set(sessionID, this.#clock.now());
    }
    return result;
  }

  async #upgrade(sessionID: string, trigger: string): Promise<void> {
    const state = this.#stateFor(sessionID);
    const target = this.#withVariant(this.#config.primary, state.model);
    if (state.route === "PRIMARY" && sameModel(state.model, target)) return;
    try {
      await this.#switch(sessionID, target, trigger);
      state.managed = true;
      state.route = "PRIMARY";
      state.model = target;
      state.updatedAt = this.#clock.now();
      this.#markDirty();
      this.#log("info", "returned to free model", {
        sessionID,
        trigger,
        model: modelRefKey(target),
      });
    } catch (error) {
      this.#log("error", "failed to return session to the free model", { sessionID, trigger });
      this.#onError(error);
    }
  }

  async #switch(sessionID: string, model: ModelRef, trigger: string): Promise<void> {
    this.#pendingSwitch.set(sessionID, { model, at: this.#clock.now() });
    try {
      await this.#sessions.switchModel({ sessionID, model });
    } catch (error) {
      this.#pendingSwitch.delete(sessionID);
      throw error;
    }
    this.#log("info", "model transition", {
      sessionID,
      trigger,
      model: modelRefKey(model),
    });
    this.#recordTransition(trigger, model);
  }

  #recordTransition(trigger: string, model: ModelRef): void {
    this.#transitions.push(
      `${new Date(this.#clock.now()).toISOString()} ${trigger} -> ${modelRefKey(model)}`,
    );
    if (this.#transitions.length > MAX_TRANSITIONS) {
      this.#transitions = this.#transitions.slice(-MAX_TRANSITIONS);
    }
  }

  /**
   * Fallback resolution order:
   *  1. the configured fallback model
   *  2. the model this session used before free-first moved it to the free model
   *  3. OpenCode's own model default captured at plugin setup
   *  4. the session's current model, when it is not the free model
   * The plugin never invents a paid route of its own; every candidate comes from
   * configuration or from OpenCode's own state.
   */
  async #resolveFallback(
    sessionID: string,
    current: ModelRef | undefined,
  ): Promise<ModelRef | undefined> {
    if (this.#config.fallback !== undefined) return this.#config.fallback;
    const previous = this.#previousModels.get(sessionID);
    if (previous !== undefined && !this.#isPrimary(previous)) return previous;
    if (this.#defaultModel !== undefined) return this.#defaultModel;
    if (current !== undefined && !this.#isPrimary(current)) return current;
    try {
      const session = await this.#sessions.get({ sessionID });
      if (session.model !== undefined && !this.#isPrimary(session.model)) return session.model;
    } catch (error) {
      this.#onError(error);
    }
    return undefined;
  }

  /**
   * Carry the reasoning-effort variant across a model switch when the target
   * model supports it. OpenCode treats a missing variant as a real change, so
   * dropping it would silently reset the user's reasoning setting.
   */
  #withVariant(target: ModelRef, current: ModelRef | undefined): ModelRef {
    const variants = this.#variantIndex.get(modelRefKey(target));
    const desired = target.variant ?? current?.variant;
    if (desired === undefined) return target;
    if (variants === undefined) return target;
    if (variants.length === 0) {
      return target.variant === undefined
        ? { providerID: target.providerID, id: target.id }
        : target;
    }
    if (variants.includes(desired)) return { ...target, variant: desired };
    return target.variant === undefined ? { providerID: target.providerID, id: target.id } : target;
  }

  /**
   * Take the more conservative of the in-memory and persisted health records.
   *
   * OpenCode loads a plugin instance per location, and every instance shares this
   * plugin's storage. A limit is a property of the provider account, so the
   * longest live cooldown and the highest ladder position are the truth.
   */
  async #adoptPersistedCooldown(): Promise<void> {
    const raw = await this.#safeGet(HEALTH_STORAGE_KEY);
    const stored = decodeHealth(raw, modelRefKey(this.#config.primary));
    if (stored === undefined) return;
    const now = this.#clock.now();
    const storedCooldown = stored.cooldownUntil ?? 0;
    const ownCooldown = this.#health.cooldownUntil ?? 0;
    const newer = stored.level > this.#health.level;
    const longer = storedCooldown > ownCooldown;

    // A recovery confirmed elsewhere is as authoritative as a refusal: without
    // this, a stale local cooldown would outlive the recovery that cleared it.
    const recovered =
      stored.state === "FREE_HEALTHY" &&
      stored.lastHealthyAt !== undefined &&
      stored.lastHealthyAt > (this.#health.lastRateLimitAt ?? 0) &&
      stored.lastHealthyAt > (this.#health.routeRejectedAt ?? 0) &&
      stored.lastHealthyAt > (this.#health.lastTransientAt ?? 0) &&
      this.#health.state !== "FREE_HEALTHY";
    if (recovered) {
      this.#health = markHealthy(this.#health, stored.lastHealthyAt);
      if (this.#loggedExpiry === undefined) this.#loggedExpiry = undefined;
      this.#log("info", "adopted a recovery confirmed by another free-first instance");
      this.#schedule();
      return;
    }
    // A recovery this instance already confirmed is newer than the stored limit:
    // there is nothing left to adopt, and pulling the ladder back up would undo a
    // successful recovery.
    const ourRecoveryAt =
      this.#health.state === "FREE_HEALTHY" ? (this.#health.lastHealthyAt ?? 0) : 0;
    const storedBlockAt = Math.max(
      stored.lastRateLimitAt ?? 0,
      stored.routeRejectedAt ?? 0,
      stored.lastTransientAt ?? 0,
    );
    if (ourRecoveryAt > storedBlockAt) return;
    // Probe bookkeeping is shared too: an instance that just backed the probe off
    // must not be probed again immediately by every other instance.
    const storedBackoff = stored.probeBackoffUntil ?? 0;
    const ownBackoff = this.#health.probeBackoffUntil ?? 0;
    const probeAhead =
      storedBackoff > ownBackoff ||
      (stored.inconclusiveProbes ?? 0) > (this.#health.inconclusiveProbes ?? 0);

    if (!newer && !longer && !probeAhead) return;
    this.#health = {
      ...this.#health,
      level: Math.max(this.#health.level, stored.level),
      ...(storedBackoff > ownBackoff ? { probeBackoffUntil: storedBackoff } : {}),
      ...(stored.inconclusiveProbes === undefined
        ? {}
        : {
            inconclusiveProbes: Math.max(
              this.#health.inconclusiveProbes ?? 0,
              stored.inconclusiveProbes,
            ),
          }),
      ...(stored.lastProbeOutcome === undefined
        ? {}
        : storedBackoff > ownBackoff
          ? { lastProbeOutcome: stored.lastProbeOutcome }
          : {}),
      ...(storedCooldown > now
        ? {
            state: "FREE_COOLDOWN" as const,
            cooldownUntil: storedCooldown,
            ...(stored.cooldownReason === undefined
              ? {}
              : { cooldownReason: stored.cooldownReason }),
            ...(stored.routeRejectedAt === undefined
              ? {}
              : { routeRejectedAt: stored.routeRejectedAt }),
          }
        : {}),
      ...(stored.lastRateLimitAt === undefined
        ? {}
        : { lastRateLimitAt: Math.max(this.#health.lastRateLimitAt ?? 0, stored.lastRateLimitAt) }),
      ...(stored.lastRateLimitType === undefined
        ? {}
        : { lastRateLimitType: stored.lastRateLimitType }),
      ...(stored.lastResetSource === undefined ? {} : { lastResetSource: stored.lastResetSource }),
      // The transient ladder is shared too: the instance that continues after
      // another one recorded an outage must keep escalating, not restart at the
      // first rung.
      ...(stored.transientFailures === undefined
        ? {}
        : {
            transientFailures: Math.max(
              this.#health.transientFailures ?? 0,
              stored.transientFailures,
            ),
          }),
      ...(stored.lastTransientAt === undefined
        ? {}
        : { lastTransientAt: Math.max(this.#health.lastTransientAt ?? 0, stored.lastTransientAt) }),
      ...(stored.lastTransientAt !== undefined &&
      stored.lastTransientAt >= (this.#health.lastTransientAt ?? 0) &&
      stored.lastTransientType !== undefined
        ? { lastTransientType: stored.lastTransientType }
        : {}),
    };
    if (storedCooldown > now) {
      this.#log("info", "adopted a cooldown recorded by another free-first instance", {
        remaining: formatDuration(storedCooldown - now),
        level: this.#health.level,
      });
      this.#schedule();
    }
  }

  #notePrimarySuccess(reason: string): void {
    if (this.#health.state === "FREE_HEALTHY" && this.#health.level === 0) return;
    const wasCooling = inCooldown(this.#health, this.#clock.now());
    this.#health = markHealthy(this.#health, this.#clock.now());
    this.#markDirty();
    this.#log("info", "free recovered", { reason, wasCooling });
    this.#log("info", "safe switch back to free", { reason });
  }

  /* --------------------------------------------------------------- storage */

  #markDirty(): void {
    this.#dirty = true;
    if (this.#disposed || this.#flushTimer !== undefined) return;
    this.#flushTimer = this.#clock.setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#flush().catch(this.#onError);
    }, 0);
  }

  async #flush(): Promise<void> {
    if (!this.#dirty && this.#disposed === false && this.#flushTimer === undefined) {
      // Nothing changed and no write is pending.
      return;
    }
    try {
      // Never let a write downgrade a live cooldown another instance recorded.
      // This is what keeps the shared record monotonic with respect to an active
      // cooldown: a stale healthy instance adopts it instead of clobbering it.
      await this.#adoptPersistedCooldown();
      await this.#storage.set(HEALTH_STORAGE_KEY, this.#health as unknown as never);
      const sessions: Record<string, SessionRecord> = {};
      for (const [sessionID, state] of this.#sessionsState) {
        sessions[sessionID] = {
          managed: state.managed,
          route: state.route,
          updatedAt: state.updatedAt,
          ...(state.optOut === undefined ? {} : { optOut: state.optOut }),
        };
      }
      await this.#storage.set(SESSION_STORAGE_KEY, {
        schemaVersion: SESSION_SCHEMA_VERSION,
        sessions,
      } as unknown as never);
      this.#dirty = false;
    } catch (error) {
      this.#onError(error);
    }
  }

  async #safeGet(key: string): Promise<unknown> {
    try {
      return await this.#storage.get(key);
    } catch (error) {
      this.#onError(error);
      return undefined;
    }
  }

  #decodeSessions(value: unknown, now: number): Map<string, SessionState> {
    const out = new Map<string, SessionState>();
    if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
    const document = value as Record<string, unknown>;
    if (document.schemaVersion !== SESSION_SCHEMA_VERSION) return out;
    const sessions = document.sessions;
    if (sessions === null || typeof sessions !== "object" || Array.isArray(sessions)) return out;
    for (const [sessionID, entry] of Object.entries(sessions as Record<string, unknown>)) {
      if (sessionID.length === 0) continue;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const optOut =
        record.optOut === "manual-model-change" || record.optOut === "disabled"
          ? record.optOut
          : undefined;
      out.set(sessionID, {
        managed: record.managed === true,
        route: record.route === "FALLBACK" ? "FALLBACK" : "PRIMARY",
        optOut,
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : now,
      });
    }
    return out;
  }

  #pruneSessions(): void {
    if (this.#sessionsState.size <= this.#config.sessionLimit) return;
    const ordered = [...this.#sessionsState.entries()].sort(
      (left, right) => left[1].updatedAt - right[1].updatedAt,
    );
    const drop = this.#sessionsState.size - this.#config.sessionLimit;
    for (const [sessionID] of ordered.slice(0, drop)) this.#sessionsState.delete(sessionID);
  }

  /* ------------------------------------------------------------- scheduler */

  #nextProbeAt(): number | undefined {
    if (!this.#config.probe) return undefined;
    if (this.#health.state === "FREE_HEALTHY") return undefined;
    if (!this.#pricingAllowsFree()) return undefined;
    return this.#health.cooldownUntil;
  }

  #nextDeadline(): number | undefined {
    const now = this.#clock.now();
    let due: number | undefined;
    const consider = (at: number | undefined): void => {
      if (at === undefined) return;
      if (due === undefined || at < due) due = at;
    };

    if (this.#health.state === "FREE_COOLDOWN" && this.#health.cooldownUntil !== undefined) {
      consider(this.#health.cooldownUntil + 1);
    }
    // A probe back-off is only worth waking for when a session is waiting on the
    // fallback and the probe could actually tell us something.
    if (
      this.#config.probe &&
      this.#health.probeBackoffUntil !== undefined &&
      !this.#inCooldown() &&
      this.#fallbackSessions().length > 0
    ) {
      consider(this.#health.probeBackoffUntil + 1);
    }
    if (this.#config.parkPreemption && this.#health.state === "FREE_HEALTHY") {
      for (const [sessionID, mark] of this.#prepared) {
        if (mark.dispatched) continue;
        if (!this.#isFallback(mark.model)) continue;
        const state = this.#sessionsState.get(sessionID);
        if (state === undefined || !state.managed || state.optOut !== undefined) continue;
        if (!this.#executing.has(sessionID)) continue;
        consider(mark.at + this.#config.parkGraceMs + 1);
      }
    }
    if (due !== undefined && due <= now) return now + 1;
    return due;
  }

  #schedule(): void {
    if (this.#disposed) return;
    const due = this.#nextDeadline();
    if (due === undefined) {
      if (this.#timer !== undefined) {
        this.#clock.clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#timerDueAt = undefined;
      }
      return;
    }
    if (this.#timer !== undefined && this.#timerDueAt !== undefined && this.#timerDueAt <= due)
      return;
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    const delay = Math.max(0, due - this.#clock.now());
    this.#timerDueAt = due;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#timerDueAt = undefined;
      void this.#tick().catch(this.#onError);
    }, delay);
  }

  async #tick(): Promise<void> {
    if (this.#disposed) return;
    if (this.#expireCooldown()) await this.#recovery();
    else await this.#preemptParkedSessions();
    this.#schedule();
  }

  /**
   * Cooldown expiry.
   *
   * When probing is enabled and a session is currently paying for the fallback,
   * one tiny out-of-band request settles free health before any session moves.
   * That keeps the number of real model transitions minimal and guarantees a
   * failed probe never disturbs a productive fallback session.
   *
   * A confirmed recovery reclaims parked paid work first, then returns the
   * remaining waiting sessions to the free model. Without probing, the next real
   * model call confirms recovery passively.
   */
  async #recovery(): Promise<void> {
    if (this.#probe !== undefined) return; // one probe decides for everyone
    await this.refreshPricing();
    if (this.#pricingBlocksFree()) {
      // Off-peak: recovery must not consume the free route. Drop an elapsed
      // cooldown without claiming a recovery and leave every session on Go.
      this.#normaliseElapsedCooldown();
      this.#schedule();
      return;
    }
    const waiting = this.#fallbackSessions();
    if (waiting.length === 0) {
      // The boundary is behind us and no session is waiting on the fallback, so
      // nothing else would ever clear the elapsed record — and an elapsed
      // record keeps reporting FREE_PROBE while the scheduler keeps waking for
      // a boundary that has passed. Drop it; this is not a claimed recovery.
      this.#normaliseElapsedCooldown();
      this.#schedule();
      return;
    }
    if (this.#config.probe) {
      this.#log("info", "recovery probe scheduled", {
        sessions: waiting.length,
        model: modelRefKey(this.#config.primary),
      });
      const probe = this.#runProbe();
      this.#probe = probe;
      let outcome: ProbeOutcome = "inconclusive";
      try {
        outcome = await probe;
      } finally {
        this.#probe = undefined;
      }
      if (outcome === "limited" || outcome === "transient") {
        // `limited`: a real rate limit. `transient`: the route is still unable
        // to serve requests. Both keep the fallback owning the work until the
        // re-armed cooldown elapses; nothing moves and no session thrashes.
        this.#schedule();
        return;
      }
      // `healthy` and `inconclusive` both fail open. An inconclusive probe only
      // tells us the probe could not decide, so the next real model call is the
      // test — otherwise a probe that can never run would keep the free model
      // blocked forever, which is exactly the defect this guards against.
      await this.#preemptParkedSessions();
      for (const sessionID of this.#fallbackSessions()) {
        await this.#upgrade(
          sessionID,
          outcome === "healthy" ? "probe-recovery" : "passive-recovery",
        );
      }
      this.#schedule();
      return;
    }
    // No probe: the next real model call is the test, so move the waiting
    // sessions back to the free model and let traffic confirm recovery.
    if (this.#config.passiveRecovery) {
      // The elapsed cooldown must leave the record here too: otherwise it keeps
      // reporting FREE_PROBE and keeps waking the scheduler for a boundary that
      // is already behind us.
      this.#normaliseElapsedCooldown();
      await this.#preemptParkedSessions();
      for (const sessionID of this.#fallbackSessions()) {
        await this.#upgrade(sessionID, "passive-recovery");
      }
    } else {
      // Recovery is disabled on both paths, so the elapsed record has no
      // outcome left to be normalised by; drop it so the scheduler stops.
      this.#normaliseElapsedCooldown();
    }
    this.#schedule();
  }

  /**
   * Drop an elapsed cooldown from the record. Called on every fail-open outcome
   * so a cooldown that has already passed can neither keep reporting as active
   * nor keep waking the scheduler for a boundary that is behind us.
   */
  #normaliseElapsedCooldown(): void {
    const next = clearElapsedCooldown(this.#health, this.#clock.now());
    if (next === this.#health) return;
    this.#health = next;
    this.#markDirty();
  }

  #fallbackSessions(): string[] {
    const out: string[] = [];
    for (const [sessionID, state] of this.#sessionsState) {
      if (state.managed && state.route === "FALLBACK") out.push(sessionID);
    }
    return out;
  }

  /**
   * One tiny request against the real configured free model. Transient
   * generation runs without a session, without tools, and without touching any
   * session history, so a probe cannot pollute the user's conversation or cause
   * a business side effect. Probes are serialized and never run while the free
   * model is in cooldown or inside a probe back-off.
   *
   * The returned outcome is what the caller acts on. Crucially, `inconclusive`
   * means *unknown*, so it never keeps the free model blocked: a probe that
   * cannot run is not evidence that the free model is unusable.
   */
  async #runProbe(): Promise<ProbeOutcome> {
    await this.#adoptPersistedCooldown();
    await this.refreshPricing();
    if (this.#pricingBlocksFree()) {
      this.#log("info", "recovery probe skipped: free is not eligible under the pricing policy");
      this.#normaliseElapsedCooldown();
      return "inconclusive";
    }
    const now = this.#clock.now();
    if (inCooldown(this.#health, now)) {
      this.#log("info", "another free-first instance already holds a cooldown; skipping the probe");
      return "inconclusive";
    }
    if (probeDeferred(this.#health, now)) {
      if (this.#logger.enabled("debug")) {
        this.#log("debug", "recovery probe is inside its back-off; skipping", {
          retryIn: formatDuration((this.#health.probeBackoffUntil ?? now) - now),
        });
      }
      this.#normaliseElapsedCooldown();
      return "inconclusive";
    }
    this.#log("info", "recovery probe started", { model: modelRefKey(this.#config.primary) });
    this.#onProbeState(true);
    try {
      await this.#generate.text({
        model: this.#config.primary,
        prompt: this.#config.probePrompt,
      });
      const at = this.#clock.now();
      this.#probedAt = at;
      this.#notePrimarySuccess("probe");
      this.#log("info", "recovery probe succeeded", {
        model: modelRefKey(this.#config.primary),
        took: formatDuration(at - now),
      });
      return "healthy";
    } catch (error) {
      const view = toProviderErrorView(error);
      const at = this.#clock.now();
      this.#probedAt = at;
      const outcome = classifyProbeFailure(view);
      const classification = classifyFreeLimit(view).reason;

      if (outcome === "limited") {
        const reset = extractReset({ now: at, body: view.response?.body, message: view.message });
        const applied = extendCooldown(this.#health, {
          now: at,
          ...(reset === undefined ? {} : { reset }),
          reason: `probe-${classification}`,
          options: this.#config,
          random: this.#random,
        });
        this.#health = applied.health;
        this.#markDirty();
        this.#log("info", "recovery probe rate-limited", {
          classification,
          resetSource: applied.source,
          cooldown: formatDuration(applied.cooldownMs),
          level: this.#health.level,
        });
        return "limited";
      }

      if (outcome === "transient") {
        // The probe mechanism works and the route does not: this is not a
        // facility verdict but a real, current inability to serve the request.
        // Re-arm the bounded transient backoff so the waiting sessions stay on
        // the fallback, and try again when the longer window elapses.
        const availability = classifyTransientAvailability(view);
        const applied = applyTransientUnavailable(this.#health, {
          now: at,
          reason: `probe-${availability.reason}`,
          options: this.#config,
          random: this.#random,
        });
        this.#health = applied.health;
        this.#markDirty();
        this.#log("info", "recovery probe hit a transient availability failure", {
          classification: availability.reason,
          category: availability.category ?? "server",
          cooldown: formatDuration(applied.cooldownMs),
          transientFailures: this.#health.transientFailures,
        });
        return "transient";
      }

      // Not a limit: fail open and schedule the next attempt on the probe
      // back-off ladder. An unsupported probe path backs off hard and says so,
      // because retrying a structurally refused request every minute is futile.
      const attempts = this.#health.inconclusiveProbes ?? 0;
      const retryMs =
        outcome === "unsupported"
          ? this.#config.probeUnsupportedBackoffMs
          : Math.min(backoffFor(attempts, this.#config.backoffMs), this.#config.maxCooldownMs);
      this.#health = markProbeInconclusive(this.#health, {
        now: at,
        retryMs,
        outcome: `${outcome}:${classification}`,
      });
      this.#markDirty();
      if (outcome === "unsupported" && attempts === 0) {
        this.#log(
          "error",
          "the recovery probe is not permitted for this model; using passive recovery",
          {
            type: view.type ?? view.tag ?? "unknown",
            classification,
            nextProbeIn: formatDuration(retryMs),
          },
        );
      } else {
        this.#log("error", "recovery probe inconclusive; free model stays usable", {
          type: view.type ?? view.tag ?? "unknown",
          classification,
          nextProbeIn: formatDuration(retryMs),
        });
      }
      return outcome;
    } finally {
      this.#onProbeState(false);
    }
  }

  /**
   * Reclaim a task parked by another plugin's pre-model hold.
   *
   * A request was prepared for the fallback model and has still not been
   * dispatched after the grace window while the session is executing, and free
   * health is confirmed. One invisible continuation is admitted, the session is
   * put back on the free model, and the parked execution is interrupted — which
   * also tells the parking plugin to drop its own pending continuation, so the
   * obsolete paid work can never run twice.
   */
  async #preemptParkedSessions(): Promise<void> {
    if (!this.#config.parkPreemption) return;
    // Preemption re-interrupts an active execution, so it only happens once the
    // free model is confirmed usable: never on a guess, and never off-peak.
    if (this.#health.state !== "FREE_HEALTHY") return;
    if (!this.#pricingAllowsFree()) return;
    const now = this.#clock.now();
    for (const [sessionID, mark] of [...this.#prepared]) {
      if (mark.dispatched) continue;
      if (!this.#isFallback(mark.model)) continue;
      if (now - mark.at < this.#config.parkGraceMs) continue;
      // The session route is deliberately not part of this test: a request that
      // was already prepared for the fallback stays prepared through a model
      // switch, so the park must be reclaimed even after the session has been
      // returned to the free model.
      const state = this.#sessionsState.get(sessionID);
      if (state === undefined || !state.managed || state.optOut !== undefined) continue;
      if (!this.#executing.has(sessionID)) continue;
      this.#prepared.delete(sessionID);
      await this.#preempt(sessionID, now - mark.at);
    }
  }

  async #preempt(sessionID: string, parkedMs: number): Promise<void> {
    try {
      this.#log("info", "parked fallback request detected", { sessionID, parkedMs });
      // 1. The recovery decision: this session belongs on the free model again.
      await this.#upgrade(sessionID, "park-preemption");
      // 2. Ask the plugin holding the paid request to cancel it. The cancelled
      //    request is refused at the transport boundary (never sent) and
      //    `#resumeOnFreeAfterRefusal` continues the same execution on the free
      //    model, so nothing interrupts the session and a headless
      //    `opencode run` stays attached until the task finishes.
      const cancelled = await this.#cancelHeldRequest(sessionID);
      if (cancelled?.cancelled === true) {
        this.#log("info", "stale fallback continuation neutralized", {
          sessionID,
          via: "cancel-hold",
        });
        return;
      }
      if (cancelled !== undefined) {
        // The dispatch decision had already been taken (or nothing was parked).
        // The paid work continues; the session returns to the free model at its
        // next safe boundary.
        this.#log("info", "parked fallback request was not cancellable; leaving it to settle", {
          sessionID,
          state: cancelled.state,
        });
        return;
      }
      await this.#preemptByInterrupt(sessionID);
    } catch (error) {
      this.#log("error", "failed to preempt a parked fallback request", { sessionID });
      this.#onError(error);
    }
  }

  /**
   * Fallback reclamation for a parking plugin without the cancellation
   * capability: one invisible continuation is admitted, the parked execution is
   * interrupted, and the continuation resumes on the free model. This keeps the
   * documented behaviour for older or absent neighbours; it is not used when
   * the hold could be cancelled.
   */
  async #preemptByInterrupt(sessionID: string): Promise<void> {
    const result = await this.#sessions.interrupt({ sessionID });
    if (!result.interrupted) {
      this.#log("info", "no active execution to preempt; parked request already settled", {
        sessionID,
      });
      return;
    }
    this.#log("info", "stale fallback continuation neutralized", { sessionID, via: "interrupt" });
    // Let the cancellation settle so the continuation cannot race it.
    await this.#waitIdle(sessionID);
    await this.#upgrade(sessionID, "park-preemption");
    await this.#sessions.synthetic({
      sessionID,
      text: this.#config.continuationText,
      delivery: "steer",
      resume: true,
    });
    this.#log("info", "duplicate continuation prevented", { sessionID });
  }

  /**
   * Wait for the session to settle, bounded so a stuck execution can never hang
   * the recovery loop. A timeout is reported and the preemption gives up rather
   * than issuing a continuation the user's session cannot accept.
   */
  async #waitIdle(sessionID: string): Promise<void> {
    let timer: unknown;
    let expired = false;
    const timeout = new Promise<void>((resolve) => {
      timer = this.#clock.setTimeout(() => {
        expired = true;
        resolve();
      }, PARK_SETTLE_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.#sessions.wait({ sessionID }).catch(() => {}), timeout]);
    } finally {
      if (timer !== undefined) this.#clock.clearTimeout(timer);
    }
    if (expired)
      this.#log("error", "timed out waiting for the preempted session to settle", { sessionID });
  }

  #log(level: "error" | "info" | "debug", message: string, detail?: Record<string, unknown>): void {
    this.#logger[level](message, detail);
  }
}

/** Best-effort conversion of an arbitrary thrown value into a provider view. */
export function toProviderErrorView(error: unknown): ProviderErrorView {
  if (error === null || typeof error !== "object") {
    return { message: typeof error === "string" ? error : String(error) };
  }
  const record = error as Record<string, unknown>;
  const response = record.response;
  let body: string | undefined;
  if (response !== null && typeof response === "object") {
    const candidate = (response as { body?: unknown }).body;
    if (typeof candidate === "string") body = candidate;
  }
  return {
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    // OpenCode's own discriminant, kept for diagnostics and for recognising a
    // probe path the host refuses (for example `Generate.UnavailableError`).
    ...(typeof record._tag === "string" ? { tag: record._tag } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.status === "number" ? { status: record.status } : {}),
    ...(body === undefined ? {} : { response: { body } }),
  };
}

/** Reason metadata attached to a cooldown, for diagnostics. */
export type { ResetHint };
export { HEALTH_SCHEMA_VERSION };
