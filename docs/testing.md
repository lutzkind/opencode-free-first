# Testing

Two layers, with a hard rule: **no test provokes a real free-tier rate limit.**

## Unit tests — `npm test`

Hermetic. `npm run compile` then `node --test test/*.test.mjs`. Every provider
failure, clock, timer, storage, session API, and generation call is injected
through `test/fakes.mjs`, so the whole state machine, failover path, recovery
path, and concurrency behaviour are exercised deterministically.

| File | Covers |
| --- | --- |
| `classify.test.mjs` | `429`, structured types, message patterns, false-positive resistance, reset metadata for every supported header and payload shape |
| `health.test.mjs` | State transitions, ladder growth, maximum enforcement, jitter, absolute timestamps, persistence round-trip, corrupt-state handling |
| `config.test.mjs` | Defaults, every validation failure, file/option merge precedence, model-reference forms |
| `engine-failover.test.mjs` | Failover, same-session continuity, reset sources, every unrelated error type, missing and failing fallbacks, duplicate-signal dedup |
| `engine-recovery.test.mjs` | Probe-driven and passive recovery, still-limited and inconclusive probes, switch minimisation, prompt/prepare routing, manual overrides, park reclamation, restart semantics, dispose |
| `engine-concurrency.test.mjs` | Simultaneous limits, probe herds, one probe per herd, duplicate observations, pruning, explicit-selection handling, driver failure safety |
| `log.test.mjs` | Credential redaction, level gating, bounding |
| `package.test.mjs` | Published entrypoints, no machine paths or credentials, no provider proxy or paid router, import graph containment |

### Fixtures

`test/fakes.mjs` provides `FakeClock` (explicit timer control), `FakeStorage`,
`FakeSessions` (records every switch, synthetic, interrupt, wait, and get),
`FakeGenerate` (probe success, rate limit, or arbitrary failure), and
`rateLimitError()` shaped exactly like OpenCode's classified provider error.

### Required assertions

The suite asserts, among others: `FREE_HEALTHY → FREE_COOLDOWN`; `FREE_COOLDOWN →
FREE_PROBE`; probe success and probe rate limit transitions; ladder growth and
maximum; authoritative reset honoured; restart restores, discards, and ignores
corrupt state; same-session failover; no duplicated prompt (the paid request
carries the same message count); unrelated errors never trigger failover; a
failed probe never touches the main session; exactly two transitions per cycle;
three consecutive cycles without thrash; manual override respected in both
directions; duplicate `429`s deduplicated; one probe per herd; and clean disposal.

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
| 3b — parked, live server | The task finishes on the free model, exactly one user message, exactly one synthetic continuation, the turn ends `succeeded`, the session ends on the free model |
| 4 — still limited | The fallback keeps owning the work; the probe is rate limited |
| 6 — probe fails | No main-session churn |

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
