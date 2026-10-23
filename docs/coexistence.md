# Coexistence with a paid cost/time policy plugin

`opencode-free-first` owns free-model availability. A cost/time policy plugin
such as [`opencode-offpeak`](https://github.com/lutzkind/opencode-offpeak) owns
paid-route timing. The two are independent: neither imports the other, neither
shares state, and neither duplicates the other's responsibility.

## Recommended layout

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "git+https://github.com/lutzkind/opencode-offpeak.git#v0.2.0",
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

Order matters in exactly one way: a plugin that can veto a retry must be listed
**before** `opencode-free-first`, so free-first's retry hook — the failover — has
the last word. OpenCode runs same-name hooks in plugin order.

## Two separate controls

The names are similar, so the boundary is explicit:

| Control | Owner | Meaning |
| --- | --- | --- |
| `/offpeak off` | `opencode-offpeak` | Pause offpeak's automation/protection. Free-first keeps routing normally. |
| `/free-first mode disabled` | `opencode-free-first` | Stop free-first management. Offpeak keeps its own settings and paid-price protection. |
| `/free-first mode peak-only` | `opencode-free-first` | Consume offpeak's read-only `pricing` answer; only a positive `PEAK` allows Free. |
| `/free-first mode free-first` | `opencode-free-first` | Use Free whenever healthy, regardless of pricing. |

`/offpeak off` never disables Free-first, and Free-first disabled never changes
offpeak's configuration, queue, holds, session overrides, or pricing windows.
The real-TUI test asserts both directions.

## Verified cases

The integration suite in `test/integration.test.mjs` runs the real OpenCode CLI
with the real `opencode-offpeak` against a deterministic mock provider and
asserts each of these.

### 1 — Free model healthy

Only the free model is requested. The policy plugin sees free-model traffic as
untracked or flat, so it never delays it. No model transition is recorded.

### 2 — Free model rate limited

The free-model `429` is classified, the cooldown is recorded, and the session's
model switches to the fallback. OpenCode retries, re-resolves the model, and
continues the same turn. The paid request carries the same conversation as the
failed free request — one prompt, no replay. The paid route flows through normal
OpenCode routing, so the policy plugin sees it exactly as it would see any other
paid request.

The same sequence covers a temporarily unavailable free route — OpenCode's
free-tier eligibility gate or a transient provider outage (5xx, transport). The
cause is recorded separately (`cooldownReason`) and the recovery window differs,
but there is one failover mechanism, so the policy plugin still sees only an
ordinary paid request.

### 3 — Free model recovers while the paid route is parked

The fallback route is peak-priced, so the policy plugin holds the paid request
inside its own pre-model hook. The free cooldown expires first. Free-first probes
out of band, confirms recovery, and reclaims the parked task:

```
fallback request prepared → held by the policy plugin
free cooldown expires     → free healthy (probe or passive recovery)
switch to free            → the session is back on the free model
cancelHold                → the policy plugin refuses the held request at the
                            transport boundary; it is never sent
retry on free             → the same execution continues, and the task finishes
                            on the free model — no interruption, no extra input
```

Asserted in the suite: zero paid requests dispatched, exactly one user message,
no continuation input, exactly two model transitions, one session, and a
successful turn whose final answer comes from the free model — printed by a plain
headless `opencode run` as well as by a live server. When the policy plugin has
no cancellation capability, free-first falls back to the interrupt-based
sequence, whose headless limitation is documented in `docs/troubleshooting.md`.

### 3b — A compaction starts while FREE is already cooling down

OpenCode resolves an automatic compaction's model at the step boundary, before
any plugin hook runs, and a prepared compaction re-sends that model when it is
retried. Free-first therefore keeps the sessions that can reach that boundary —
the ones with an active execution — on the fallback as soon as the cooldown is
known, and answers a compaction which discovers a limit with "do not retry" so it
moves to the fallback instead of spending the same doomed request again.

```
known cooldown            → the session is already on the fallback
automatic compaction      → resolved on the fallback, zero free requests
genuine limit discovered  → one failed compaction, cooldown recorded, session
                            moves to the fallback, the retry compacts there
```

### 4 — Free model still limited

The probe is rate limited, the cooldown is extended, and the fallback keeps
owning the work. Free-first does not bypass the policy plugin.

### 5 — Free model recovers during an active fallback response

The session is switched at the next safe boundary. A streaming response and an
active tool call are never interrupted, because `switchModel` only affects model
resolution for subsequent attempts.

### 6 — Recovery probe fails

The fallback session is untouched, the cooldown extends, and no main-session
model churn is recorded.

## What free-first deliberately does not do

- It does not implement off-peak windows, holiday calendars, price multipliers,
  queues, or holds.
- It does not add a second scheduler, timer, or persisted queue for the same
  concern.
- It does not proxy providers, so paid requests keep OpenCode's credentials and
  the policy plugin's view of them.
- It does not require the policy plugin to exist. Remove it and free-first still
  routes, fails over, and recovers; the fallback simply runs whenever it is
  needed.

## Removing one of them

Both plugins are independently removable:

```sh
opencode plugin remove opencode-free-first   # paid routing unaffected
opencode plugin remove opencode-offpeak      # free-first unaffected
```

Neither removal changes the other plugin's configuration file or persisted state.
