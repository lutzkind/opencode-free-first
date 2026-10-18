# Troubleshooting

Start with the plugin's own view of the world:

```sh
opencode api post /api/rpc/opencode-free-first/control --data '{"input":{"action":"status"}}'
```

Every decision is also logged with the `[opencode-free-first]` prefix. Set
`"logLevel": "debug"` for per-request detail.

## Nothing happens at all

1. Confirm the plugin is installed and loaded:
   ```sh
   opencode plugin list
   ```
   The installed entry should show `opencode-free-first` with the tag or path you
   installed.
2. Confirm the plugin logged its start-up line. With `--print-logs` you should see
   `[opencode-free-first] loading { … }` followed by `[opencode-free-first] ready`.
3. If you see
   `free-first configuration invalid; plugin disabled` at `error` level, the
   message names the offending field. Fix it and reload.
4. Confirm the primary model id exists:
   ```sh
   opencode models | grep deepseek-v4.1-flash-free
   ```
   If it is missing, the id or provider is wrong for your OpenCode version and the
   plugin logs
   `primary model is not available; leaving the default selection unchanged`.

## Sessions do not start on the free model

- `preferAsDefault` must be `true` (the default). With it off, the plugin never
  changes OpenCode's default selection; it only manages sessions that are already
  on the free model.
- The terminal's model selector can remember a previous choice. Select the free
  model once, or set `model` in `opencode.json`.
- Sessions that were already on the paid route stay there unless
  `adoptFallbackSessions` is `true`. That is deliberate: free-first does not move
  a session you left on a paid route by default.

## "OpenCode's free tier can only be used from within OpenCode"

This gate is OpenCode's own free-tier eligibility check refusing a real model
request, and legitimate OpenCode users receive it too. It is not a rate limit and
not a credential problem. The plugin classifies the exact message as a free-route
rejection, arms the shared cooldown with `cooldownReason: "free-route"`, moves the
affected session to the fallback for the same turn, and returns it to the free
model once the route works again. You should see:

```
[opencode-free-first] free route rejected { classification: "free-tier-provenance-gate", type: "provider.auth", status: 403, retryIn: "5m" }
[opencode-free-first] model transition { trigger: "route-reject-failover", model: "<fallback>" }
[opencode-free-first] fallback selected { … trigger: "route-reject-failover", retryDelayMs: 250 }
```

and later, when the window expires, either
`recovery probe succeeded` / `returned to free model`, or the passive path
(`the recovery probe is not permitted for this model; using passive recovery` is
the normal probe refusal described below, not a new failure).

`status` shows the cause while the window is active:

- `state: "FREE_COOLDOWN"`, `cooldownReason: "free-route"`, `routeRejectedAt`
  (when the first rejection of the episode was seen) and `cooldownMs` (the
  remaining retry window).
- No `lastRateLimitAt` / `lastRateLimitType` / `lastResetSource`: the plugin never
  reports this as a rate limit.
- The status line reads `FREE unavailable: route rejected (retry in 5m)`.

If it keeps happening for hours, that is an upstream outage of the free route; the
plugin keeps managed work on the fallback and retries conservatively
(`routeRejectRetryMs`, default 5 minutes). Lower it if you would rather test the
free route more often, raise it if you would rather spend fewer requests on a
route that is known to be refusing.

A *generic* 401 or 403 (an invalid API key, a forbidden account, a malformed
request) is deliberately **not** this. Those stay visible, the plugin does not
fail over, and the underlying error is surfaced unchanged.

Note that a session's automatic *title* request is not covered by the retry hook:
OpenCode generates titles on its own path and swallows failures there, so a gate
that happens to hit only the title request leaves the title missing and the turn
runs normally. The failover covers the agent loop and compaction requests, which
are the requests that carry the turn.

## A provider 500 (or 502/503/504, or a transport failure) killed the turn

The free route was temporarily unable to serve an otherwise valid request — a
provider/server failure, a structured `provider.internal`, a structured provider
timeout, or a transport failure OpenCode treats as transient (`ECONNRESET`,
`fetch failed`, a timeout wording, …). Since v0.1.10 the plugin fails the same
turn over to the fallback, exactly like a rate limit, and returns the session to
the free model once the bounded transient window expires. You should see:

```
[opencode-free-first] free route transient failure detected { classification: "http-500", category: "server", type: "provider.internal", status: 500, cooldown: "1m", transientFailures: 1 }
[opencode-free-first] model transition { trigger: "availability-failover", model: "<fallback>" }
[opencode-free-first] fallback selected { … trigger: "availability-failover", retryDelayMs: 250 }
```

