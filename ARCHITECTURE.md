# Architecture

`opencode-free-first` owns one question — *is the configured free model usable
right now?* — and one consequence: a session whose free route is temporarily
unavailable — a genuine free-tier rate limit, OpenCode's own free-tier
eligibility gate, or a transient provider/server availability failure — keeps
working on the configured fallback and comes back when the free route recovers.

The governing rule:

> If the configured free route is temporarily unable to serve an otherwise valid
> request, continue the same turn on the configured paid fallback. If the
> request, credentials, configuration, or plugin itself is broken, surface the
> real error instead of hiding it behind fallback.

It is deliberately small. There is no provider stack, no proxy, no queue, no
scheduler for paid work, no daemon, and no second database.

Compatibility: the package declares and tests OpenCode `>=2.0.26 <2.2.0`. The
current production binary is 2.1.3. OpenCode 2.1's breaking session-schema change
(`providerState` → `native`) does not touch the hooks used here; its new internal
retry of buffered model calls only delays a refused recovery probe until the
bounded retry schedule finishes. The real-CLI coexistence suite runs on 2.1.3.

## Responsibility boundary

```
OpenCode session
      │
      ▼
opencode-free-first
      │  is the free model usable?
      ├── yes ──▶ free model
      │
      └── no  ──▶ configured fallback model
                    │
                    ▼
            normal OpenCode provider routing
                    │
                    ▼
            cost/time policy plugin (for example opencode-offpeak)
                    │  may hold, delay, or price paid work
                    ▼
                  provider
```

| Concern | Owner |
| --- | --- |
| Free-model availability, rate-limit and transient-failure classification, failover, recovery | `opencode-free-first` |
| Paid-route timing, pricing windows, queues, holds | the policy plugin |
| Provider credentials, model catalogue, HTTP transport, retries | OpenCode |

Free-first never calls a provider itself. Its only provider-facing call is the
recovery probe, and that goes through `ctx.generate.text`, which uses OpenCode's
own routing, credentials, and configured free model.

### Free usage policy

`freeUsageMode` is a routing policy layered on top of availability. It does not
own time windows. In `peak-only`, free eligibility is the conjunction of:

1. the existing free health state says the route is usable, and
2. `opencode-offpeak`'s read-only `pricing` RPC positively reports `PEAK` for the
   configured fallback model.

The RPC answer is cached until the earlier of its `nextTransition` and a
60-second freshness bound; no timer is created. The mode is re-evaluated at
prompt admission, request preparation, retry, recovery, and probe dispatch, so
the first safe boundary after a PEAK/OFF_PEAK change applies the new route.
`OFF_PEAK`, `FLAT`, `UNTRACKED`, `UNKNOWN`, a missing capability, and an RPC
failure all mean **not eligible**; only a positive PEAK answer can spend free
quota. `always-free-first` bypasses this gate; `off` disables the engine.

At OFF_PEAK an elapsed cooldown is cleared without a probe, recovery is not
entered, and executing or newly admitted sessions represented on Free are routed
to Go. At PEAK the existing failover/recovery state machine is unchanged. When a
peak-only failover selects Go during PEAK, the paid request remains subject to
`opencode-offpeak`'s hold; free-first never bypasses that cost protection.

## Components

| File | Responsibility |
| --- | --- |
| `src/classify.ts` | Failure classification (rate limit, free-route gate, transient availability) and reset-metadata extraction. Pure. |
| `src/health.ts` | The availability state machine, both backoff ladders, jitter, persistence codec. Pure. |
| `src/config.ts` | Option/file resolution and validation. Never throws; invalid input disables the plugin. |
| `src/log.ts` | Prefixed structured logging with credential redaction. |
| `src/engine.ts` | Orchestration: session tracking, pricing-aware routing, failover, recovery, park reclamation, persistence, timers. |
| `src/offpeak.ts` | Optional neighbour RPC ports: paid-hold cancellation and the canonical read-only `pricing` query. |
| `src/rpc.ts` | Diagnostic RPC definition. |
| `src/server.ts` | Binds the engine to OpenCode's hooks, events, transforms, and RPC. |

