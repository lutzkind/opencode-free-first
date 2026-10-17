# State machine and backoff

## States

```
FREE_HEALTHY
    │  genuine free-model rate limit          cooldownReason: "rate-limit"
    │  OpenCode free-tier eligibility gate    cooldownReason: "free-route"
    ▼
FREE_COOLDOWN  ── cooldownUntil is an absolute epoch-millisecond timestamp
    │  cooldownUntil <= now
    ▼
FREE_PROBE
    ├─ success       ──▶ FREE_HEALTHY                       (recovery confirmed)
    ├─ rate limited  ──▶ FREE_COOLDOWN  (level + 1)          (a real limit)
    └─ inconclusive  ──▶ FREE_HEALTHY   (unconfirmed)        (unknown, never limited)

Both causes arm the *same* cooldown because both mean the same thing: the free
route cannot service a request right now. The reason keeps them apart. A
`free-route` cooldown is armed for `routeRejectRetryMs` (no provider reset
exists), does not touch the ladder or the rate-limit bookkeeping, and is
reported as a route rejection rather than as a rate limit.

An inconclusive result re-arms the *probe* on a bounded back-off
(`probeBackoffUntil`) and returns the waiting sessions to the free model, so the
next real model call becomes the test. It must never keep the free model blocked:
a probe that cannot run is not evidence that the free model is unusable, and
treating it as a limit is what let one un-runnable probe route every new session
to the fallback indefinitely.
```

Only `FREE_HEALTHY` and `FREE_COOLDOWN` are persisted. `FREE_PROBE` is derived:
it is the name for `FREE_COOLDOWN` whose timestamp has passed and whose health is
not yet confirmed. Deriving it removes any state that a crash could leave behind
mid-transition.

## Where the states are enforced

| Observation point | Behaviour |
| --- | --- |
| Prompt admission, free model selected, cooling down | Switch the session to the fallback *before* the turn resolves its model. No request is spent on a model known to be limited. |
| Request preparation (`context`), free model, cooling down | Safety net for a mid-turn step: switch the session so the next attempt uses the fallback. |
| Request preparation, fallback model, cooldown elapsed | Delegate to the single recovery path. |
| Retry hook, free model, genuine limit | Record the cooldown (`rate-limit`), switch to the fallback, force one cheap retry. |
| Retry hook, free model, exact free-tier gate | Record the cooldown (`free-route`), switch the same session to the fallback, force one cheap retry. A generic 401/403 or any other auth/config failure is left alone. |
| Prompt admission or prepare, free model, `free-route` cooldown | Same routing as a rate-limit cooldown: no request is spent on a temporarily refused route. |
| Response observed, free model, non-error status | Confirmed recovery: clear the cooldown and reset the ladder. |
| Recovery tick | Probe, then reclaim parked work, then return waiting sessions to the free model. A probe that cannot decide counts as a fail-open outcome, not as a block. |

## Probe outcomes

Every probe attempt classifies its result three ways:

| Outcome | Meaning | Effect |
| --- | --- | --- |
| `limited` | A real rate limit (`429`, structured `provider.rate-limit`/`provider.quota`, or exhaustion wording) | Arm (or extend) a real, blocking cooldown |
| `unsupported` | The host refuses the probe path itself — OpenCode's free tier answers `Generate.UnavailableError` because transient generation is not the agent loop — or the model route is structurally refused (`invalid-request`, `no-route`, `auth`, `unsupported-operation`) | Fail open, log at `error`, and stop probing for `probeUnsupportedBackoffMs` (default 6h) |
| `inconclusive` | Anything else: a transport error, a 5xx, anything unexplained | Fail open, escalate the probe back-off along the normal ladder (capped by `maxCooldownMs`), and let real traffic decide |

None of the last two ever sets `cooldownUntil`, so none of them can keep the free
model out of use. A later genuine limit still establishes a new blocking cooldown,
and it keeps the probe verdict: a new limit says nothing new about whether the
probe path works.

## Elapsed cooldowns

A cooldown whose timestamp has passed is removed from the record on every fail-open
outcome — including the passive recovery branch (probing disabled), which
otherwise kept reporting `FREE_PROBE` and re-armed a due wake-up in a tight loop.
An elapsed cooldown is normalised away while the ladder position, the probe
bookkeeping, and the last rejection time survive.

## Reset metadata

When a genuine limit is classified, reset metadata is read in this order:

