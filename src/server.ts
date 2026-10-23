/**
 * opencode-free-first — plugin entrypoint (OpenCode v2 server surface).
 *
 * Wires the engine to OpenCode's supported extension points:
 *
 *  - `model.transform`  publishes the free model as the default selection and
 *                       captures each model's variant ids.
 *  - `prompt`           converges session routing before a turn resolves its model.
 *  - `context`          observes request preparation (park detection) and
 *                       performs passive recovery at a safe boundary.
 *  - `model.request`    confirms a request is about to be dispatched.
 *  - `http.response`    proves free health and captures reset metadata.
 *  - `retry`            fails the same session over to the fallback model on a
 *                       genuine free-model rate limit.
 *  - `generate`         bounds the recovery probe's output.
 *  - `event.subscribe`  tracks session execution and explicit model selection.
 *
 * Nothing here schedules paid work, proxies a provider, or stores credentials.
 */

import { Plugin } from "@opencode/plugin";
import type { FreeFirstConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import type { Clock, ExecutionEvent, RetryInput, StateStore } from "./engine.js";
import { FreeFirstEngine } from "./engine.js";
import { createLogger } from "./log.js";
import {
  createPaidHoldPort,
  createPricingPort,
  OFFPEAK_CANCEL_HOLD_RPC,
  OFFPEAK_PRICING_RPC,
} from "./offpeak.js";
import type { FreeFirstRpcOutput } from "./rpc.js";
import { FREE_FIRST_RPC, handleFreeFirstControl } from "./rpc.js";
import type { ModelRef } from "./types.js";
import { modelRefKey } from "./types.js";

const MAX_PROBE_DELAY_MS = 2_147_483_000;

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, Math.min(Math.max(0, delayMs), MAX_PROBE_DELAY_MS));
    const unrefable = handle as unknown as { unref?: () => void };
    if (typeof unrefable.unref === "function") unrefable.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
  },
};