Everything with a side effect is injected into the engine (`Clock`, `StateStore`,
`SessionDriver`, `GeneratePort`, `Logger`, `random`), so the whole state machine,
failover path, recovery path, and concurrency behaviour run under deterministic
tests with no provider traffic.

## State

Two pieces of derived state, both persisted in OpenCode's plugin storage.

### Free health (`opencode-free-first/health-v1`)

```json
{
  "schemaVersion": 1,
  "scope": "opencode/deepseek-v4.1-flash-free",
  "state": "FREE_COOLDOWN",
  "cooldownUntil": 1792079000000,
  "cooldownReason": "rate-limit",
  "level": 2,
  "lastRateLimitAt": 1792078000000,
  "lastRateLimitType": "failover-http-429",
  "lastResetSource": "retry-after",
  "lastHealthyAt": 1792070000000,
  "transientFailures": 0,
  "lastTransientAt": 1792075000000,
  "lastTransientType": "failover-http-500"
}
```

```
FREE_HEALTHY  -- genuine free-model rate limit  -->  FREE_COOLDOWN (reason: rate-limit)
FREE_HEALTHY  -- OpenCode free-tier gate        -->  FREE_COOLDOWN (reason: free-route)
FREE_HEALTHY  -- transient outage               -->  FREE_COOLDOWN (reason: transient-availability)
FREE_COOLDOWN -- cooldown reached               -->  FREE_PROBE
FREE_PROBE    -- success                        -->  FREE_HEALTHY
FREE_PROBE    -- rate limited                   -->  FREE_COOLDOWN (rate-limit level + 1)
FREE_PROBE    -- still unavailable              -->  FREE_COOLDOWN (transient failures + 1)
FREE_PROBE    -- inconclusive                   -->  FREE_HEALTHY (unconfirmed)
```

All three causes share the cooldown because the consequence is identical — the
free route cannot service a request — and sharing it is what keeps recovery,
cross-instance adoption, and the cooldown-routing guard from needing a second
mechanism. They differ in every other respect, and `cooldownReason` is what keeps
that distinction visible: a rate limit carries the ladder, the reset source, and
`lastRateLimit*`; a `free-route` cooldown is armed for `routeRejectRetryMs`,
records `routeRejectedAt`, and touches none of the rate-limit bookkeeping; a
`transient-availability` cooldown walks its own bounded ladder
(`transientFailures`, `lastTransientAt`, `lastTransientType`) and touches neither
of the others. A provider 500 can therefore never be presented as a 429, and a
quota event can never be advanced by a 500.

Two invariants keep the shared record honest:

- A live cooldown is never shortened by a later signal: the later deadline wins.
- The reason names the cause that owns the current deadline. A transient outage
  that arrives while a live rate-limit or free-route cooldown still has the
  longer deadline is recorded (its ladder and timestamps move), but the cooldown
  keeps the label of the cause that governs it, so diagnostics never misstate
  why the free route is out.

`FREE_PROBE` is the derived name for `FREE_COOLDOWN` whose cooldown has elapsed
and whose health is not yet confirmed; it is not stored, so there is no state
that can be left behind by a crash between transitions.

Cooldowns are **absolute epoch milliseconds**. A scheduled timer is a
convenience: every observer re-derives the state from the timestamp, so a reload,
a missed timer, or a restart cannot lose or duplicate a cooldown.

### Session hints (`opencode-free-first/sessions-v1`)

```json
{
  "schemaVersion": 1,
  "sessions": {
    "ses_…": { "managed": true, "route": "FALLBACK", "updatedAt": 1792078000000 }
  }
}
```

A persisted session entry is a **hint, never an instruction**. After a restart
nothing is switched until live evidence arrives for that session, so a restart
cannot move a session the user repointed while OpenCode was stopped.

### Failure safety

- A corrupt or incompatible document is discarded, and only this plugin's derived
  state is affected.
- A storage read or write that throws is reported, and routing continues in
  memory.
- Every observer and background task is wrapped: a single failing OpenCode API
  call degrades one transition, never the session.
- An invalid configuration disables the plugin instead of guessing at a route.

## Hooks and events

