# opencode-free-first

Prefer a free OpenCode model, and keep working when its free route is down.

`opencode-free-first` is an [OpenCode](https://opencode.ai/v2/docs/) v2 plugin
that owns exactly one concern: **is the free model usable right now?** It routes
sessions to the configured free model, keeps the *same* session working on the
configured fallback model the moment the free route is temporarily unavailable —
a genuine rate limit, OpenCode's own free-tier eligibility gate, or a transient
provider outage such as an HTTP 500 — waits out the cooldown with bounded
backoff, and returns the same session to the free model once recovery is
confirmed. No second prompt, no manual model change, no restart, no interruption
of productive work.

```
FREE  →  rate limit / free-route gate / transient outage  →  fallback  →  cooldown  →  FREE recovery  →  FREE  →  …
```

The governing rule:

> Temporary free-route availability problems use the paid fallback. Permanent
> request, account, configuration, or plugin failures stay visible.

A second, opt-in rule controls *when* the free route may be spent:

> In `peak-only` mode, DeepSeek Free is used only while the configured paid
> fallback is in a verified PEAK pricing window. Off-peak, weekends, and Chinese
> statutory holidays route straight to the paid fallback and never probe Free.

Nothing here is a new provider stack, a proxy, a scheduler, or a queue. Real
paid work keeps flowing through OpenCode's normal routing, so a cost/time policy
plugin such as [`opencode-offpeak`](https://github.com/lutzkind/opencode-offpeak)
stays in charge of *when* paid work runs.

## Contents

- [What it does](#what-it-does)
- [What it does not do](#what-it-does-not-do)
- [Install](#install)
- [Configure](#configure)
- [Free usage modes](#free-usage-modes)
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
3. **Classifies free-route failures conservatively, in three categories.**
   - A genuine rate limit: HTTP `429`, the structured `provider.rate-limit` /
     `provider.quota` error types OpenCode produces, or explicitly scoped
     exhaustion wording.
   - OpenCode's own free-tier eligibility gate ("OpenCode's free tier can only be
     used from within OpenCode"), which makes the free *route* temporarily
     unavailable.
   - A transient availability failure: provider/server `500`/`502`/`503`/`504`,
     OpenCode's structured `provider.internal` or `provider.timeout`, or a
     transport failure OpenCode itself treats as transient (`ECONNRESET` and
     friends, `fetch failed`, a timeout).
   Everything else — a `400`, a `401`, a generic `403`, an invalid key, an
   invalid model, a content filter, a context-length error, a tool failure, a
   plugin bug, or an unclassified failure — keeps its real failure type and stays
   visible. A provider 500 is never recorded or presented as a rate limit, and a
   rate limit is never advanced by a 500.
4. **Fails over in the same session — immediately.** On any of the three causes
   the plugin records an absolute cooldown, switches that session's model to the
   configured fallback, and lets OpenCode's own retry re-resolve the model. The
   retry re-enters the *same* turn: same conversation, same agent, same working
   directory, same tool state, one prompt, no replayed tool calls.
5. **Honours the provider's reset metadata.** `Retry-After`, `Retry-After-Ms`,
   `x-ratelimit-reset*`, a structured reset timestamp in the error payload, or a
   reset phrase in the message are all used when present.
6. **Backs off when the reset time is unknown.** A bounded ladder
   (1m, 2m, 5m, 10m, 15m, 15m, …) with bounded jitter, all of it configurable.
   A transient outage walks the same bounded ladder on its own counter, so one
   isolated 500 blocks the free route for one short rung, never for hours, and
   repeated outages back off further.
7. **Recovers without thrash.** At cooldown expiry one tiny out-of-band request
   settles free health before any session is moved. A probe that is rate limited
   or still unavailable changes nothing for a productive fallback session; a
   probe that merely fails *inconclusively* is treated as unknown, so it can never
   keep the free model blocked.
8. **Never spends a request the cooldown already predicted.** While a cooldown is
   active, the sessions that can reach a step boundary without another hook —
   those with an active execution — are kept on the fallback, because that
   boundary is where OpenCode resolves an automatic compaction's model and a
   prepared compaction cannot change it on retry. A compaction that *discovers*
   a limit is still allowed to fail once: that request is the discovery. Idle
   sessions are left alone; prompt admission and request preparation route them.
9. **Reclaims parked paid work without interrupting the session.** If another
   plugin holds the fallback request (for example an off-peak pricing policy) and
   the free model recovers first, the plugin cancels the obsolete paid attempt
   through the parking plugin's generic hold cancellation, and the same
   execution continues on the free model. The held request is refused at the
   transport boundary, so it is never sent, no continuation input is admitted,
   and a headless `opencode run` stays attached until the task finishes.
10. **Respects explicit model choices.** A manual change to an unrelated model —
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
opencode plugin add git+https://github.com/lutzkind/opencode-free-first.git#v0.2.0
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
        "fallback": { "providerID": "opencode-go", "id": "deepseek-v4.1-flash" },
        "freeUsageMode": "peak-only"
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

## Free usage modes

`freeUsageMode` decides when the free route may be used. The default preserves
the historical behaviour of every existing installation.

| Mode | Behaviour |
| --- | --- |
| `always-free-first` (default) | Prefer Free whenever it is healthy, at any hour. Existing installations keep this unless they opt in. |
| `peak-only` | Use Free only when the canonical pricing owner positively reports **PEAK** for the configured fallback. `OFF_PEAK`, `FLAT`, `UNTRACKED`, and `UNKNOWN` all route to Go without a Free request or probe. Requires an explicit `fallback`. |
| `off` | Free-first routing is disabled. OpenCode's normal configured routing applies; no failover, recovery, probe, or default-model rewrite. |

```jsonc
{
  "package": "opencode-free-first",
  "options": {
    "primary": { "providerID": "opencode", "id": "deepseek-v4.1-flash-free" },
    "fallback": { "providerID": "opencode-go", "id": "deepseek-v4.1-flash" },
    "freeUsageMode": "peak-only"
  }
}
```

`peak-only` is deliberately strict. It never copies the weekly windows or the
Chinese holiday calendar: [`opencode-offpeak`](https://github.com/lutzkind/opencode-offpeak)
remains the sole canonical owner and exposes a read-only `pricing` RPC. A
missing or failed pricing capability is `UNKNOWN`, which is treated as
not-PEAK, so it cannot accidentally spend free quota. At OFF_PEAK, cooldowns are
left to expire silently, recovery probes are not sent, and every managed or
newly admitted session is routed to Go before its next step. At PEAK, the
existing 429, free-route-gate, and transient failover, cooldown, and recovery
behaviour is unchanged.

The status line and RPC expose the policy, the canonical pricing state, the next
pricing transition, and the active route (`FREE`, `GO`, `MIXED`, or `NONE`), so a
cooldown or fallback is never mistaken for the normal off-peak route.

## Coexistence

`opencode-free-first` and a paid cost/time policy plugin such as
`opencode-offpeak` are independent and complementary:

| Plugin | Owns |
| --- | --- |
| `opencode-free-first` | free-model availability, rate-limit failover, recovery, free-usage mode |
| `opencode-offpeak` | paid-route timing and cost policy — the sole PEAK/OFF_PEAK authority |

They are independently installable, configurable, enableable, disableable,
testable, and publishable. Neither imports the other, neither shares state, and
neither duplicates the other's responsibility.

`peak-only` consumes offpeak's canonical classification through one read-only
RPC; it does not import the plugin, duplicate its calendar, or share mutable
state. If offpeak holds a peak-priced Go request, that cost protection remains
in force: free-first never bypasses it, and can only reclaim the parked request
through the same `cancelHold` capability once Free is confirmed healthy.

Two ordering facts matter, and both are verified by the live coexistence suite
(`npm run test:integration`):

- Free-first's `retry` hook must run **after** any plugin that can veto a retry,
  so list `opencode-free-first` **after** `opencode-offpeak`. The plugin logs a
  transition either way, but the failover retry needs the last word.
- A cancelled paid compaction is never re-sent: a compaction retry re-sends its
  own resolved model, so the reclaim ends that attempt and resumes the turn on
  the free model instead of dispatching the paid request it just cancelled.
- Free-first never delays, queues, or prices paid work. When the fallback route
  is peak-priced it is held by the policy plugin, the session is parked, and
  free-first reclaims it only after the free model is confirmed healthy — by
  asking that plugin to cancel the hold (`opencode-offpeak.cancelHold`), never
  by interrupting the session. Without that capability the older
  interrupt-based reclamation is used instead.

Free-model traffic through OpenCode Zen is documented by OpenCode as flat
priced, so a correctly configured policy plugin treats it as untracked or flat
and never delays it. See [`docs/coexistence.md`](docs/coexistence.md).

## How it decides

```
FREE_HEALTHY  -- genuine free-model rate limit   -->  FREE_COOLDOWN (reason: rate-limit)
FREE_HEALTHY  -- free-tier gate refusal          -->  FREE_COOLDOWN (reason: free-route)
FREE_HEALTHY  -- transient provider outage       -->  FREE_COOLDOWN (reason: transient-availability)
FREE_COOLDOWN -- cooldown reached                -->  FREE_PROBE
FREE_PROBE    -- success                         -->  FREE_HEALTHY
FREE_PROBE    -- rate limited                    -->  FREE_COOLDOWN (rate-limit ladder + 1)
FREE_PROBE    -- still unavailable               -->  FREE_COOLDOWN (transient ladder + 1)
FREE_PROBE    -- inconclusive                    -->  FREE_HEALTHY (probe deferred)
```

All three causes share one cooldown because all three mean the free route cannot
service a request right now; `cooldownReason` keeps the diagnosis honest. A
`free-route` cooldown is armed for `routeRejectRetryMs` without touching any
ladder. A `transient-availability` cooldown walks its own bounded ladder
(separate from the rate-limit ladder), so a provider 500 is never recorded as a
quota event — and a live rate-limit cooldown is never shortened or relabelled by
an outage that arrives while its deadline is longer.

`FREE_PROBE` is derived, not stored: it is what `FREE_COOLDOWN` means once its
absolute timestamp has passed and health is not yet confirmed. An inconclusive
probe leaves the free model usable (see `docs/state-machine.md`). Cooldowns are
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
- **A free-route refusal has no reset at all.** OpenCode's free-tier eligibility
  gate carries no provider reset, so the plugin uses `routeRejectRetryMs`
  (default 5 minutes) as the bounded window and then tests the free route through
  the ordinary recovery path. Managed sessions stay on the fallback until then.
- **A provider outage has no reset either.** A transient availability failure
  (5xx, a structured provider-internal or timeout, a qualifying transport
  failure) arms the transient cooldown on the first rung of the bounded ladder
  (default 1 minute) and re-arms on the next rung each time the outage recurs, so
  repeated outages back off up to `maxCooldownMs` while a single isolated one
  never blocks the route for hours. A confirmed success resets the ladder.
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
opencode api post /api/rpc/opencode-free-first/control --data '{"input":{"action":"status"}}'
```

`status` returns:

| Field | Meaning |
| --- | --- |
| `state` | `FREE_HEALTHY`, `FREE_COOLDOWN`, or `FREE_PROBE` |
| `status` | one-line summary: `FREE (…)`, `FREE cooldown: 8m`, `FREE unavailable: route rejected (retry in 5m)`, `FREE unavailable: transient provider failure (retry in 1m)`, `probing FREE` |
| `cooldownReason` | `rate-limit`, `free-route`, or `transient-availability` — why the current cooldown was armed |
| `routeRejectedAt` | when the first free-route rejection of the episode was recognised |
| `transientFailures` | consecutive transient outages (the transient ladder position) |
| `lastTransientAt` / `lastTransientType` | when the last outage was seen, and its stable classification (`failover-http-500`, `failover-structured-provider-internal`, `failover-transport-econnreset`, `probe-http-503`, …) |
| `primary` / `fallback` | the effective routes |
| `freeUsageMode` | `always-free-first`, `peak-only`, or `off` |
| `pricingState` / `pricingNextTransition` | canonical PEAK/OFF_PEAK classification and its next boundary (`peak-only`) |
| `activeRoute` | what new traffic uses now: `FREE`, `GO`, `MIXED`, or `NONE` |
| `cooldownMs` / `cooldownEndsAt` | remaining and absolute cooldown |
| `level` | position on the rate-limit backoff ladder |
| `lastRateLimitAt` / `lastRateLimitType` | when and why the last limit was seen |
| `lastResetSource` | `retry-after`, `retry-after-ms`, `x-ratelimit-reset`, `reset-timestamp`, or `backoff` |
| `nextProbeAt` | when the next probe is due |
| `probeBackoffUntil` / `inconclusiveProbes` | probe back-off and how many probes failed to decide |
| `lastProbeOutcome` | `healthy`, `limited`, `unsupported`, or `inconclusive`, with the classification. A probe that hit a provider outage re-arms the transient cooldown and shows up in `lastTransientType` (`probe-…`) instead |
| `probedAt` / `lastHealthyAt` | the last probe and the last confirmed recovery |
| `managedSessions` / `fallbackSessions` | how many sessions are managed, and how many are on the fallback |
| `manualOverrides` | sessions the user explicitly repointed |
| `transitions` | the most recent model transitions, for switch-churn checks |

Other actions: `reset` clears a cooldown an operator knows is lifted, `on` and
`off` enable and disable routing. Core runtime behaviour never depends on the
RPC.

State transitions are also logged with the `[opencode-free-first]` prefix: free
selected, rate limit detected, free route rejected, transient failure detected
(with its classification, HTTP status, and window), classification reason,
retry/reset source, cooldown start and expiry, fallback selected, probe
scheduled/started/limited, free recovered, safe switch back to free, explicit
manual override detected, stale fallback continuation neutralized, duplicate
continuation prevented. Logs never contain prompts, response bodies, headers, or
credentials.

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
opencode api post /api/rpc/opencode-free-first/control --data '{"input":{"action":"off"}}'
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
| OpenCode | `>=2.0.26 <2.2.0` (verified on `2.0.27`, `2.0.30`, and `2.1.3`) |
| Node | `>=22` for the compiled entry; OpenCode runs the TypeScript source on Bun |
| `@opencode/plugin` | `2.0.26` |

`opencode-offpeak` is optional for `always-free-first`/`off` and required for
`peak-only` at runtime. Verified coexistence: `opencode-offpeak` `v0.2.0` beside
`opencode-free-first` `v0.2.0` on OpenCode `2.0.30` and `2.1.3`.

## License

MIT. See [`LICENSE`](LICENSE).