export default Plugin.define({
  id: "opencode-free-first",
  setup: async (context) => {
    const resolved = resolveConfig({ options: context.options });
    const logger = createLogger(resolved.config.logLevel);
    if (resolved.error !== undefined) {
      // Fail open: the plugin disables itself instead of guessing at a route.
      logger.error("free-first configuration invalid; plugin disabled", {
        error: resolved.error,
      });
    }
    const config: FreeFirstConfig =
      resolved.error === undefined ? resolved.config : { ...resolved.config, enabled: false };
    if (resolved.source !== undefined)
      logger.info("loaded configuration file", { path: resolved.source });

    logger.info("loading", {
      version: context.app.version,
      directory: context.location?.directory ?? "",
      enabled: config.enabled,
      primary: modelRefKey(config.primary),
      fallback:
        config.fallback === undefined
          ? "session-previous-or-default"
          : modelRefKey(config.fallback),
      cooldownScope: config.cooldownScope,
    });

    const storage: StateStore = {
      get: (key) => context.storage.get(key) as Promise<unknown>,
      set: (key, value) => context.storage.set(key, value as never),
      remove: (key) => context.storage.remove(key),
    };

    let engine: FreeFirstEngine;
    // Set while the engine is running an out-of-band recovery probe, so the
    // `generate` hook can bound the probe's output without touching any other
    // caller's settings.
    let probing = false;

    const modelIsPrimary = (model: { providerID: string; id: string } | undefined): boolean =>
      model !== undefined &&
      model.providerID === config.primary.providerID &&
      model.id === config.primary.id;

    const asRef = (model: {
      providerID: string;
      id: string;
      variant?: string | undefined;
    }): ModelRef => ({
      providerID: model.providerID,
      id: model.id,
      ...(model.variant === undefined ? {} : { variant: model.variant }),
    });

    // The neighbour plugin's generic hold cancellation. It is optional: an
    // absent or older opencode-offpeak reports failure, and reclamation keeps
    // its interrupt-based fallback instead of guessing.
    const paidHolds =
      config.parkPreemption && resolved.error === undefined
        ? createPaidHoldPort(
            (input) => context.rpc(OFFPEAK_CANCEL_HOLD_RPC).cancelHold({ ...input }),
            (error) => {
              logger.error(
                "opencode-offpeak cancelled-hold capability is unavailable; reclamation falls back to interruption",
                { detail: error instanceof Error ? error.message : String(error) },
              );
            },
          )
        : undefined;

    // The canonical pricing classification. It is owned by opencode-offpeak;
    // this plugin only consumes it. The port is always wired (it does nothing
    // until evaluated) because the mode can be switched to `peak-only` at
    // runtime from the TUI or the control RPC.
    const pricing =
      resolved.error === undefined
        ? createPricingPort(
            (input) => context.rpc(OFFPEAK_PRICING_RPC).pricing({ ...input }),
            (error) => {
              logger.error(
                "opencode-offpeak pricing capability is unavailable; peak-only cannot confirm PEAK",
                { detail: error instanceof Error ? error.message : String(error) },
              );
            },
          )
        : undefined;

    engine = new FreeFirstEngine({
      config,
      clock,
      storage,
      logger,
      ...(paidHolds === undefined ? {} : { paidHolds }),
      ...(pricing === undefined ? {} : { pricing }),
      random: Math.random,
      onError: (error) => {
        logger.error("background failure", {
          detail: error instanceof Error ? error.message : String(error),
        });
      },
      onProbeState: (active) => {
        probing = active;
      },
      onModeChanged: async (mode) => {
        // Rebuild the model registry before the next step resolves its model,
        // so a mode change is reflected in the default selection immediately.
        logger.info("free usage mode applied; reloading model defaults", { mode });
        await context.model.reload();
      },
      sessions: {
        switchModel: async ({ sessionID, model }) => {
          await context.session.switchModel({
            sessionID: sessionID as never,
            model: {
              providerID: model.providerID,
              id: model.id,
              ...(model.variant === undefined ? {} : { variant: model.variant }),
            } as never,
          });
        },
        synthetic: async ({ sessionID, text, delivery, resume }) => {
          await context.session.synthetic({
            sessionID: sessionID as never,
            text,
            delivery,
            resume,
          });
        },
        interrupt: async ({ sessionID }) => {
          const result = await context.session.interrupt({ sessionID: sessionID as never });
          return { interrupted: result?.interrupted === true };
        },
        wait: async ({ sessionID }) => {
          await context.session.wait({ sessionID: sessionID as never });
        },
        get: async ({ sessionID }) => {
          const session = await context.session.get({ sessionID: sessionID as never });
          const model = (
            session as { model?: { providerID: string; id: string; variant?: string } }
          ).model;
          return model === undefined ? {} : { model: asRef(model) };
        },
      },
      generate: {
        text: async ({ model, prompt }) => {
          const variant = model.variant === undefined ? {} : { variant: model.variant };
          return context.generate.text({
            model: { providerID: model.providerID, id: model.id, ...variant } as never,
            prompt,
          });
        },
      },
    });

    const registrations: Array<{ dispose: () => Promise<void> }> = [];

    // Restore persisted derived state first: a mode saved from the TUI must
    // decide the initial pricing query and the published default model.
    await engine.start();

    // Resolve the canonical pricing classification before publishing a default,
    // so an off-peak start never advertises the free route.
    if (engine.mode === "peak-only" && resolved.error === undefined) {
      const snapshot = await engine.refreshPricing(true);
      logger.info("free usage policy resolved", {
        freeUsageMode: engine.mode,
        configuredFreeUsageMode: engine.configuredMode,
        modeSource: engine.modeSource,
        pricingState: snapshot?.state ?? "UNKNOWN",
        nextTransition: snapshot?.nextTransition,
      });
    }

    /* ------------------------------------------------- default + variants */

    const transform = await context.model.transform((editor) => {
      const variants = new Map<string, string[]>();
      for (const model of editor.list()) {
        variants.set(
          `${String(model.providerID)}/${String(model.id)}`,
          (model.variants ?? []).map((variant) => String(variant.id)),
        );
      }
      engine.setVariantIndex(variants);

      // Capture OpenCode's own default before this transform replaces it, so a
      // session can fall back to what the operator had configured.
      const current = editor.default.get();
      const currentProvider = current === undefined ? undefined : String(current.providerID);
      const currentModel = current === undefined ? undefined : String(current.modelID);
      if (
        currentProvider !== undefined &&
        currentModel !== undefined &&
        !(currentProvider === config.primary.providerID && currentModel === config.primary.id) &&
        !(
          config.fallback !== undefined &&
          currentProvider === config.fallback.providerID &&
          currentModel === config.fallback.id
        )
      ) {
        engine.rememberDefault({ providerID: currentProvider, id: currentModel });
      }
      if (config.enabled && engine.mode !== "off" && config.preferAsDefault) {
        const preferred = engine.defaultTarget();
        const target = editor.get(preferred.providerID, preferred.id);
        if (target === undefined) {
          engine.rememberPublishedDefault(undefined);
          logger.error(
            "preferred model is not available; leaving the default selection unchanged",
            {
              preferred: modelRefKey(preferred),
            },
          );
        } else {
          editor.default.set(preferred.providerID, preferred.id);
          engine.rememberPublishedDefault(preferred);
        }
      } else {
        engine.rememberPublishedDefault(undefined);
      }
    });
    registrations.push(transform);

    /* ------------------------------------------------------------ hooks */

    registrations.push(
      await context.session.hook("prompt", async (event) => {
        if (!config.enabled) return;
        try {
          await engine.onPrompt(String(event.sessionID));
        } catch (error) {
          logger.error("prompt hook failed", {
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    registrations.push(
      await context.session.hook("context", async (event) => {
        if (!config.enabled) return;
        try {
          await engine.onContext(String(event.sessionID), asRef(event.model));
        } catch (error) {
          logger.error("context hook failed", {
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    registrations.push(
      await context.session.hook("model.request", async (event) => {
        if (!config.enabled) return;
        try {
          engine.onModelRequest(String(event.sessionID), asRef(event.model), event.kind);
        } catch (error) {
          logger.error("model.request hook failed", {
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    registrations.push(
      await context.session.hook(
        "http.response",
        async (event) => {
          if (!config.enabled) return;
          if (!modelIsPrimary(event.model)) return;
          try {
            engine.onHttpHeaders(String(event.sessionID), headersToRecord(event.response.headers));
            engine.onHttpResponse({
              sessionID: String(event.sessionID),
              model: asRef(event.model),
              status: event.response.status,
            });
          } catch (error) {
            logger.error("http.response hook failed", {
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        },
        { providerID: config.primary.providerID },
      ),
    );

    // Unscoped on purpose: failover decisions belong to the free model, and the
    // resume-after-refusal decision belongs to the fallback model.
    registrations.push(
      await context.session.hook("retry", async (event) => {
        if (!config.enabled) return;
        try {
          const input: RetryInput = {
            sessionID: String(event.sessionID),
            model: asRef(event.model),
            error: {
              ...(typeof event.error.type === "string" ? { type: event.error.type } : {}),
              ...(typeof event.error.message === "string" ? { message: event.error.message } : {}),
              ...(typeof event.error.status === "number" ? { status: event.error.status } : {}),
              ...(event.error.response?.body === undefined
                ? {}
                : { response: { body: event.error.response.body } }),
            },
            attempt: event.attempt,
            decision: event.decision,
          };
          await engine.onRetry(input);
          // The engine owns the decision; copy it back onto the live event so
          // OpenCode actually schedules the failover retry.
          event.decision = input.decision;
        } catch (error) {
          logger.error("retry hook failed", {
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    // Bound the recovery probe's output. Only requests issued while a probe is
    // running are touched, so a `generate` call from any other caller keeps its
    // own settings.
    registrations.push(
      await context.session.hook("generate", async (event) => {
        if (!config.enabled) return;
        if (!probing) return;
        if (modelIsPrimary(event.model)) event.options.maxTokens = config.probeMaxTokens;
      }),
    );

    /* ------------------------------------------------------------ events */

    const abort = new AbortController();
    const events = (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: abort.signal })) {
          if (abort.signal.aborted) break;
          if (config.enabled) handleEvent(event);
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          logger.error("event stream failed", {
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    function handleEvent(event: { type: string; data?: unknown }): void {
      const data = event.data as Record<string, unknown> | undefined;
      if (data === undefined) return;
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
      if (sessionID === undefined) return;
      try {
        switch (event.type) {
          case "session.execution.started":
            engine.onExecution({ sessionID, phase: "started" } satisfies ExecutionEvent);
            return;
          case "session.execution.succeeded":
            engine.onExecution({ sessionID, phase: "settled", outcome: "succeeded" });
            return;
          case "session.execution.failed":
            engine.onExecution({ sessionID, phase: "settled", outcome: "failed" });
            return;
          case "session.execution.interrupted":
            engine.onExecution({ sessionID, phase: "settled", outcome: "interrupted" });
            return;
          case "session.model.selected": {
            const model = data.model as
              | { providerID?: unknown; id?: unknown; variant?: unknown }
              | undefined;
            if (
              model === undefined ||
              typeof model.providerID !== "string" ||
              typeof model.id !== "string"
            ) {
              return;
            }
            const previous = data.previous as
              | { providerID?: unknown; id?: unknown; variant?: unknown }
              | undefined;
            if (
              previous !== undefined &&
              typeof previous.providerID === "string" &&
              typeof previous.id === "string"
            ) {
              engine.rememberPrevious(
                sessionID,
                asRef(previous as { providerID: string; id: string; variant?: string }),
              );
            }
            engine.onModelSelected({
              sessionID,
              model: asRef(model as { providerID: string; id: string; variant?: string }),
              ...(previous !== undefined &&
              typeof previous.providerID === "string" &&
              typeof previous.id === "string"
                ? {
                    previous: asRef(
                      previous as { providerID: string; id: string; variant?: string },
                    ),
                  }
                : {}),
            });
            return;
          }
          default:
        }
      } catch (error) {
        logger.error("event handling failed", {
          type: event.type,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    /* --------------------------------------------------------------- rpc */

    const rpc = await context.rpc.register(FREE_FIRST_RPC, {
      control: async (rawInput: unknown): Promise<FreeFirstRpcOutput> => {
        const output = await handleFreeFirstControl(engine, rawInput);
        if (output.mode !== undefined) {
          // The engine already rebuilt this location's model defaults through
          // `onModeChanged`. Every location has its own plugin instance, so the
          // event lets the others adopt the same saved mode now instead of at
          // their next prompt.
          try {
            await rpc.events.emit("transition", {
              to: output.mode,
              reason: "mode-change",
            });
          } catch (error) {
            logger.error("failed to propagate a mode change", {
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return output;
      },
    });
    registrations.push(rpc);

    const rpcClient = context.rpc(FREE_FIRST_RPC);
    const unsubscribeMode = rpcClient.events.on("transition", (event) => {
      if (event.data.reason !== "mode-change") return;
      void (async () => {
        if (!(await engine.syncMode())) return;
        await engine.refresh();
        logger.info("adopted a mode saved by another location", { mode: engine.mode });
      })().catch((error) => {
        logger.error("failed to adopt a mode saved by another location", {
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    });
    registrations.push({ dispose: async () => unsubscribeMode() });

    logger.info("ready", { status: engine.statusLine() });

    return async () => {
      abort.abort();
      await events;
      for (const registration of registrations.reverse()) {
        try {
          await registration.dispose();
        } catch (error) {
          logger.error("failed to dispose a registration", {
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await engine.dispose();
      logger.info("unloaded");
    };

    function headersToRecord(headers: Headers): Record<string, string> {
      const out: Record<string, string> = {};
      headers.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
  },
});