| Extension point | Use |
| --- | --- |
| `model.transform` | Publish the mode-appropriate default selection (Free at PEAK/always, Go at peak-only OFF_PEAK), capture each model's variant ids, capture OpenCode's own default before overriding it. |
| `prompt` | Last point before a turn resolves its model: refresh pricing, converge routing, and never spend a request on a model known to be cooling down or ineligible under `peak-only`. |
| `context` | Observe request preparation (the park signal), adopt a cooldown another instance recorded — in both directions — route a Free session to Go when `peak-only` is off-peak, and route a fallback session back to Free only when pricing allows it and the cooldown has elapsed. |
| `generate` | Bound the recovery probe's output. The probe is best-effort: only a real rate limit or a positively identified transient outage may block the free model. |
| `model.request` | Confirm a request is about to be dispatched — the request is no longer held. |
| `http.response` | Prove free health from a non-error response that was dispatched while Free was eligible and no recovery probe was in flight; capture reset headers. Concurrent OpenCode 2.1 title/auxiliary requests cannot clear a real cooldown or overtake a probe. |
| `retry` | The failover decision: record the cooldown (`rate-limit`, `free-route`, or `transient-availability`), switch the model, force one cheap retry. Anything else stays visible. |
| `generate` | Bound the recovery probe's output while it is in flight. |
| `event.subscribe` | `session.execution.started|succeeded|failed|interrupted` and `session.model.selected`. |
| `rpc.register` | Diagnostics and operator controls, including the current mode, pricing state, next transition, and active route. |

Each hook registration is disposed on unload, the event subscription is aborted,
and the engine clears every timer on dispose, so a plugin reload cannot leave a
duplicate handler or a duplicate timer behind.

## Failover

The reason OpenCode's retry hook is the failover point is that OpenCode
re-resolves the model for every provider attempt:

```
SessionRunner.runStep
  while true
    context = SessionContext.select(session)   ← reads the session's stored model
    prepared = SessionModelRequest.prepare(…)  ← context hook, then model.request hook
    result = attempt(prepared)                 ← provider call, may fail
    match result
      Retry  → wait(delay); loop again          ← re-resolves the model
      Completed → …
```

So the failover is:

1. A refusal arrives in the `retry` hook and is classified. Three causes reach
   the failover: a genuine free-model rate limit (`error.status === 429`,
   `provider.rate-limit`, `provider.quota`, or explicit exhaustion wording),
   OpenCode's own free-tier eligibility gate (the exact
   "free tier can only be used from within OpenCode" sentence on a real model
   request), and a transient availability failure (provider/server 5xx — the
   observed live case was an `AI.Error.ProviderInternal` carrying HTTP 500 —
   OpenCode's structured `provider.internal` or `provider.timeout`, or a
   transport/connectivity failure OpenCode itself treats as transient).
   Everything else — a `400`, a generic `401`/`403`, an invalid key, an invalid
   model, a content filter, a context-length error, a tool failure, a plugin
   bug, or an unclassified failure without positive evidence — is left untouched
   and stays visible.
2. The cooldown is recorded with its cause: an authoritative reset or the ladder
   for a rate limit, `routeRejectRetryMs` for the gate, and the first rung of the
   bounded transient ladder for an outage (`cooldownReason:
   "transient-availability"`, its own `transientFailures` counter). The session's
   model is switched to the fallback.
3. `decision = { retry: true, delay: failoverRetryDelayMs }` makes the very next
   attempt happen immediately.
4. OpenCode re-runs the step, re-resolves the model, and continues the same turn:
   same conversation, same agent, same working directory, same tool state.

No prompt is re-sent, no completed tool call is replayed, and no new session is
created. `session.switchModel` only publishes a `session.model.selected` event —
it takes no session lock and cannot deadlock the runner.

If the switch itself fails, or no fallback can be resolved, the decision becomes
`{ retry: false }`: the real error is surfaced instead of retrying a free model
that just refused the request. The shared state is still learned, so every other
managed session routes from it.

## Recovery

Recovery is centralised in one place so a passive path can never overtake an
in-flight probe.

