/**
 * Title compatibility.
 *
 * OpenCode 2.1 runs its automatic title request without tools and without an
 * output limit. OpenCode's own free tier refuses that maintenance shape with a
 * `403 FreeTierError` while the normal, tool-bearing agent request on the same
 * model succeeds. `SessionTitle.attempt` swallows the provider failure, so the
 * session stays untitled even though the turn completed — upstream issue
 * anomalyco/opencode#58176.
 *
 * This module is the smallest supported repair and mirrors upstream PR #57624:
 *
 *  1. On the configured free primary model, the `title` hook supplies the
 *     bounded, normalized first user prompt immediately. No provider request is
 *     made at that point, so the title can never race the turn, a failover, or
 *     offpeak's paid hold.
 *  2. Once the turn settles, one supported tool-bearing `session.generate`
 *     request replaces the fallback with a real generated title. That request is
 *     what the free tier accepts (unlike the tool-less title request), and it
 *     goes through OpenCode's normal model selection, so it uses whatever route
 *     the session actually settled on.
 *  3. The upgrade is only attempted while the session is back on the free
 *     primary model and the router would spend free quota, so no paid title
 *     traffic is created. It is bounded, never overwrites a manual rename, and
 *     re-checks the stored title immediately before renaming.
 *
 * OpenCode's native title path is untouched for every non-free model. The whole
 * module is removable by deleting the `title` hook registration.
 */

import type { ProviderErrorView } from "./classify.js";
import {
  classifyFreeLimit,
  classifyFreeRouteRejection,
  classifyTransientAvailability,
} from "./classify.js";
import type { Logger } from "./log.js";
import type { ModelRef } from "./types.js";
import { sameModel } from "./types.js";

/** OpenCode's own title limit (`SessionTitle.MAX_LENGTH`). */
export const TITLE_MAX_LENGTH = 100;

/** Framed as a title so the model answers instead of continuing the task. */
export const TITLE_PROMPT =
  "Write a concise title of at most 8 words for this conversation. " +
  "Reply with only the title: no quotes, no trailing punctuation, and do not call any tools.";

/** The upstream first-prompt fallback shape: collapsed whitespace, same limit. */
export function truncateTitle(value: string): string {
  return value.length <= TITLE_MAX_LENGTH ? value : `${value.slice(0, TITLE_MAX_LENGTH - 3)}...`;
}

export function promptTitle(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return truncateTitle(collapsed);
}

/**
 * Models answer the title prompt with a sentence, a quoted title, or a labelled
 * line. Keep the first meaningful line and strip presentation only; never
 * invent text.
 */
export function cleanGeneratedTitle(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) return undefined;
  const value = line
    .replace(/^title\s*[:-]\s*/i, "")
    .replace(/^[`"'*_]+/, "")
    .replace(/[`"'*_]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length === 0) return undefined;
  return truncateTitle(value);
}

/** Historical OpenCode fallback titles count as untitled for naming purposes. */
const ROOT_FALLBACK = /^(New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isUntitled(title: string | undefined): boolean {
  return title === undefined || title.length === 0 || ROOT_FALLBACK.test(title);
}

export type TitleFailureKind = "free-route-gate" | "rate-limit" | "transient" | "auth" | "unknown";

/**
 * Classify a failed title generation for diagnostics only. The classification
 * is never fed into free health: a title failure must not arm a cooldown that a
 * real user request did not observe.
 */
export function classifyTitleFailure(error: unknown): TitleFailureKind {
  const view = providerErrorView(error);
  if (view === undefined) return "unknown";
  if (classifyFreeRouteRejection(view).rejected) return "free-route-gate";
  if (classifyFreeLimit(view).limited) return "rate-limit";
  if (classifyTransientAvailability(view).transient) return "transient";
  if (view.status === 401 || view.status === 403 || view.type === "provider.auth") return "auth";
  return "unknown";
}

/**
 * Walk the error the promise plugin host surfaced. OpenCode errors are plain
 * objects with `message`/`status`/`type`/`_tag`; an AI SDK wrapper may carry the
 * original one in `cause`.
 */
export function providerErrorView(error: unknown): ProviderErrorView | undefined {
  let current: unknown = error;
  const view: {
    type?: string;
    tag?: string;
    message?: string;
    status?: number;
    response?: { body?: string };
  } = {};
  let found = false;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current !== "object") break;
    const candidate = current as {
      type?: unknown;
      _tag?: unknown;
      message?: unknown;
      status?: unknown;
      cause?: unknown;
      response?: { body?: unknown };
    };
    if (typeof candidate.type === "string" && view.type === undefined) view.type = candidate.type;
    if (typeof candidate._tag === "string" && view.tag === undefined) view.tag = candidate._tag;
    if (typeof candidate.message === "string" && view.message === undefined) {
      view.message = candidate.message;
      found = true;
    }
    if (typeof candidate.status === "number" && view.status === undefined) {
      view.status = candidate.status;
      found = true;
    }
    if (typeof candidate.response?.body === "string" && view.response === undefined) {
      view.response = { body: candidate.response.body };
    }
    current = candidate.cause;
  }
  return found ? view : undefined;
}

