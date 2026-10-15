# State machine and backoff

## States

```
FREE_HEALTHY
    │  genuine free-model rate limit
    ▼
FREE_COOLDOWN  ── cooldownUntil is an absolute epoch-millisecond timestamp
    │  cooldownUntil <= now
    ▼
FREE_PROBE
    ├─ success       ──▶ FREE_HEALTHY
    ├─ rate limited  ──▶ FREE_COOLDOWN  (level + 1)
    └─ inconclusive  ──▶ FREE_COOLDOWN  (level kept, short retry)
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
| Retry hook, free model, genuine limit | Record the cooldown, switch to the fallback, force one cheap retry. |
| Response observed, free model, non-error status | Confirmed recovery: clear the cooldown and reset the ladder. |
| Recovery tick | Probe, then reclaim parked work, then return waiting sessions to the free model. |

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
  recovery.
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
  instance shares this plugin's storage. Before recording a limit or issuing a
  probe, an instance adopts the persisted record when it is more conservative
  (longer cooldown, higher ladder position), so a limit discovered in one location
  is shared rather than rediscovered per location.

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
| Cooling down | `FREE_COOLDOWN` | `FREE cooldown: 8m` |
| Cooldown elapsed, unconfirmed | `FREE_PROBE` | `probing FREE` |
| Disabled | — | `disabled` |
