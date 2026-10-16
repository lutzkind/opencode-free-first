# Architecture

`opencode-free-first` owns one question — *is the configured free model usable
right now?* — and one consequence: a session that hits a genuine free-tier rate
limit keeps working on the configured fallback and comes back when the free model
recovers.

It is deliberately small. There is no provider stack, no proxy, no queue, no
scheduler for paid work, no daemon, and no second database.

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
| Free-model availability, rate-limit classification, failover, recovery | `opencode-free-first` |
| Paid-route timing, pricing windows, queues, holds | the policy plugin |
| Provider credentials, model catalogue, HTTP transport, retries | OpenCode |

Free-first never calls a provider itself. Its only provider-facing call is the
recovery probe, and that goes through `ctx.generate.text`, which uses OpenCode's
own routing, credentials, and configured free model.

## Components

| File | Responsibility |
| --- | --- |
| `src/classify.ts` | Rate-limit classification and reset-metadata extraction. Pure. |
| `src/health.ts` | The availability state machine, backoff ladder, jitter, persistence codec. Pure. |
| `src/config.ts` | Option/file resolution and validation. Never throws; invalid input disables the plugin. |
| `src/log.ts` | Prefixed structured logging with credential redaction. |
| `src/engine.ts` | Orchestration: session tracking, routing, failover, recovery, park reclamation, persistence, timers. |
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
  "level": 2,
  "lastRateLimitAt": 1792078000000,
  "lastRateLimitType": "failover-http-429",
  "lastResetSource": "retry-after",
  "lastHealthyAt": 1792070000000
}
```

```
FREE_HEALTHY  -- genuine free-model rate limit -->  FREE_COOLDOWN
FREE_COOLDOWN -- cooldown reached               -->  FREE_PROBE
FREE_PROBE    -- success                       -->  FREE_HEALTHY
FREE_PROBE    -- rate limited                  -->  FREE_COOLDOWN (level + 1)
FREE_PROBE    -- inconclusive                  -->  FREE_COOLDOWN (level kept, short retry)
```

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
| `model.transform` | Publish the free model as the default selection, capture each model's variant ids, capture OpenCode's own default before overriding it. |
| `prompt` | Last point before a turn resolves its model: converge routing without spending a request on a model known to be cooling down. |
| `context` | Observe request preparation (the park signal), and route a fallback session back to the free model when the cooldown has elapsed. |
| `generate` | Bound the recovery probe's output. The probe is best-effort: only a real rate limit may block the free model. |
| `model.request` | Confirm a request is about to be dispatched — the request is no longer held. |
| `http.response` | Prove free health from a non-error response; capture reset headers. |
| `retry` | The failover decision: record the cooldown, switch the model, force one cheap retry. |
| `generate` | Bound the recovery probe's output while it is in flight. |
| `event.subscribe` | `session.execution.started|succeeded|failed|interrupted` and `session.model.selected`. |
| `rpc.register` | Diagnostics and operator controls. |

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

1. A genuine free-model rate limit arrives in the `retry` hook
   (`error.status === 429`, `provider.rate-limit`, `provider.quota`, or explicit
   exhaustion wording).
2. The cooldown is recorded (authoritative reset if the provider gave one, else
   the ladder with jitter), and the session's model is switched to the fallback.
3. `decision = { retry: true, delay: failoverRetryDelayMs }` makes the very next
   attempt happen immediately.
4. OpenCode re-runs the step, re-resolves the model, and continues the same turn:
   same conversation, same agent, same working directory, same tool state.

No prompt is re-sent, no completed tool call is replayed, and no new session is
created. `session.switchModel` only publishes a `session.model.selected` event —
it takes no session lock and cannot deadlock the runner.

If the switch itself fails, or no fallback can be resolved, the decision becomes
`{ retry: false }`: the real error is surfaced instead of retrying a free model
that just refused the request.

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
      │        │       ├── unsupported  → the host refuses the probe path: log it,
      │        │       │                  back off hard, fail open
      │        │       └── inconclusive → unknown: short probe back-off, fail open
      │        │
      └── nothing waiting, probing disabled, deferred, or refused
               └── passive: the next real model call is the test
```

An inconclusive or refused probe is *unknown*, never *limited*, so it can never
keep the free model blocked. It re-arms only the **probe** (`probeBackoffUntil`)
and returns the waiting sessions to the free model. This is a hard invariant: a
probe that cannot run must not decide that the free model is unusable, and a
blocking cooldown armed by an unfinishable probe would route every new session to
the fallback indefinitely.

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

Reclamation is a three-step sequence, in this order:

1. `session.interrupt({ sessionID })` cancels the parked attempt. The parking
   plugin observes `session.execution.interrupted` and drops its own pending
   continuation, so the obsolete paid work can never run twice.
2. Wait (bounded) for the cancellation to settle.
3. Switch the session to the free model, then admit one invisible continuation
   input with `session.synthetic({ delivery: "steer", resume: true })`. The same
   session, conversation, agent, and working directory continue; the synthetic
   input is not rendered in the terminal and carries no business side effect.

Reclamation only runs when the free model is **confirmed** healthy by a probe. It
never guesses, and it is disabled by `parkPreemption: false`.

## Rate-limit classification

Detection is conservative and ordered:

1. HTTP `429`.
2. Structured `provider.rate-limit`.
3. Structured `provider.quota`.
4. Tightly scoped exhaustion wording
   (`rate limit exceeded`, `too many requests`, `quota exceeded`,
   `usage limit reached`, `insufficient credits`, …).

The following never count, and keep their real failure type:

| Signal | Result |
| --- | --- |
| `400` / `provider.invalid-request` | not a limit |
| `401` / `provider.auth` | not a limit |
| `403` authorization failure | not a limit |
| `provider.content-filter` | not a limit |
| malformed context / maximum context length | not a limit |
| `tool.execution` | not a limit |
| `provider.transport`, `provider.timeout` | not a limit |
| `provider.internal` (5xx) | not a limit |
| `provider.no-route`, `provider.unknown` | not a limit |
| a plugin bug (`unknown`) | not a limit |

A structured non-limit type also wins over a matching phrase, and an explicit
negation ("the request was not rate limited") is rejected before any positive
pattern is considered.

## Concurrency

| Situation | Behaviour |
| --- | --- |
| Simultaneous 429s across sessions | One cooldown; the backoff ladder advances once per provider window (`duplicateLimitWindowMs`). |
| A herd reaching cooldown expiry together | One probe; its result is reused for every waiting session. |
| A probe fails while another session works on the fallback | The working session is never touched. |
| OpenCode restart during a cooldown | A future cooldown is restored, an expired one is discarded, none is probed at startup. |
| A plugin reload | Registrations and timers are disposed and rebuilt; no duplicate listeners. |
| Explicit user model change during a cooldown | Respected; the session is no longer managed. |
| A parked fallback while the free model recovers | Reclaimed once, never duplicated. |

## Model transitions

Every switch is recorded as `<timestamp> <trigger> -> provider/model`, where the
trigger is one of `failover`, `prompt-admission`, `context-guard`,
`passive-recovery`, `probe-recovery`, or `park-preemption`. The last 40 are
exposed through `status().transitions`, which is what the switch-churn tests
assert against: a complete free-limit cycle is exactly two transitions.

## What is deliberately absent

No Redis, no external database, no daemon, no external queue, no watchdog, no
provider proxy, no patched OpenCode, no second off-peak scheduler, no duplicate
paid routing, and no second credential store.