/* ------------------------------------------------------------------ ports */

export interface TitleSessionInfo {
  readonly title?: string | undefined;
  readonly model?: ModelRef | undefined;
  readonly parentID?: string | undefined;
}

export interface TitleSessionsPort {
  /** The first durable user message, as OpenCode's own title generator sees it. */
  firstUserText(sessionID: string): Promise<string | undefined>;
  /** `session.generate`: tool-bearing, session-context, no mutation. */
  generate(input: { readonly sessionID: string; readonly prompt: string }): Promise<{
    readonly text: string;
  }>;
  get(input: { readonly sessionID: string }): Promise<TitleSessionInfo | undefined>;
  /** Verbatim rename through the supported plugin session API. */
  rename(input: { readonly sessionID: string; readonly title: string }): Promise<void>;
}

export interface TitleRoutingPort {
  /** True when the router itself would spend a free request right now. */
  freeRouteSpendable(): boolean;
}

export interface TitleCompatibilityOptions {
  readonly primary: ModelRef;
  readonly sessions: TitleSessionsPort;
  readonly routing: TitleRoutingPort;
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface TitleCompatibilityStats {
  /** Title hooks taken over on the free route. */
  readonly attempted: number;
  /** First-prompt titles supplied by the hook. */
  readonly fallback: number;
  /** Fallback titles replaced by a real generation. */
  readonly generated: number;
  /** Title hooks left to OpenCode (non-free model or no first prompt). */
  readonly delegated: number;
  /** Upgrades skipped because the session was not on a spendable free route. */
  readonly skipped: number;
  /** Generation attempts that failed. */
  readonly failed: number;
}

interface FallbackRecord {
  readonly title: string;
  attempts: number;
}

/** Bound on the memory-only fallback records; a restart simply keeps the title. */
const MAX_FALLBACK_RECORDS = 100;
/** Bounded later-generation attempts per fallback title. */
const MAX_UPGRADE_ATTEMPTS = 3;

export class TitleCompatibility {
  readonly #options: TitleCompatibilityOptions;
  readonly #fallbacks = new Map<string, FallbackRecord>();
  readonly #inFlight = new Set<string>();
  readonly #stats: {
    attempted: number;
    fallback: number;
    generated: number;
    delegated: number;
    skipped: number;
    failed: number;
  } = {
    attempted: 0,
    fallback: 0,
    generated: 0,
    delegated: 0,
    skipped: 0,
    failed: 0,
  };

  constructor(options: TitleCompatibilityOptions) {
    this.#options = options;
  }