```
cooldown expires
      │
      ├── managed sessions waiting on the fallback and probing enabled
      │        │
      │        ├── one out-of-band probe via ctx.generate.text
      │        │       ├── success      → reclaim parked work, then return every
      │        │       │                  waiting session to the free model
      │        │       ├── rate limited → real cooldown extended, level + 1,
      │        │       │                  sessions untouched
      │        │       ├── still unavailable (transient) → transient cooldown
      │        │       │                  re-armed on the next ladder rung,
      │        │       │                  sessions untouched
      │        │       ├── unsupported  → the host refuses the probe path: log it,
      │        │       │                  back off hard, fail open
      │        │       └── inconclusive → unknown: short probe back-off, fail open
      │        │
      └── nothing waiting, probing disabled, deferred, or refused
               └── passive: the next real model call is the test
```

`limited` and `transient` are evidence about the route and (re-)arm a real
cooldown; `unsupported` and `inconclusive` are unknown and fail open. A probe
that reports a transient availability failure uses the same predicate the retry
hook uses (provider/server 5xx, structured provider-internal, qualifying
transport/timeout) and is re-armed on the next rung of the transient ladder, so
the waiting sessions stay on the fallback and repeated outages back off further
instead of oscillating between free and paid.

An inconclusive or refused probe is *unknown*, never *limited*, so it can never
keep the free model blocked. It re-arms only the **probe** (`probeBackoffUntil`)
and returns the waiting sessions to the free model. This is a hard invariant: a
probe that cannot run must not decide that the free model is unusable, and a
blocking cooldown armed by an unfinishable probe would route every new session to
the fallback indefinitely.

An elapsed cooldown is always normalised out of the record — including when no
session is waiting on the fallback (an opted-out session, a limit without a
reachable fallback) and when both probing and passive recovery are disabled.
Otherwise the elapsed record would keep reporting `FREE_PROBE` and keep waking the
scheduler for a boundary already behind it; nothing else would ever clear it.

`OpenCode`'s own free tier refuses the probe path outright
(`Generate.UnavailableError`: transient generation is not the agent loop), which is
why the passive path is the load-bearing one in that configuration.

The probe is a single serialized request. Concurrent triggers join the in-flight
probe, so a herd of sessions reaching cooldown expiry together produces exactly
one probe and reuses its result.

Passive recovery (probing disabled, or no session to recover) moves waiting
sessions back to the free model at a safe boundary and lets real traffic confirm
recovery. That is the cheapest correct path when the session is already going to
make a call.

## Compaction

OpenCode issues an automatic compaction at the **step boundary**, and that is
also where it resolves the model the compaction request will use
(`SessionRunnerLLM.runStep` → `prepareContext` → `context.select` →
`compaction.compact({ reason: "auto", context })`). Two consequences shape this
plugin's routing:

- **No hook runs before that resolution.** The `context` and `model.request`
  hooks fire while the request is being prepared, which is *after* the model was
  chosen; `prompt` fires before the turn, but a turn that is already running has
  no new admission. The `compaction` hook exists and fires per compaction
  request, but it also runs after the resolution (it can only supply the summary
  and skip the model call). So a switch made from any of them lands on the next
  attempt or step, never on the compaction that is already resolved.
- **A prepared compaction cannot change its model.** OpenCode's compaction retry
  loop is inside `SessionCompaction.deliver`; it consults the `retry` hook, but a
  retried attempt re-sends the request it prepared, model included. Only the next
  compaction attempt re-resolves.

The routing rule that follows is enforced in two places:

1. **While a cooldown is active, sessions that can reach a boundary are on their
   fallback.** Establishing or adopting a cooldown runs a routing pass over every
   managed session with an active execution (`cooldownRouting` in `status()`) and
   moves the ones still represented on the free model to their fallback. Idle
   sessions are skipped: they cannot compact, and both prompt admission and
   request preparation already route them, so a limit cycle cannot churn them.
2. **A compaction attempt is never retried on a model that just limited.** The
   retry decision uses the kind of the request that actually dispatched
   (`model.request` carries it). A primary request keeps the failover retry —
   OpenCode re-resolves it — while a compaction is answered with
   `{ retry: false }` and the session moves to the fallback, so the next
   compaction runs there instead of spending the same doomed request again.