1. `Retry-After` (seconds or an HTTP date).
2. `Retry-After-Ms` (milliseconds, or a Go-style duration such as `1m30s`).
3. `x-ratelimit-reset`, `x-ratelimit-reset-requests`, `x-ratelimit-reset-after`.
4. A structured reset field in the JSON error payload (`retry_after`,
   `retry_after_ms`, `reset`, `reset_at`, `resets_at`, `reset_in`, including
   inside `error`).
5. A trustworthy reset phrase in the message
   (`try again in 20 seconds`, `resets at 2026-10-15T16:00:00Z`).

Epoch seconds, epoch milliseconds, delays, durations, and absolute instants are
all understood. A value that is already in the past, non-finite, or more than a
day in the future is rejected and the ladder is used instead.

An authoritative reset is applied as-is: it is not capped by `maxCooldownMs`,
because the provider's own claim is better information than the local guess. A
minimum cooldown of one second applies so a provider that reports zero does not
produce a probe storm.

## Backoff ladder

Used only when no reset metadata exists:

| Level | Delay (default) |
| --- | --- |
| 1 | 1 minute |
| 2 | 2 minutes |
| 3 | 5 minutes |
| 4 | 10 minutes |
| 5 | 15 minutes |
| 6+ | 15 minutes (last entry repeats) |

- The **level advances on each genuine limit** and resets to zero on confirmed
  recovery. A `free-route` cooldown never advances it: it is not a rate limit.
- `maxCooldownMs` caps a ladder-derived cooldown.
- `jitterRatio` adds symmetric jitter, clamped so jitter can neither shorten a
  cooldown below the minimum nor extend it past the cap. Symmetric jitter keeps
  the expected delay on the ladder value while spreading probes across sessions.
- Repeated duplicate signals for one provider window do not advance the level
  (`duplicateLimitWindowMs`), but a later authoritative reset still extends the
  cooldown.

## Concurrency

- At most one probe is in flight for the whole instance. A second trigger awaits
  the same probe and reuses its result.
- A failed probe re-arms the cooldown, so no other session can immediately probe
  again.
- Parked reclamation runs once per park observation; the park mark is consumed
  before the interruption so a repeated tick cannot reclaim the same request
  twice.
- **Across instances.** OpenCode loads one plugin instance per location, and every
  instance shares this plugin's storage. Before prompt admission, before a
  fallback-model prepare, before applying routing, before recording a limit, and
  before issuing a probe, an instance re-reads the persisted record and adopts
  whatever is more conservative — the longer cooldown, the higher ladder position,
  or a recovery confirmed elsewhere. A limit discovered in one location is
  therefore shared rather than rediscovered per location, and a stale local
  cooldown cannot outlive a recovery that another instance already confirmed.
  `status` re-reads shared health before reporting, so diagnostics never show a
  healthy free model while a shared cooldown is active. The shared record is
  monotonic with respect to an active cooldown — a write never downgrades it — and
  a freshly started instance does not claim a recovery, so a start-up can never
  overwrite a live cooldown. The probe back-off and attempt count are shared the
  same way, so a probe verdict reached in one location is not re-earned by every
  other one.

## Persistence

`opencode-free-first/health-v1` stores the health record; its `scope` field is
`providerID/modelID` of the primary model, and a record for another scope is
discarded. `opencode-free-first/sessions-v1` stores session hints.

On start-up:

| Persisted state | Result |
| --- | --- |
| Cooldown in the future | Restored, timer armed, logged with the remaining time. |
| Cooldown already elapsed | Discarded; the ladder position is kept so a repeat limit still backs off further. No probe at start-up. |
| Missing | A fresh healthy record. |
| Wrong schema version | Discarded, and the reason is logged. |
| Corrupt or non-object | Discarded, and the reason is logged. |
| Storage unavailable | Reported; routing continues in memory. |

Session hints are never acted on until live evidence arrives for that session, so
a restart cannot move a session the user repointed while OpenCode was stopped.

## Status mapping

| Derived state | `status()` value | Status line |
| --- | --- | --- |
| Healthy | `FREE_HEALTHY` | `FREE (provider/model)` |
| Rate-limited | `FREE_COOLDOWN` (`cooldownReason: "rate-limit"`) | `FREE cooldown: 8m` |
| Free route temporarily unavailable | `FREE_COOLDOWN` (`cooldownReason: "free-route"`, `routeRejectedAt` set) | `FREE unavailable: route rejected (retry in 8m)` |
| Cooldown elapsed, unconfirmed | `FREE_PROBE` | `probing FREE` |
| Disabled | — | `disabled` |
