# opencode-free-first

Prefer a free OpenCode model, and keep working when its free tier runs out.

`opencode-free-first` is an [OpenCode](https://opencode.ai/v2/docs/) v2 plugin
that owns exactly one concern: **is the free model usable right now?** It routes
sessions to the configured free model, fails the *same* session over to the
configured fallback model the moment the free model genuinely rate limits, waits
out the cooldown with bounded backoff, and returns the same session to the free
model once recovery is confirmed — without a second prompt, a manual model
change, a restart, or any interruption of productive work.

```
FREE  →  rate limit  →  fallback  →  cooldown  →  FREE recovery  →  FREE  →  …
```

Nothing here is a new provider stack, a proxy, a scheduler, or a queue. Real
paid work keeps flowing through OpenCode's normal routing, so a cost/time policy
plugin such as [`opencode-offpeak`](https://github.com/lutzkind/opencode-offpeak)
stays in charge of *when* paid work runs.

## Contents

- [What it does](#what-it-does)
- [What it does not do](#what-it-does-not-do)
- [Install](#install)
- [Configure](#configure)
- [Coexistence](#coexistence)
- [How it decides](#how-it-decides)
- [Cache behaviour](#cache-behaviour)
- [Recovery limitations](#recovery-limitations)
- [Diagnostics](#diagnostics)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Development](#development)
- [Compatibility](#compatibility)
- [License](#license)

## What it does

1. **Publishes the free model as the default selection**, so new sessions start
   on it (`preferAsDefault`).
2. **Tracks which sessions are managed.** A session is managed while it is on
   the free model, or after this plugin moved it to the fallback.
3. **Classifies free-model rate limits conservatively.** Only HTTP `429`, the
   structured `provider.rate-limit` / `provider.quota` error types OpenCode
   produces, or explicitly scoped exhaustion wording count. A `400`, a `401`, a
   `500`, a tool failure, a malformed request, a provider outage, or a plugin bug
   keeps its real failure type and stays visible.
4. **Fails over in the same session.** On a genuine free-model limit the plugin
   records an absolute cooldown, switches that session's model to the configured
   fallback, and lets OpenCode's own retry re-resolve the model. The retry
   re-enters the *same* turn: same conversation, same agent, same working
   directory, same tool state, one prompt, no replayed tool calls.
5. **Honours the provider's reset metadata.** `Retry-After`, `Retry-After-Ms`,
   `x-ratelimit-reset*`, a structured reset timestamp in the error payload, or a
   reset phrase in the message are all used when present.
6. **Backs off when the reset time is unknown.** A bounded ladder
   (1m, 2m, 5m, 10m, 15m, 15m, …) with bounded jitter, all of it configurable.
7. **Recovers without thrash.** At cooldown expiry one tiny out-of-band request
   settles free health before any session is moved. A probe that is rate limited
   changes nothing for a productive fallback session; a probe that merely fails is
   treated as *unknown*, so it can never keep the free model blocked.
8. **Reclaims parked paid work.** If another plugin holds the fallback request
   (for example an off-peak pricing policy), and the free model recovers first,
   the plugin cancels the obsolete paid attempt, neutralises the parking
   plugin's own pending continuation, and resumes the same task on the free
   model with one invisible continuation step.
9. **Respects explicit model choices.** A manual change to an unrelated model —
   or to the paid route — stops free-first from managing that session.

## What it does not do

- It does **not** implement off-peak scheduling, price windows, holidays, or
  queues. That belongs to a cost/time policy plugin.
- It does **not** proxy providers, add endpoints, or hold credentials of its own.
  It reuses OpenCode's existing provider configuration and credentials.
- It does **not** implement its own paid routing. The fallback is an ordinary
  OpenCode model, so every existing policy plugin sees it exactly as before.
- It does **not** replace or require `opencode-offpeak`, or duplicate any
  scheduler, queue, timer, or database.
- It does **not** add a daemon, a database, a Redis instance, an external queue,
  or a systemd unit.
- It does **not** retry a rate-limited free model in a loop. That is the
  behaviour it exists to remove.

## Install

OpenCode v2 accepts npm-compatible package specifications, including Git URLs
and exact tags. Install the published release:

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-free-first.git#v0.1.6
opencode plugin list
```

A local checkout works too, which is handy for development:

```sh
opencode plugin add /absolute/path/to/opencode-free-first
```

OpenCode caches installed plugins under its own package cache and loads the
plugin's TypeScript source directly on Bun, so no build step is involved in
installing. `npm run compile` exists for type checking, tests, and Node consumers.

## Configure

Options go in the OpenCode plugin entry, which is the recommended form because it
keeps everything in one file:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.6",
    {
      "package": "opencode-free-first",
      "options": {
        "primary": { "providerID": "opencode", "id": "deepseek-v4.1-flash-free" },
        "fallback": { "providerID": "opencode-go", "id": "deepseek-v4.1-flash" }
      }
    }
  ]
}
```

A JSON configuration file is also read from
`$XDG_CONFIG_HOME/opencode/free-first.json` (default
`~/.config/opencode/free-first.json`). Plugin options override the file. Both
accept the same keys; a bare object or a `{ "freeFirst": { … } }` wrapper work.

With no configuration at all the plugin prefers
`opencode/deepseek-v4.1-flash-free` and, when it needs a fallback, uses the
model the session was on before, then OpenCode's own configured default.

See [`docs/configuration.md`](docs/configuration.md) for every option, its
default, and when to change it.

## Coexistence

`opencode-free-first` and a paid cost/time policy plugin such as
`opencode-offpeak` are independent and complementary:

| Plugin | Owns |
| --- | --- |
| `opencode-free-first` | free-model availability, rate-limit failover, recovery |
| `opencode-offpeak` | paid-route timing and cost policy |

They are independently installable, configurable, enableable, disableable,
testable, and publishable. Neither imports the other, neither shares state, and
neither duplicates the other's responsibility.

Two ordering facts matter, and both are verified by the live coexistence suite
(`npm run test:integration`):

- Free-first's `retry` hook must run **after** any plugin that can veto a retry,
  so list `opencode-free-first` **after** `opencode-offpeak`. The plugin logs a
  transition either way, but the failover retry needs the last word.
- Free-first never delays, queues, or prices paid work. When the fallback route
  is peak-priced it is held by the policy plugin, the session is parked, and
  free-first reclaims it only after the free model is confirmed healthy.

Free-model traffic through OpenCode Zen is documented by OpenCode as flat
priced, so a correctly configured policy plugin treats it as untracked or flat
and never delays it. See [`docs/coexistence.md`](docs/coexistence.md).

## How it decides

```
FREE_HEALTHY  -- genuine free-model rate limit -->  FREE_COOLDOWN
FREE_COOLDOWN -- cooldown reached               -->  FREE_PROBE
FREE_PROBE    -- success                       -->  FREE_HEALTHY
FREE_PROBE    -- rate limited                  -->  FREE_COOLDOWN (level + 1)
FREE_PROBE    -- inconclusive                  -->  FREE_COOLDOWN (level kept)
```

`FREE_PROBE` is derived, not stored: it is what `FREE_COOLDOWN` means once its
absolute timestamp has passed and health is not yet confirmed. Cooldowns are
absolute epoch milliseconds and always persisted, so a timer is a convenience and
never the source of truth. A restart restores a future cooldown, discards an
expired one, ignores corrupt derived state, and never probes merely because
OpenCode restarted.

Full detail, including the park-reclamation sequence, is in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Cache behaviour

Switching models can invalidate a provider-side prompt/KV cache even though the
OpenCode session history is completely intact. Cache loss is a cost and latency
concern, not a context-loss concern — the same conversation, agent, and working
directory continue.

This plugin therefore minimises real model transitions:

- While the free model is healthy it stays selected and nothing switches.
- The switch to the fallback happens **once**, on the first genuine rate limit.
- Recovery is confirmed by a tiny out-of-band probe issued with
  `ctx.generate.text`, which creates no session, invokes no tools, and never
  touches session history. The main session is not switched merely to test it.
- A failed probe does not change the main session's model at all.
- The session returns to the free model **once**, after recovery is confirmed,
  and stays there until the next genuine rate limit.
- The plugin never alternates models per request, never switches mid-stream, and
  never interrupts an active tool call.

A complete free-limit cycle costs exactly two transitions: free → fallback and
fallback → free. The test suite asserts this.

It does **not** keep the paid fallback warm with synthetic traffic: there is no
evidence that would pay for the paid tokens, so no paid request is ever made for
cache reasons.

## Recovery limitations

- **With a reset time**, the plugin waits for it and does not probe before it.
  `Retry-After`, `Retry-After-Ms`, `x-ratelimit-reset`,
  `x-ratelimit-reset-requests`, a reset timestamp in the payload, or a
  "try again in N seconds" phrase all count.
- **Without a reset time** the provider gave no information, so the plugin uses a
  bounded backoff ladder with jitter. Each failure on the ladder moves to the
  next (longer) delay, capped by `maxCooldownMs`; a confirmed recovery resets it.
  This is bounded probing, not a promise that recovery is instant.
- **Scope.** A free tier is normally limited per provider account, so the
  cooldown is shared across sessions by default (`cooldownScope: "shared"`) and
  at most one probe is ever in flight. Set `"session"` if evidence shows your
  provider limits per session.
- **Probes need a usable route.** The probe uses the real configured free model
  through OpenCode's normal routing. If the host refuses that path — OpenCode's own
  free tier does, because transient generation is not the agent loop — the refusal
  is logged at `error`, the probe backs off hard (`probeUnsupportedBackoffMs`,
  default 6h), and recovery switches to the passive path below. An inconclusive
  probe is *unknown*, never *limited*: it never blocks the free model, because a
  probe that cannot run is not evidence that the free model is unusable.
- **Passive recovery is the safety net.** When probing is disabled, deferred, or
  refused, the next real model call is the test: waiting sessions are returned to
  the free model at their next boundary, and a genuine limit simply re-establishes
  a real cooldown.

## Diagnostics

Read the live state through the plugin RPC:

```sh
opencode api post /api/rpc/opencode-free-first/control --data '{"action":"status"}'
```

`status` returns:

| Field | Meaning |
| --- | --- |
| `state` | `FREE_HEALTHY`, `FREE_COOLDOWN`, or `FREE_PROBE` |
| `status` | one-line summary: `FREE (…)`, `FREE cooldown: 8m`, `probing FREE` |
| `primary` / `fallback` | the effective routes |
| `cooldownMs` / `cooldownEndsAt` | remaining and absolute cooldown |
| `level` | position on the backoff ladder |
| `lastRateLimitAt` / `lastRateLimitType` | when and why the last limit was seen |
| `lastResetSource` | `retry-after`, `retry-after-ms`, `x-ratelimit-reset`, `reset-timestamp`, or `backoff` |
| `nextProbeAt` | when the next probe is due |
| `probeBackoffUntil` / `inconclusiveProbes` | probe back-off and how many probes failed to decide |
| `lastProbeOutcome` | `healthy`, `limited`, `unsupported`, or `inconclusive`, with the classification |
| `probedAt` / `lastHealthyAt` | the last probe and the last confirmed recovery |
| `managedSessions` / `fallbackSessions` | how many sessions are managed, and how many are on the fallback |
| `manualOverrides` | sessions the user explicitly repointed |
| `transitions` | the most recent model transitions, for switch-churn checks |

Other actions: `reset` clears a cooldown an operator knows is lifted, `on` and
`off` enable and disable routing. Core runtime behaviour never depends on the
RPC.

State transitions are also logged with the `[opencode-free-first]` prefix: free
selected, rate limit detected, classification reason, retry/reset source,
cooldown start and expiry, fallback selected, probe scheduled/started/limited,
free recovered, safe switch back to free, explicit manual override detected,
stale fallback continuation neutralized, duplicate continuation prevented. Logs
never contain prompts, response bodies, headers, or credentials.

Sanitised persisted state lives in OpenCode's plugin storage under
`opencode-free-first/health-v1` and `opencode-free-first/sessions-v1`.

## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md). The short version:

- Enable debug logging with `"logLevel": "debug"` to see every hook decision.
- If nothing changes at all, check that the plugin is listed and that the
  primary model id actually exists in `opencode models`.
- If failover does not fire, list `opencode-free-first` after any other plugin
  that can veto a retry.
- If the fallback never runs, check that the fallback provider is authenticated
  in OpenCode — this plugin never manages credentials.

## Uninstall

```sh
opencode plugin remove opencode-free-first
```

`opencode plugin remove` edits the global configuration and reconciles the
package cache. Optionally delete `~/.config/opencode/free-first.json` and the
cached package directory under `~/.cache/opencode/npm/`. OpenCode's plugin
storage for this plugin can be cleared with:

```sh
opencode api post /api/rpc/opencode-free-first/control --data '{"action":"off"}'
```

and then removing the `plugin:<id>:opencode-free-first/*` rows OpenCode keeps.
Uninstalling never touches sessions, prompts, credentials, or another plugin's
state.

## Development

```sh
npm install
npm run check                # lint + typecheck + unit tests
npm run test:integration     # real OpenCode CLI + real opencode-offpeak
npm run test:offpeak-regression
```

Unit tests are hermetic: every provider failure is injected through fakes, so no
free-tier quota is ever consumed. The integration suite runs the real CLI against
a deterministic OpenAI-compatible mock provider in a private XDG home, with
`opencode-offpeak` installed, and covers healthy routing, failover, still-limited
behaviour, failed probes, and parked-fallback reclamation.

See [`docs/development.md`](docs/development.md) and
[`docs/testing.md`](docs/testing.md).

## Compatibility

| Component | Version |
| --- | --- |
| OpenCode | `>=2.0.26 <2.1.0` (verified on `2.0.27`) |
| Node | `>=22` for the compiled entry; OpenCode runs the TypeScript source on Bun |
| `@opencode/plugin` | `2.0.26` |

`opencode-offpeak` is optional and never a dependency. Verified coexistence:
`opencode-offpeak` `v0.1.6` with OpenCode `2.0.27`.

## License

MIT. See [`LICENSE`](LICENSE).