  stats(): TitleCompatibilityStats {
    return { ...this.#stats };
  }

  /** True only for the configured free primary; every other model keeps native titles. */
  isPrimary(model: Pick<ModelRef, "providerID" | "id"> | undefined): boolean {
    return sameModel(model, this.#options.primary);
  }

  /**
   * The `title` hook. On the free primary it supplies the deterministic
   * first-prompt title without any provider request; elsewhere it returns
   * `undefined` and OpenCode generates natively.
   */
  async onTitle(input: {
    readonly sessionID: string;
    readonly model: ModelRef;
  }): Promise<string | undefined> {
    if (!this.isPrimary(input.model)) {
      this.#stats.delegated += 1;
      return undefined;
    }
    this.#stats.attempted += 1;
    const fallback = await this.#fallbackFor(input.sessionID);
    const info = await this.#sessionInfo(input.sessionID);
    // An explicit regeneration (an empty rename) happens with no turn in flight.
    // Generate immediately; a failure keeps the existing title untouched.
    if (info !== undefined && info.title !== undefined && !isUntitled(info.title)) {
      return this.#regenerate(input, info.title);
    }
    if (fallback === undefined) {
      this.#stats.delegated += 1;
      return undefined;
    }
    this.#remember(input.sessionID, fallback);
    this.#stats.fallback += 1;
    this.#options.logger.info("first-prompt title supplied for the free route", {
      requestKind: "title",
      model: `${input.model.providerID}/${input.model.id}`,
      outcome: "fallback",
      chars: fallback.length,
    });
    return fallback;
  }

