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

Order matters in exactly one way: a plugin that can veto a retry must be listed
**before** `opencode-free-first`, so free-first's retry hook — the failover — has
the last word. OpenCode runs same-name hooks in plugin order.

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

### 3 — Free model recovers while the paid route is parked

The fallback route is peak-priced, so the policy plugin holds the paid request
inside its own pre-model hook. The free cooldown expires first. Free-first probes
out of band, confirms recovery, and reclaims the parked task:

```
fallback request prepared → held by the policy plugin
free cooldown expires     → probe → free healthy
interrupt                 → the parked paid attempt is cancelled, and the policy
                            plugin drops its own pending continuation
switch to free            → the session is back on the free model
synthetic continuation    → the same session, conversation, agent, and working
                            directory continue, and the task finishes on free
```

Asserted in the suite: zero paid requests dispatched, exactly one user message,
exactly one invisible continuation, and a successful (not interrupted) turn.

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
