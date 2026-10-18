# Testing

Two layers, with a hard rule: **no test provokes a real free-tier rate limit.**

## Unit tests — `npm test`

Hermetic. `npm run compile` then `node --test test/*.test.mjs`. Every provider
failure, clock, timer, storage, session API, and generation call is injected
through `test/fakes.mjs`, so the whole state machine, failover path, recovery
path, and concurrency behaviour are exercised deterministically.

| File | Covers |
| --- | --- |
| `classify.test.mjs` | `429`, structured types, transient availability (5xx, provider-internal, timeout, transport codes/phrases), message patterns, false-positive resistance, reset metadata for every supported header and payload shape |
| `health.test.mjs` | State transitions, ladder growth, maximum enforcement, jitter, absolute timestamps, the separate transient ladder, persistence round-trip, corrupt-state handling |
| `config.test.mjs` | Defaults, every validation failure, file/option merge precedence, model-reference forms |
| `engine-failover.test.mjs` | Failover, same-session continuity, reset sources, every unrelated error type, missing and failing fallbacks, duplicate-signal dedup |
| `engine-transient.test.mjs` | The transient availability policy: 5xx / structured / transport failover, the must-not-fail-over matrix, bookkeeping separation, duplicate suppression, bounded escalation, probe re-arm, compaction suppression, persistence/adoption, scheduler hygiene |
| `engine-route-rejected.test.mjs` | The free-route gate: classification boundary, shared episode, failover, recovery, restart |
| `engine-recovery.test.mjs` | Probe-driven and passive recovery, still-limited and inconclusive probes, switch minimisation, prompt/prepare routing, manual overrides, park reclamation, restart semantics, dispose |
| `engine-compaction.test.mjs` | Cooldown routing, compaction retry decisions, request-kind handling |
| `engine-cooldown-expiry.test.mjs` | Authoritative expiry, no re-block after inconclusive probes, cross-instance state, manual selection, transition churn |
| `engine-reclamation.test.mjs` | Hold cancellation, committed races, resume guards, degraded interrupt path |
| `engine-concurrency.test.mjs` | Simultaneous limits, probe herds, one probe per herd, duplicate observations, pruning, explicit-selection handling, driver failure safety |
| `log.test.mjs` | Credential redaction, level gating, bounding |
| `package.test.mjs` | Published entrypoints, no machine paths or credentials, no provider proxy or paid router, import graph containment |

### Fixtures

`test/fakes.mjs` provides `FakeClock` (explicit timer control), `FakeStorage`,
`FakeSessions` (records every switch, synthetic, interrupt, wait, and get),
`FakeGenerate` (probe success, rate limit, or arbitrary failure), and error
factories shaped exactly like OpenCode's classified provider errors:
`rateLimitError()`, `freeRouteGateError()` (the exact gate sentence),
`authError()`, plus the ad-hoc `provider.internal`/status shapes the tests build
inline.

### Required assertions

The suite asserts, among others: `FREE_HEALTHY → FREE_COOLDOWN` for every cause;
`FREE_COOLDOWN → FREE_PROBE`; probe success, probe rate limit, and probe outage
transitions; ladder growth and maximum for both ladders; authoritative reset
honoured; restart restores, discards, and ignores corrupt state; same-session
failover; no duplicated prompt (the paid request carries the same message count);
unrelated errors never trigger failover; a failed inconclusive probe never touches
the main session; exactly two transitions per cycle; three consecutive cycles
without thrash; manual override respected in both directions; duplicate signals
(of either cause) deduplicated; one probe per herd; and clean disposal.

## Integration tests — `npm run test:integration`

Opt in with `FF_INTEGRATION=1` (the script sets it). These run the **real OpenCode
CLI** and the **real `opencode-offpeak`** plugin against
`test/support/mock-provider.mjs`, a deterministic OpenAI-compatible server, using
a private `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` under a
temporary directory. Nothing touches your configuration, sessions, credentials,
or free-tier quota.

The mock's `__control` endpoint switches the free and paid roles between `ok`,
`429`, `500`, `401`, and `400`, sets `Retry-After` or an error body, and can fail
only the first *N* requests so a tier rate limits and then recovers.

Shared with the CI run via `CODEX_UNSAFE_ALLOW_NO_SANDBOX`-style opt-in is not
required; the suite uses `opencode run --standalone` and
`opencode serve --log-level debug` only.

| Case | Assertion |
| --- | --- |
| 1 — healthy | Only the free model is requested; the policy plugin does not interfere; no transition |
| 2 — limited | The paid request carries the same conversation; one paid continuation; no duplicated prompt |
| 3 — parked | Zero paid requests dispatched; parked reclamation logged; the free tier limited exactly the configured attempts |
| 3b — parked, live server | The task finishes on the free model, exactly one user message, no synthetic continuation needed, the turn ends `succeeded`, the session ends on the free model |
| 4 — still limited | The fallback keeps owning the work; the probe is rate limited |
| 6 — probe fails | No main-session churn |
| 7 — probe path refused | The refused probe never blocks the free model; new sessions stay on it |
| 8/9 — compaction | A known cooldown issues the compaction on the fallback; a limit discovered by a compaction fails over without burning more free requests |
| 12 — free-tier gate | The exact gate fails the same turn over once, no repeated doomed call |
| 13 — gate clears | Automatic recovery returns the session to free; the status names the cause |
| 14 — auth failure | Stops visibly; no paid request |
| 15 — provider 500 | The same turn continues on the fallback; the paid continuation carries the same conversation and tool set; no duplicated prompt; one session |
| 16 — outage clears | Automatic recovery returns the session to free; the status names the transient cause, no rate-limit metadata invented |

Useful environment variables:

| Variable | Effect |
| --- | --- |
| `FF_KEEP_HOME=1` | Keep the temporary home directory for inspection |
| `FF_OPENCODE=/path/to/opencode` | Use a specific CLI binary |
| `FF_OFFPEAK_SPEC=<spec>` | Install a different `opencode-offpeak` version |

## Coexistence regression — `npm run test:offpeak-regression`

Runs `opencode-offpeak`'s own `lint`, `typecheck`, and `test` in its checkout
(`OFFPEAK_CHECKOUT`, default `../opencode-offpeak`) and fails loudly if the
neighbour repository is missing. It never modifies that repository. Its purpose is
to prove that installing and running free-first leaves the policy plugin's
behaviour unchanged.

## CI

- `.github/workflows/ci.yml` — lint, typecheck, unit tests, and `npm pack
  --dry-run` on Linux and macOS.
- `.github/workflows/ci-standard.yml` — the standard repository checks.
- The integration suite needs a real OpenCode binary and network access to fetch
  the neighbour plugin, so it is opt-in and documented rather than wired into the
  default CI job.