  async #regenerate(
    input: { readonly sessionID: string; readonly model: ModelRef },
    existing: string,
  ): Promise<string | undefined> {
    if (this.#inFlight.has(input.sessionID)) return existing;
    if (!this.#options.routing.freeRouteSpendable()) {
      this.#stats.skipped += 1;
      return existing;
    }
    const started = this.#now();
    try {
      const result = await this.#options.sessions.generate({
        sessionID: input.sessionID,
        prompt: TITLE_PROMPT,
      });
      const title = cleanGeneratedTitle(result.text);
      if (title === undefined || title === existing) return existing;
      this.#stats.generated += 1;
      this.#options.logger.info("free title regenerated through a tool-bearing request", {
        requestKind: "title",
        model: `${input.model.providerID}/${input.model.id}`,
        outcome: "generated",
        chars: title.length,
        durationMs: this.#now() - started,
      });
      return title;
    } catch (error) {
      this.#stats.failed += 1;
      this.#options.logger.info("free title regeneration failed; keeping the existing title", {
        requestKind: "title",
        model: `${input.model.providerID}/${input.model.id}`,
        outcome: "failed",
        failure: classifyTitleFailure(error),
        durationMs: this.#now() - started,
      });
      return existing;
    }
  }

  async #sessionInfo(sessionID: string): Promise<TitleSessionInfo | undefined> {
    try {
      return await this.#options.sessions.get({ sessionID });
    } catch (error) {
      this.#options.logger.error("session lookup failed", {
        requestKind: "title",
        detail: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * A native title request on a paid route failed at the HTTP boundary.
   * OpenCode swallows it, so write the deterministic fallback through the
   * supported session API before the conversation is left unnamed.
   */
  async onNativeFailure(input: {
    readonly sessionID: string;
    readonly model: ModelRef;
    readonly status: number;
  }): Promise<void> {
    if (this.isPrimary(input.model)) return;
    if (this.#inFlight.has(input.sessionID)) return;
    try {
      const info = await this.#options.sessions.get({ sessionID: input.sessionID });
      if (info === undefined || info.parentID !== undefined) return;
      if (!isUntitled(info.title)) return;
      const fallback = await this.#fallbackFor(input.sessionID);
      if (fallback === undefined) return;
      await this.#options.sessions.rename({ sessionID: input.sessionID, title: fallback });
      this.#remember(input.sessionID, fallback);
      this.#stats.fallback += 1;
      this.#options.logger.info("native title failed; wrote the first-prompt fallback", {
        requestKind: "title",
        model: `${input.model.providerID}/${input.model.id}`,
        outcome: "fallback",
        status: input.status,
        failure: classifyTitleStatus(input.status),
        chars: fallback.length,
      });
    } catch (error) {
      this.#options.logger.error("native title fallback failed", {
        requestKind: "title",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Called when a turn settles. The fallback written before the turn gets its
   * real generated title now, using the route the session actually settled on.
   */
  onSettled(sessionID: string): void {
    this.#upgradeLater(sessionID);
  }

  /** A later user message is one more bounded chance if the settle hook missed. */
  onPrompt(sessionID: string): void {
    this.#upgradeLater(sessionID);
  }

  #upgradeLater(sessionID: string): void {
    const record = this.#fallbacks.get(sessionID);
    if (record === undefined) return;
    if (this.#inFlight.has(sessionID)) return;
    if (record.attempts >= MAX_UPGRADE_ATTEMPTS) {
      this.#fallbacks.delete(sessionID);
      return;
    }
    void this.#upgrade(sessionID, record).catch((error: unknown) => {
      this.#options.logger.error("title upgrade failed", {
        requestKind: "title",
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #upgrade(sessionID: string, record: FallbackRecord): Promise<void> {
    const info = await this.#options.sessions.get({ sessionID });
    if (info === undefined) {
      this.#fallbacks.delete(sessionID);
      return;
    }
    // The title is not stored yet (or the session is in a child state): keep the
    // record so the next prompt or settle boundary can try again.
    if (info.title === undefined) return;
    // A manual rename (or any other title) always wins; stop tracking.
    if (info.title !== record.title) {
      this.#fallbacks.delete(sessionID);
      return;
    }
    // Paid fallback sessions keep the prompt-derived title: generating there
    // would be an extra paid request that the native title path would not make.
    if (!this.isPrimary(info.model) || !this.#options.routing.freeRouteSpendable()) {
      this.#stats.skipped += 1;
      return;
    }
    record.attempts += 1;
    this.#inFlight.add(sessionID);
    const started = this.#now();
    try {
      const result = await this.#options.sessions.generate({ sessionID, prompt: TITLE_PROMPT });
      const title = cleanGeneratedTitle(result.text);
      if (title === undefined || title === record.title) return;
      // Re-read immediately before renaming: a manual rename in the meantime wins.
      const current = await this.#options.sessions.get({ sessionID });
      if (current === undefined || current.title !== record.title) {
        this.#fallbacks.delete(sessionID);
        return;
      }
      await this.#options.sessions.rename({ sessionID, title });
      this.#fallbacks.delete(sessionID);
      this.#stats.generated += 1;
      this.#options.logger.info("first-prompt title replaced by a generated title", {
        requestKind: "title",
        model: `${this.#options.primary.providerID}/${this.#options.primary.id}`,
        outcome: "generated",
        chars: title.length,
        attempts: record.attempts,
        durationMs: this.#now() - started,
      });
    } catch (error) {
      this.#stats.failed += 1;
      this.#options.logger.info("title generation failed; keeping the first-prompt title", {
        requestKind: "title",
        model: `${this.#options.primary.providerID}/${this.#options.primary.id}`,
        outcome: "failed",
        failure: classifyTitleFailure(error),
        attempts: record.attempts,
        durationMs: this.#now() - started,
      });
    } finally {
      this.#inFlight.delete(sessionID);
    }
  }

  async #fallbackFor(sessionID: string): Promise<string | undefined> {
    const known = this.#fallbacks.get(sessionID);
    if (known !== undefined) return known.title;
    try {
      const text = await this.#options.sessions.firstUserText(sessionID);
      return promptTitle(text);
    } catch (error) {
      this.#options.logger.error("first prompt lookup failed", {
        requestKind: "title",
        detail: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  #remember(sessionID: string, title: string): void {
    this.#fallbacks.delete(sessionID);
    this.#fallbacks.set(sessionID, { title, attempts: 0 });
    while (this.#fallbacks.size > MAX_FALLBACK_RECORDS) {
      const oldest = this.#fallbacks.keys().next().value;
      if (oldest === undefined) break;
      this.#fallbacks.delete(oldest);
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

function classifyTitleStatus(status: number): TitleFailureKind {
  if (status === 429) return "rate-limit";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "transient";
  return "unknown";
}