and later, when the window expires, either `recovery probe succeeded` /
`returned to free model`, or — if the provider is still down —
`recovery probe hit a transient availability failure`, which re-arms the transient
cooldown on the next ladder rung and keeps the fallback session untouched.

`status` shows the cause while the window is active:

- `state: "FREE_COOLDOWN"`, `cooldownReason: "transient-availability"`,
  `transientFailures` (the ladder position), `lastTransientAt` /
  `lastTransientType` (the stable classification, e.g. `failover-http-500`).
- No `lastRateLimitAt` / `lastRateLimitType` / `lastResetSource`: a 500 is never
  reported as a quota event.
- The status line reads `FREE unavailable: transient provider failure (retry in 1m)`.

One isolated outage blocks the route for the first rung of the bounded ladder
(default 1 minute); repeated outages back off further, capped by `maxCooldownMs`.
A confirmed success resets the counter. An outage that arrives while a
rate-limit window is still the longer one is recorded without relabelling it:
`cooldownReason` always names the cause that owns the current deadline, and the
two causes never share a ladder.

Request, account, and configuration defects are still **not** this: a `400`, a
`401`, a generic `403`, an invalid key, an invalid model, a content filter, a
context-length error, a tool failure, or a plugin bug keeps its real type, does
not fail over, and surfaces unchanged.

## A rate limit is hit but the session does not fail over

Check the debug log for one of these:

- `provider failure is not a free-model availability failure` — classification
  declined. The detail shows the `type`, `status`, `classification`, and
  `availability` reasons. If a provider returns something unexpected that is
  genuinely a limit or a transient outage, add it as a fixture-backed test rather
  than loosening the parser ad hoc.
- `session is not managed by free-first; leaving its model unchanged` — the
  session was repointed by hand, so management ended.
- `no fallback model available; surfacing the free-model failure` — no
  `fallback` option, no remembered previous model, and no OpenCode default could
  be resolved. Set `fallback` explicitly.
- `failed to switch session to the fallback model` — the switch call itself
  failed; the underlying error is logged alongside.

If the *transition* line appears but the retry still lands on the free model,
another plugin's `retry` hook ran after free-first's and vetoed it. List
`opencode-free-first` after any plugin that can veto retries.

## Every new session goes to the fallback, even after the reset has passed

Symptom: after a free-tier limit, `status` shows a short `FREE cooldown` that
never really ends, and each new session is routed to the fallback at
`prompt-admission` — hours after the provider's own reset time.

Check `lastProbeOutcome` and `probeBackoffUntil` in `status`:

- `unsupported:…` with a long `probeBackoffUntil` means the host refuses the probe
  path. OpenCode's own free tier does this: transient generation is not the agent
  loop, so it answers `Generate.UnavailableError` ("OpenCode's free tier can only be
  used from within OpenCode"). The plugin logs
  `the recovery probe is not permitted for this model; using passive recovery` at
  `error` level and stops probing. This is expected and harmless: recovery happens
  passively, and the free model is used again at the next real model call after the
  cooldown expires.
- `inconclusive:…` repeated with a growing delay means probes are failing for a
  reason that is neither exhaustion nor a recognised transient outage — an
  unclassified failure. The free model stays usable regardless.
- `transientFailures` / `lastTransientType` with a growing `cooldownMs` means the
  provider route is genuinely down right now (`probe-http-503`,
  `probe-structured-provider-internal`, …). That is not a probe defect: the
  waiting sessions correctly stay on the fallback, and the window backs off on the
  bounded ladder until a probe succeeds.

If new sessions are *still* going to the fallback, the cooldown is still believed
to be active. Confirm with `status`: `cooldownMs > 0` means a real cooldown is
running, and `lastRateLimitAt` / `lastTransientAt` tell you when it was
established, and by which cause (`cooldownReason`). A `lastRateLimitAt` from
before the provider's reset means you are looking at a stale cooldown — lift it
with the `reset` action below, and report it: only a genuine limit or a positive
outage should ever arm a cooldown.

A cooldown whose timestamp has passed is dropped automatically, and a stale
instance cannot resurrect one: `status` re-reads shared health before reporting, and
every routing decision adopts the shared record first.

## The session never leaves the fallback

Recovery has not been confirmed yet. Look at:

- `state` and `cooldownMs` from `status` — the cooldown may still be running.
- `cooldown started` in the log and its `resetSource`:
  - `retry-after` / `retry-after-ms` / `x-ratelimit-reset` /
    `reset-timestamp` — the provider told us when the free model returns, and the
    plugin waits for it. If the provider's claim is very generous, that is the
    provider's own number.
  - `backoff` — no reset metadata was supplied, so the ladder applies.
- `recovery probe rate-limited` — the free model is still limited; the cooldown
  was extended and the rate-limit ladder advanced.
- `recovery probe hit a transient availability failure` — the provider route is
  still down (not a limit); the transient cooldown was re-armed on the next ladder
  rung and the waiting sessions were left untouched.
- `recovery probe inconclusive` — the probe failed for a reason that is neither
  exhaustion nor a recognised outage (an unclassified failure). Free health is
  unchanged and a short retry was armed.
- With `"probe": false`, recovery is passive. A session that is idle will stay on
  the fallback until it makes another model call.

## The task seems to restart after recovery

After a parked paid request is reclaimed, the log shows `parked fallback request
detected`, `stale fallback continuation neutralized` with `via: "cancel-hold"`,
and `same task resumed on the free model after its fallback attempt was refused`.
Nothing was restarted: the held request was cancelled before it was ever sent,
the same execution retried on the free model, and the session records exactly one
user message with no extra input.

The parking plugin refuses the cancelled attempt at the transport boundary, so a
single retryable `provider.transport` failure is expected there and is what lets
OpenCode continue on the free model. `status().holdCancels` counts those
cancellations, and `status().holdCancelCapability` reports whether the neighbour
supports the call at all.

Without that capability — an older parking plugin, or none — reclamation uses the
interrupt-based sequence instead: the log then shows `duplicate continuation
prevented` and the session records one additional `synthetic` message (not
rendered, not a duplicated prompt). A headless `opencode run` exits as soon as
that interrupt settles, before the resumed step completes; the session, model,
and continuation are already correct, so open the session (or use `--continue`)
to see it finish. The TUI does not have this limitation.

## Compaction spent a free request while FREE was already cooling down

The cooldown now keeps sessions that can reach a step boundary on the fallback,
so this should not happen. If it does, look for the one window that has no
supported hook: a cooldown established by another location *while* this session's
turn is running, between its last hook and its next step boundary (OpenCode
resolves the compaction's model at that boundary, before any plugin hook). That
request is treated as the discovery of the limit, so it fails once, records the
cooldown, moves the session to the fallback, and the next compaction succeeds
there. `status().compactionRetriesSuppressed` counts the compaction attempts
that were *not* retried on a limited free model, and `status().cooldownRouting`
(`runs`, `routed`) shows the routing pass that keeps a known cooldown represented
in the sessions.

## Switch churn

Use `status().transitions`. A healthy free period records **zero** transitions. A
complete free-availability cycle records exactly two: one failover trigger
(`failover`, `route-reject-failover`, or `availability-failover`) and one of
`probe-recovery` / `passive-recovery` / `park-preemption`. Anything more means a
repeated signal is being recognised faster than the cooldown, which the debug log
shows as `duplicate: true` on the second `free rate limit detected`, `free route
rejected`, or `free route transient failure detected`. Check `cooldownReason` and
the matching bookkeeping fields (`level` for limits, `transientFailures` for
outages) to see which cause is currently in charge.

## Two plugin instances, or a stale version

```sh
opencode plugin list
opencode api get /api/plugin | grep -i free-first
```

There must be exactly one active instance. A local development path and a
published package installed at the same time both load. Remove the one you do not
want:

```sh
opencode plugin remove opencode-free-first
```

OpenCode caches installed packages under `~/.cache/opencode/npm/`. If the log
still shows an outdated entrypoint after a supported update, remove the specific
cached package directory for this plugin and reload. Never clear the whole cache:
it holds credentials-adjacent state for other plugins and the session store does
not live there.

## Resetting state

- Lift a cooldown you know is gone:
  ```sh
  opencode api post /api/rpc/opencode-free-first/control --data '{"input":{"action":"reset"}}'
  ```
- Pause routing entirely:
  ```sh
  opencode api post /api/rpc/opencode-free-first/control --data '{"input":{"action":"off"}}'
  ```
  Persisted cooldown state is preserved, and `on` resumes.
- Permanently forget derived state by removing the
  `plugin:<id>:opencode-free-first/*` rows from OpenCode's plugin storage. This
  never touches sessions, prompts, credentials, or configuration.

## Reporting a problem

Include `opencode --version`, the offending option block, the `status` output,
and a `logLevel: "debug"` excerpt. Redact API keys, authorization headers,
prompts, and file contents.