A compaction that *discovers* a limit is different and stays visible: that
request is the discovery, so the compaction fails once, the cooldown is
recorded, the session moves to the fallback, and the retried compaction succeeds
there. The unique case where the free model is still spent is a cooldown another
location established mid-turn in this location, between this session's last hook
and its next boundary: no supported hook exists in that window, so that request
is treated as a genuine discovery too.

The same rule covers park reclamation: when a held paid compaction is reclaimed
because the free model recovered first, the released request is refused at the
transport boundary, the attempt is not retried (it would re-send the paid
request), and one invisible continuation resumes the turn so the compaction
completes on the free model.

## Park reclamation

A cost/time policy plugin can hold a request *inside* its own pre-model hook. In
that state no provider attempt exists for OpenCode to fail or retry, so the
session would otherwise sit on paid capacity until the policy window opens — even
though the free model is available again.

The plugin detects this generically, without naming or importing any other
plugin:

- The `context` hook fires at the *start* of request preparation.
- The `model.request` hook fires only once every pre-model hook has returned, so
  a request that was prepared but never dispatched is being held.
- If a session is executing, its prepared fallback request is still undispatched
  after `parkGraceMs`, and free health is confirmed, the parked work is obsolete.

Reclamation is a two-step sequence, in this order:

1. The session is switched back to the free model (the recovery decision).
2. The parking plugin is asked to cancel the held request through the versioned
   `opencode-offpeak.cancelHold` RPC capability, declared locally in
   `src/offpeak.ts`. The cancellation is authoritative: `cancelled: true` means
   the hold lost its race, `state: "committed"` means dispatch had already been
   decided and the caller leaves the paid work alone.

A cancelled request is *refused* by the parking plugin at the transport boundary
instead of being sent, so OpenCode reports a retryable transport failure and this
plugin's `retry` hook routes the retry back to the free model — inside the same
execution. That is what makes the reclamation safe for a headless
`opencode run`: no `session.interrupt`, so nothing ends the run, no continuation
input is admitted, and the final answer is returned normally.

Without that capability — no neighbour plugin, an older release, or a refused
call — reclamation falls back to the documented interrupt sequence: interrupt the
session, wait (bounded) for it to settle, switch to the free model, then admit one
invisible synthetic continuation. The TUI path is unaffected either way; the
headless limitation applies only to that fallback.

Reclamation only runs when the free model is **confirmed** healthy by a probe. It
never guesses, and it is disabled by `parkPreemption: false`.

## Failure classification

Three stable categories decide the failover; everything else stays visible.

### Rate limit (`rate-limit`)

Detection is conservative and ordered:

1. HTTP `429`.
2. Structured `provider.rate-limit`.
3. Structured `provider.quota`.
4. Tightly scoped exhaustion wording
   (`rate limit exceeded`, `too many requests`, `quota exceeded`,
   `usage limit reached`, `insufficient credits`, …).

A structured non-limit type also wins over a matching phrase, and an explicit
negation ("the request was not rate limited") is rejected before any positive
pattern is considered.

### Free-route gate (`free-route`)

OpenCode's own free-tier eligibility gate: a 4xx provider failure whose message
contains the gate's own sentence ("free tier can only be used from within
OpenCode") on a real model request. The same sentence on the out-of-band probe is
a different thing and stays `unsupported` (see Recovery). The distinction is
asserted both ways in the test suite: the gate can never be reached by a generic
`403`, and a probe refusal can never be reported as a free-route rejection.

### Transient availability (`transient-availability`)

The free route is temporarily unable to serve an otherwise valid request. A
failure is classified here only on positive, structured evidence:

| Signal | Classification |
| --- | --- |
| HTTP `500`, `502`, `503`, `504` | `http-<status>` |
| `provider.internal` (OpenCode constructs this type only for server-side or network-error paths: any HTTP status ≥ 500, `409`, or a network-error finish) | `structured-provider-internal` |
| `provider.timeout` | `structured-timeout` |
| `provider.transport` whose message carries a transient connectivity code (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `ConnectionRefused`, `ConnectionClosed`, `FailedToOpenSocket`, any `UND_ERR_*`) or a transient phrase (`fetch failed`, `failed to fetch`, `terminated`, `other side closed`, `socket hang up`, `sse read timed out`, `response headers timed out`, a timeout wording) | `transport-<match>` |

