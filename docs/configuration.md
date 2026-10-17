# Configuration

Every option has a working default, so an empty configuration is valid. Options
are read from the OpenCode plugin entry and merged over an optional JSON file at
`$XDG_CONFIG_HOME/opencode/free-first.json` (default
`~/.config/opencode/free-first.json`). Plugin options win.

The file may be a bare object or wrapped:

```jsonc
{ "freeFirst": { "logLevel": "debug" } }
```

An invalid value is reported at `error` level and disables the plugin rather than
falling back to a guessed route.

## Models

| Option | Default | Notes |
| --- | --- | --- |
| `primary` | `{ "providerID": "opencode", "id": "deepseek-v4.1-flash-free" }` | The free model. Accepts an object or `"providerID/modelID"`. |
| `fallback` | unset | The model to use while the free model is limited. When unset, the session's previous model is used, then OpenCode's own configured default, then the session's current model. |
| `primaryModel` | — | Alias for `primary`. |
| `fallbackModel` | — | Alias for `fallback`. |

`variant` is accepted on either model (`{ "providerID": "…", "id": "…",
"variant": "max" }`). When a target model has no configured variant, the variant
of the session's current model is carried across if the target model supports it,
so a switch does not silently reset the user's reasoning-effort setting.

```jsonc
{
  "package": "opencode-free-first",
  "options": {
    "primary": { "providerID": "opencode", "id": "deepseek-v4.1-flash-free", "variant": "max" },
    "fallback": { "providerID": "opencode-go", "id": "deepseek-v4.1-flash", "variant": "max" }
  }
}
```

## Behaviour

| Option | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `off` disables every routing decision, timer, and probe, and preserves persisted cooldown state. |
| `preferAsDefault` | `true` | Publish `primary` as OpenCode's default model selection, so new sessions start on the free model. |
| `adoptFallbackSessions` | `false` | Also manage sessions whose model is the configured `fallback`, returning them to the free model when it is usable. Leave off unless you want free-first to move sessions you left on a paid route. |
| `respectExplicitModelSelection` | `true` | Stop managing a session when you pick another model by hand. With `false`, a manual switch to the paid route keeps the session managed. |
| `passiveRecovery` | `true` | Let the next real model call confirm recovery when probing is not used. |
| `probe` | `true` | Issue one tiny out-of-band recovery probe at cooldown expiry. Alias: `recoveryProbe`. A probe that cannot decide never blocks the free model; only a real rate limit does. |
| `parkPreemption` | `true` | Reclaim a fallback request parked by another plugin's pre-model hold once the free model is confirmed healthy. |
| `cooldownScope` | `"shared"` | `"shared"` keeps one cooldown for the whole OpenCode instance (a free tier is normally per account, and this also prevents probe storms). `"session"` limits per session. |
| `sessionLimit` | `200` | Upper bound on remembered sessions; the least recently updated are evicted. |

## Timing

| Option | Default | Notes |
| --- | --- | --- |
| `backoffMs` | `[60000, 120000, 300000, 600000, 900000]` | The ladder used only when the provider gives no reset time. The last value repeats. Entries must be between 250 and 86 400 000 ms. |
| `maxCooldownMs` | `900000` | Cap on a ladder-derived cooldown. An authoritative provider reset is not capped. |
| `jitterRatio` | `0.1` | Symmetric jitter as a fraction of the ladder value, clamped to `[0, 1]`. |
| `failoverRetryDelayMs` | `250` | Delay for the first attempt on the fallback, so failover is immediate. |
| `duplicateLimitWindowMs` | `5000` | Window in which a second limit signal counts as the same provider window and does not advance the ladder again. |
| `parkGraceMs` | `5000` | How long a prepared-but-undispatched fallback request may take before it is treated as parked. |
| `switchConfirmMs` | `10000` | Window in which a model-selection event is attributed to this plugin rather than to the user. |
| `probePrompt` | `"Reply with the single word: pong"` | The probe's prompt. Keep it tiny. |
| `probeMaxTokens` | `8` | Output bound applied to the probe through the `generate` hook. |
| `probeUnsupportedBackoffMs` | `21600000` (6h) | How long to stop probing after the host refuses the probe path itself (OpenCode's free tier does, with `Generate.UnavailableError`). Recovery continues passively in the meantime. |
| `routeRejectRetryMs` | `300000` (5m) | How long the free route stays off after OpenCode's own free-tier eligibility gate ("the free tier can only be used from within OpenCode") refused a real model request. The gate carries no provider reset, so this is the bounded window before the existing recovery path retries the free route through a real request. Between 1 000 and 86 400 000 ms. |
| `continuationText` | OpenCode's own interrupted-continuation sentence | The invisible continuation admitted when a parked task is reclaimed. |

## Logging

| Option | Default | Notes |
| --- | --- | --- |
| `logLevel` | `"info"` | `silent`, `error`, `info`, or `debug`. |

`info` logs state transitions: free selected, rate limit detected, free route
rejected (with the classification, HTTP status, and retry window), classification
reason, retry/reset source, cooldown start and expiry, fallback selected, probe
scheduled/started/limited, free recovered, safe switch back to free, explicit
manual override detected, stale fallback continuation neutralized, duplicate
continuation prevented — plus a `model transition` line for every switch.

`debug` adds per-request decisions: request preparation, dispatch, and every
provider failure that was *not* classified as a rate limit, with the reason.
Useful for "why did it not fail over?".

Logs never contain prompts, response bodies, header maps, or credentials.

## Example: conservative public configuration

```jsonc
{
  "package": "opencode-free-first",
  "options": {
    "primary": "opencode/deepseek-v4.1-flash-free",
    "fallback": "opencode-go/deepseek-v4.1-flash",
    "backoffMs": [60000, 120000, 300000, 600000, 900000],
    "maxCooldownMs": 900000,
    "jitterRatio": 0.1,
    "logLevel": "info"
  }
}
```

## Example: no extra requests at all

```jsonc
{
  "package": "opencode-free-first",
  "options": {
    "probe": false,
    "parkPreemption": false
  }
}
```

Recovery then happens passively: the next real model call after the cooldown
expires is issued on the free model, and if it is still limited the session fails
over again on the next ladder step.

Note that even with `"probe": true` the plugin falls back to exactly this passive
behaviour whenever a probe cannot decide — an inconclusive probe is never a reason
to keep the free model blocked.