The transport predicate mirrors OpenCode's own transient-connectivity test
(2.0.30's retry walk), because the plugin observes the error message, not the
code. A transport failure is only considered when OpenCode already labelled it
`provider.transport`, so an unqualified message can never reach the failover.

The following never count as transient availability, and keep their real failure
type — switching models would hide a defect or cannot help:

| Signal | Result |
| --- | --- |
| `400` / `provider.invalid-request` | visible |
| `401` / `provider.auth`, invalid credentials | visible |
| `403` authorization failure (unless it is the gate's exact sentence) | visible |
| `provider.content-filter` | visible |
| malformed context / maximum context length | visible |
| `tool.execution` | visible |
| `provider.unsupported-operation`, `provider.no-route` | visible |
| `provider.invalid-output` | visible |
| `provider.rate-limit`, `provider.quota` | the rate-limit path |
| a plugin bug (`unknown`) | visible |
| an unclassified failure without positive evidence | visible |

A structured non-transient type wins over a 5xx-looking status, and a definite
`4xx` status vetoes an unqualified transport message, so a false positive cannot
hide an operator problem behind paid routing.

The distinction the whole classifier rests on:

> route temporarily unavailable → fallback
> request/account/config/plugin broken → surface

## Concurrency

| Situation | Behaviour |
| --- | --- |
| Simultaneous 429s across sessions | One cooldown; the backoff ladder advances once per provider window (`duplicateLimitWindowMs`). |
| Simultaneous free-tier gate refusals across sessions | One cooldown with `reason: free-route`; the first conclusive rejection establishes the episode (`routeRejectedAt`), the cooldown-routing pass moves every executing managed session to its fallback, and a duplicate refusal neither restarts the episode nor extends the window. |
| Simultaneous 5xx/transport failures across sessions | One cooldown with `reason: transient-availability`; the transient ladder advances once per incident (`duplicateLimitWindowMs`), and a duplicate neither advances it again nor extends the window, so a herd cannot turn one outage into a schedule. |
| A transient outage while a live limit cooldown is longer | The outage is recorded (ladder, timestamps) but the cooldown keeps the limit's label and deadline; neither cause overwrites the other's bookkeeping. |
| A herd reaching cooldown expiry together | One probe; its result is reused for every waiting session. |
| A probe fails while another session works on the fallback | The working session is never touched. |
| A title/auxiliary 2xx during a cooldown or probe (OpenCode 2.1) | Not a recovery proof: it is ignored, so it cannot clear the cooldown or race the probe. |
| PEAK → OFF_PEAK while a turn is active | The in-flight request is not recalled; the next step or request is routed to Go. |
| OFF_PEAK with a stale Free cooldown | It is cleared silently at the next boundary; no probe is sent and the session stays on Go. |
| OpenCode restart during a cooldown | A future cooldown is restored, an expired one is discarded, none is probed at startup. |
| A plugin reload | Registrations and timers are disposed and rebuilt; no duplicate listeners. |
| Explicit user model change during a cooldown | Respected; the session is no longer managed. |
| A parked fallback while the free model recovers | Reclaimed once, never duplicated. |

## Model transitions

Every switch is recorded as `<timestamp> <trigger> -> provider/model`, where the
trigger is one of `failover` (rate limit), `route-reject-failover` (free-route
gate), `availability-failover` (transient outage), `prompt-admission`,
`context-guard`, `off-peak-guard`, `passive-recovery`, `probe-recovery`,
`park-preemption`, or `cooldown-guard`. The last 40 are
exposed through `status().transitions`, which is what the switch-churn tests
assert against: a complete free-limit cycle is exactly two transitions.

## What is deliberately absent

No Redis, no external database, no daemon, no external queue, no watchdog, no
provider proxy, no patched OpenCode, no second off-peak scheduler, no duplicate
paid routing, and no second credential store.
