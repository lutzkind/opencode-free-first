## [0.2.0] — 2026-10-23

### Added

- **`freeUsageMode` with `always-free-first` (default), `peak-only`, and `off`.**
  `peak-only` reserves DeepSeek Free for verified PEAK pricing periods and sends
  off-peak, weekend, and Chinese statutory-holiday traffic straight to Go. It
  requires an explicit fallback. The default preserves existing installations.
- **Canonical pricing consumption, not a second calendar.** `peak-only` calls a
  read-only `pricing` RPC on `opencode-offpeak` and accepts only a positive
  `PEAK` answer. `OFF_PEAK`, `FLAT`, `UNTRACKED`, `UNKNOWN`, a missing plugin, and
  an RPC failure all keep Free closed. No schedule, holiday table, daemon,
  scheduler, queue, proxy, or state store was added.
- **Pricing-aware routing boundaries.** Prompt admission, request preparation,
  retry, recovery, and probe dispatch refresh the cached classification; the
  cache expires at the earlier of the canonical `nextTransition` and 60 seconds.
  At OFF_PEAK an elapsed cooldown is cleared without a probe and executing or
  newly admitted Free sessions move to Go at the next step. The model transform
  publishes Go as the default off-peak.
- **Status visibility.** `status` now reports `freeUsageMode`, `pricingState`,
  `pricingNextTransition`, `pricingPolicyID`, `pricingReason`, and `activeRoute`
  (`FREE`, `GO`, `MIXED`, `NONE`); the status line names the policy, pricing
  state, and route, and still reports a legitimate cooldown/fallback reason.

### Fixed

- **OpenCode 2.1 concurrent title/auxiliary responses can no longer fake a Free
  recovery.** A free request dispatched while Free was cooling down (typically an
  automatic title) returned 2xx and cleared the cooldown, masking the recovery
  probe's refusal. A 2xx now counts only when the request was dispatched while
  Free was eligible and no probe was in flight.

### Compatibility

- **OpenCode `>=2.0.26 <2.2.0`**, verified against the current production
  **2.1.3** binary as well as 2.0.27/2.0.30. OpenCode 2.1 changed the
  session/compaction payload schema (`providerState` → `native`), not the plugin
  hooks this package uses; the previous `<2.1.0` range was unnecessarily narrow.
  Buffered model calls now retry internally, so a structurally refused recovery
  probe settles after the bounded OpenCode retry schedule instead of instantly;
  it is still bounded and never blocks Free permanently.
- Coexistence verified with `opencode-offpeak` `v0.2.0` on 2.1.3, including
  OFF_PEAK + `peak-only` (Go only, zero Free calls), PEAK + healthy Free (offpeak
  does not block it), PEAK + Free 429 (paid Go stays held by offpeak's cost
  protection, then Free recovery reclaims it), and an OFF_PEAK compaction (Go,
  zero Free requests).

### Tests

- 311 deterministic unit tests (up from 287) plus 21 real-OpenCode coexistence
  cases, all green on OpenCode 2.1.3. New coverage includes all three modes, the
  strict-PEAK matrix, OFF_PEAK probe suppression, PEAK/OFF_PEAK boundaries,
  weekend/holiday classifications, cooldown crossing, cross-instance state,
  restart, compaction, active-turn PEAK→OFF behaviour, `context_length_exceeded`
  non-failover, and the concurrent-2xx regression.

# Changelog

Notable changes. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.10] — 2026-10-18

### Fixed

- **A temporary provider outage of the free route no longer kills the turn.**
  When the free model answered an otherwise valid request with a provider/server
  failure, the error was left to surface even though the configured fallback was
  available. The live incident (2026-10-18): the free route returned
  `AI.Error.ProviderInternal` ("Provider request failed with HTTP 500"), the
  session's drain failed, and the turn died — while the paid route was healthy.
  The previous policy only failed over on a rate limit or OpenCode's free-tier
  eligibility gate; that policy is **superseded**.

  Temporary free-route availability problems now fail over in the same turn on
  one unified category, `transient-availability`, while request/account/
  configuration/plugin defects keep their real failure type and stay visible.
  The same session and turn continue on the configured fallback with one cheap
  retry — no second prompt, no replayed tool calls, no new session — and the
  existing recovery path returns the session to the free model once the route
  recovers.

- **An elapsed cooldown with no waiting session no longer spins the scheduler.**
  When a cooldown was recorded but nothing was switched to the fallback (an
  opted-out session observed the failure, or no fallback could be resolved), the
  elapsed record was never normalised: `status` kept reporting `FREE_PROBE` and
  the scheduler re-armed a 1 ms wake-up for a boundary already behind it —
  measured at 1000 wake-ups per second. Recovery now drops the elapsed record on
  every branch before deciding anything else. Dropping it is not a claimed
  recovery (`lastHealthyAt` is untouched), and the ladder positions and history
  survive.

### Added

- **`transient-availability`**: the third cooldown cause, armed by provider/
  server `500`/`502`/`503`/`504`, OpenCode's structured `provider.internal`
  (only constructed for server-side or network-error paths) or `provider.timeout`,
  and the transport/connectivity failures OpenCode itself treats as transient
  (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `ConnectionRefused`,
  `ConnectionClosed`, `FailedToOpenSocket`, any `UND_ERR_*`, `fetch failed`,
  `terminated`, `other side closed`, `socket hang up`, `sse read timed out`,
  `response headers timed out`, a timeout wording).
- `classifyTransientAvailability`, exported from `./core` with
  `applyTransientUnavailable`.
- A separate bounded transient ladder (`transientFailures`, `lastTransientAt`,
  `lastTransientType`) over the configured `backoffMs`, so one isolated outage
  blocks the free route for one short rung — never hours — and repeated outages
  back off further, capped by `maxCooldownMs`. A confirmed success resets it. The
  rate-limit ladder, the reset source, and `lastRateLimit*` are never touched by
  an outage, and vice versa: a provider 500 can never be presented as, or
  recorded as, a quota event.
- The recovery probe gains a `transient` outcome: a probe that hits a genuine
  outage re-arms the transient cooldown on the next ladder rung and leaves the
  waiting sessions on the fallback instead of thrashing between free and paid.
  Probe outcome `unsupported` and `inconclusive` keep their existing fail-open
  handling; the host-refused probe path stays passive-only.
- `status` fields `transientFailures`, `lastTransientAt`, and
  `lastTransientType` (e.g. `failover-http-500`,
  `failover-structured-provider-internal`, `failover-transport-econnreset`,
  `probe-http-503`), and the status line
  `FREE unavailable: transient provider failure (retry in 1m)`.
- `model transition` entries use the `availability-failover` trigger for this
  cause.
- Shared-state semantics: the transient ladder and timestamps are adopted across
  instances like the cooldown itself, a recovery confirmed elsewhere also clears
  them, and a transient outage that arrives while a longer rate-limit or
  free-route cooldown is live is recorded without relabelling or shortening it —
  `cooldownReason` always names the cause that owns the current deadline.
- 53 unit tests across the classifier, the health state machine, and the engine
  (the 5xx/structured/transport failover matrix, the must-not-fail-over matrix,
  bookkeeping separation, duplicate suppression, bounded escalation, probe
  re-arm, compaction suppression, no-fallback and opt-out sessions, persistence,
  restart, cross-instance adoption, and the scheduler-hygiene regression), plus 2
  live CLI cases: a provider 500 fails the same turn over with the continuation
  carrying the same conversation and tool set, and the free route returns
  automatically once the outage clears.

### Changed

- The retry-hook debug line is now
  `provider failure is not a free-model availability failure` and reports both
  the rate-limit verdict and the transient-availability verdict.
- The compaction log for a suppressed retry names the cause that suppressed it
  (`a just-limited free model`, `a free route that just rejected it`, or
  `a transiently unavailable free model`).

### Documentation

- `ARCHITECTURE.md`, `DECISIONS.md` (028–030), `README.md`,
  `docs/state-machine.md`, `docs/configuration.md`, `docs/troubleshooting.md`,
  `docs/testing.md`, and `docs/coexistence.md` now state the governing rule
  explicitly: temporary free-route availability problems use the paid fallback;
  permanent request/account/configuration/plugin failures remain visible. The
  previous rate-limit-only policy is recorded as superseded rather than left
  contradictory.

### Evidence

- 287 unit tests (was 234), 16 integration cases (was 14; real `opencode` CLI,
  real `opencode-offpeak`, deterministic mock provider), the `opencode-offpeak`
  regression suite (134/134), `npm run lint`, `npm run typecheck`, and
  `npm pack --dry-run` all pass.

## [0.1.9] — 2026-10-17

### Fixed

- **OpenCode's own free-tier eligibility gate no longer kills a turn.** When the
  gateway answered a real model request with
  `OpenCode's free tier can only be used from within OpenCode. Download it at
  https://opencode.ai and keep building.` (observed live on 2026-10-17, arriving
  as a `provider.auth` failure with HTTP 403), the refusal was left to surface as
  an authentication error: every affected session stopped, and the plugin never
  switched to the configured fallback. The gate is now recognised on a real model
  request (agent loop, title, or compaction), the shared cooldown is armed with
  `cooldownReason: "free-route"`, and the same session and turn continue on the
  fallback model with one cheap retry — exactly the failover path a rate limit
  already used.

  The incident is a *route* problem, not a rate limit and not a credential
  problem, so the two must not be confused in either direction. Detection is the
  gate's own sentence and nothing else: a generic 401/403, an invalid API key, an
  unsupported provider, or a malformed request keeps its real failure type, does
  not fail over, and stays visible. A `free-route` cooldown never advances the
  backoff ladder and never writes `lastRateLimitAt`/`lastRateLimitType`/
  `lastResetSource`; `status` and the status line report the route rejection, not
  a rate-limit cooldown.

  A rate limit and a free-route refusal share the existing cooldown mechanism
  because the consequence is identical, and because that reuse is what gives the
  new cause cross-instance adoption, the cooldown-routing guard, and the existing
  recovery path for free. The gate carries no provider reset, so the window is
  `routeRejectRetryMs` (default 5 minutes, configurable). The first conclusive
  rejection establishes the episode: every executing managed session is moved to
  its fallback immediately, and a duplicate refusal from another session neither
  restarts the episode nor extends the window, so a herd cannot turn the gate
  into a schedule the provider never gave.

  The out-of-band recovery probe keeps its existing handling: the same sentence on
  `ctx.generate.text` is a *probe-path* refusal (`unsupported`), backed off for
  `probeUnsupportedBackoffMs`, with recovery continuing passively. Only a real
  model request is a free-route rejection, and a refused probe can therefore never
  suppress a real session failure.

- **Passive recovery drops the elapsed cooldown from the record.** With
  `"probe": false` the passive branch returned the waiting sessions to the free
  model but left the elapsed `FREE_COOLDOWN` in the record, so `status` kept
  reporting `FREE_PROBE` and the scheduler kept re-arming a wake-up that was
  already due. It now normalises the record exactly as the probe branch does.

### Added

- `classifyFreeRouteRejection`, a narrow classifier for OpenCode's free-tier
  eligibility gate on a real model request, exported from `./core` with
  `applyFreeRouteUnavailable`.
- `HealthRecord.cooldownReason` (`"rate-limit" | "free-route"`) and
  `HealthRecord.routeRejectedAt`, plus the matching `status()` fields, so an audit
  can tell a genuine rate limit from a temporarily unavailable free route and can
  see when the episode started.
- `routeRejectRetryMs` configuration (default `300000`, 5 minutes, bounded
  1 000–86 400 000 ms).
- The status line reports `FREE unavailable: route rejected (retry in 5m)` while a
  free-route cooldown is active.
- `model transition` entries use the `route-reject-failover` trigger for this
  cause, so switch-churn debugging names it.
- 11 unit tests for the classification boundary, the shared episode, failover,
  recovery, restart/cross-instance adoption and the health record, plus 3 live
  CLI cases: the gate fails the same turn over with no duplicated prompt and no
  repeated doomed free request; the existing recovery path returns the session to
  the free model once the gate clears (asserted through the plugin's own `status`
  RPC); and a generic 401 still stops visibly with zero paid requests.

### Documentation

- `ARCHITECTURE.md`, `DECISIONS.md` (025–027), `README.md`,
  `docs/state-machine.md`, `docs/configuration.md` and `docs/troubleshooting.md`
  now state the three-way distinction explicitly: rate limited ≠ free-route
  rejected ≠ auth/config failure.

### Evidence

- 234 unit tests, 14 integration cases (real `opencode` CLI, real
  `opencode-offpeak`, deterministic mock provider), `opencode-offpeak` regression
  suite, `npm run lint`, `npm run typecheck`, and `npm pack --dry-run` all pass.

## [0.1.8] — 2026-10-16

### Fixed

- **A compaction that begins while FREE is already in a confirmed cooldown no
  longer spends a doomed free request.** OpenCode resolves a request's model at
  the step boundary — before any plugin hook runs — and it issues an automatic
  compaction at that same boundary. A compaction attempt that was already
  prepared cannot be re-routed either: OpenCode's compaction retry re-sends the
  request it prepared. So the `context` hook was structurally too late for a
  compaction, and the session kept spending a free request that free-first
  already knew would be limited, surfacing a failed `Rate limit exceeded`
  compaction even though the cooldown was known.

  A cooldown now keeps the sessions that can reach such a boundary on the
  fallback: every managed session with an active execution is moved to its
  fallback as soon as a cooldown is established or adopted, and the shared
  cooldown is adopted at every request preparation (not only at prompt
  admission), so another instance's limit applies here before the next step
  boundary resolves a model. Idle sessions are deliberately left alone — they
  cannot compact, and prompt admission plus preparation both route them — so a
  limit cycle never churns sessions that were not going to spend a request.

- **A compaction attempt is not retried on a free model that has just
  limited.** The retry decision now uses the kind of the request that was
  actually dispatched: a primary request is re-resolved by OpenCode when it is
  retried, while a compaction re-sends its own prepared model, so retrying it
  would only spend the same doomed request again. The session is still moved to
  the fallback, so the next compaction runs there.

- **A cancelled paid compaction does not dispatch instead.** When a held paid
  compaction is reclaimed because FREE recovered first, the released request is
  refused at the transport boundary (v0.1.7 behaviour). Because a compaction
  attempt cannot change its model on retry, authorizing the retry would have
  dispatched exactly the paid request that was just cancelled; instead the
  attempt ends, one invisible continuation resumes the turn, and the compaction
  completes on the free model.

### Changed

- `status()` adds `cooldownRouting` (`runs`, `routed`) and
  `compactionRetriesSuppressed`.

### Documentation

- **RPC examples corrected.** OpenCode's generic RPC endpoint wraps its
  argument, so the documented command is
  `--data '{"input":{"action":"status"}}'`. A package test now fails if a bare
  `{"action":…}` example returns to the shipped documentation.

### Evidence

- 198 unit tests (14 new for compaction routing and retry decisions), 11
  integration cases including the two required compaction scenarios: a known
  cooldown issues the compaction on the fallback with zero free requests, and a
  genuine free limit discovered by a compaction fails over without being
  retried.

## [0.1.7] — 2026-10-16

### Fixed

- **Headless `opencode run` now survives park reclamation.** Reclaiming a
  peak-held fallback request used to require `session.interrupt`, and OpenCode's
  headless runner treats any interruption as the end of the run — so `opencode
  run` exited before the resumed step produced an answer, even though the
  session, model, and task were already correct. Reclamation now asks the
  parking plugin to cancel the held request through its generic `cancelHold`
  RPC capability: the cancelled request is refused at the transport boundary
  (never sent), OpenCode reports a retryable transport failure, and this plugin
  routes the retry back to the free model — inside the same execution. No
  interruption, no continuation input, one user message, and the final answer
  is returned normally.

### Added

- A versioned cooperation contract with `opencode-offpeak`
  (`opencode-offpeak.cancelHold`, declared locally in `src/offpeak.ts` — no
  source import) plus capability detection. When the neighbour is absent, older,
  or refuses the call, reclamation falls back to the interrupt-based sequence
  unchanged; nothing is guessed.
- `status()` fields `holdCancelCapability`, `holdCancels`, and `pendingResumes`.
- Integration coverage for the exact headless scenario: free limit, failover,
  parked paid request, free recovery, cancellation, zero paid requests, and the
  final answer printed by `opencode run` — plus transcript assertions (one user
  message, no continuation input, two model transitions, one session, ends on
  the free model) read from OpenCode's own database.
- Unit coverage for the cancellation reclamation, the committed-race outcome,
  the unavailable-capability fallback, the resume policy guards (override,
  cooling-down, non-retryable, unrelated failure), and the status diagnostics.

## [0.1.6] — 2026-10-16

### Fixed

- Share the recovery-probe back-off and attempt count between plugin instances,
  like the cooldown itself. OpenCode loads one instance per location, so without
  this a back-off established in one location was invisible everywhere else and
  every instance could probe the same refused path again — a probe herd, and
  misleading `status` output on the instance that answered.

## [0.1.5] — 2026-10-16

### Fixed

- **An inconclusive recovery probe no longer keeps the free model blocked.** An
  inconclusive probe means *unknown*, never *limited*, so it now leaves the free
  model usable and lets the next real model call decide. Previously it re-armed a
  short blocking cooldown every time, which meant that once a probe could not
  succeed, new sessions were routed to the fallback forever — even hours after an
  authoritative reset had passed. This is the live defect fixed in this release.
- **The recovery probe distinguishes a refused probe path from an unknown
  failure.** OpenCode's own free tier refuses the out-of-band probe
  (`Generate.UnavailableError`, "OpenCode's free tier can only be used from within
  OpenCode") because transient generation is not the agent loop. That is logged at
  `error` with an actionable message, backs the probe off hard
  (`probeUnsupportedBackoffMs`, default 6h) instead of retrying a structurally
  refused request every minute, and switches to passive recovery.
- **An elapsed cooldown is dropped from the record.** A cooldown whose timestamp
  has passed could stay in the state document, which made `status` report
  `FREE_PROBE` and kept waking the scheduler for a boundary already behind it.
  It is now normalised away on every fail-open outcome.
- **A genuine limit keeps the probe verdict.** A new rate limit says nothing new
  about whether the probe path works, so the probe back-off and attempt count
  survive it instead of being reset on every cycle.
- `classifyFreeLimit` reports `unclassified-message` instead of the misleading
  `no-signal` when a provider message was present but matched nothing.

### Added

- `probeUnsupportedBackoffMs` configuration (default 21600000, 6h).
- `status()` fields `probeBackoffUntil`, `inconclusiveProbes`, and
  `lastProbeOutcome`, so diagnostics show why probing stopped.
- Unit coverage for: an authoritative cooldown expiring while the process stays
  alive; a refused probe path never blocking the free model; an elapsed cooldown
  being dropped without a scheduler busy loop; a stale instance being unable to
  resurrect an expired cooldown or overwrite a newer recovery; a newer real limit
  replacing a healthy state; manual free-model selection after an expired cooldown
  and during a valid one; and repeated cycles without transition churn.
- An integration case that runs the real OpenCode CLI against a host that refuses
  the probe path, proving the free model stays the normal route.

## [0.1.4] — 2026-10-15

### Fixed

- A write from one plugin instance can no longer clobber a live shared cooldown
  recorded by another. The shared record is now monotonic with respect to an
  active cooldown: a stale healthy instance adopts the cooldown instead of
  overwriting it with its own state.
- A freshly started instance no longer claims a recovery. `lastHealthyAt` is only
  set by an observed success, a successful probe, or an adopted foreign recovery,
  so a start-up can never be mistaken for the free model coming back.
- A recovery this instance already confirmed is never undone by adopting a stale
  ladder position from the shared record.

### Added

- Unit coverage for shared-cooldown monotonicity and for a restart not claiming a
  recovery.

## [0.1.3] — 2026-10-15

### Fixed

- `status` now reflects the whole OpenCode instance. It re-reads shared health
  before reporting, so a cooldown recorded in another location is never reported
  as a healthy free model.

### Added

- A recovery confirmed by another instance is adopted as authoritative, so a
  stale local cooldown cannot outlive the recovery that cleared it.

## [0.1.2] — 2026-10-15

### Fixed

- Refresh persisted health before every routing decision, so a long-lived
  OpenCode service applies a cooldown that another instance (or another
  location) recorded. Previously an instance that had been running before the
  limit kept its in-memory healthy state, which could waste one free request and
  add an unnecessary transition when it moved a session back to a still-limited
  free model.

### Added

- Unit coverage for cross-instance adoption and for declining to probe while
  another instance's cooldown is live.

## [0.1.1] — 2026-10-15

### Fixed

- Share the cooldown and the backoff position between every plugin instance.
  OpenCode loads one plugin instance per location, and every instance shares this
  plugin's storage, so a rate limit discovered in one location is now adopted by
  the others before they act. This keeps a single free-tier limit from being
  rediscovered per location and prevents cross-location probe storms.

## [0.1.0] — 2026-10-15

First public release. Verified against OpenCode `2.0.27` with `@opencode/plugin`
`2.0.26`, alongside `opencode-offpeak` `v0.1.6`.

### Added

- Free-model preference: publishes the configured free model as OpenCode's
  default selection and routes managed sessions to it.
- Conservative rate-limit classification: HTTP `429`, the structured
  `provider.rate-limit` and `provider.quota` error types, and tightly scoped
  exhaustion wording. Auth failures, invalid requests, content filters, tool
  failures, transport errors, provider 5xx, no-route errors, and plugin bugs keep
  their real failure type and never trigger failover.
- Same-session, same-turn failover through OpenCode's retry hook: the session's
  model is switched to the configured fallback and one cheap retry continues the
  turn with the same history, agent, working directory, and tool state.
- Reset metadata extraction: `Retry-After`, `Retry-After-Ms`,
  `x-ratelimit-reset*`, structured reset timestamps in the payload, and reset
  phrases in the message.
- Bounded backoff ladder with symmetric jitter for a provider that supplies no
  reset time, configurable in full.
- Absolute, persisted cooldowns with a small derived state machine
  (`FREE_HEALTHY` → `FREE_COOLDOWN` → `FREE_PROBE`), restart restoration, expired
  cooldown discard, corrupt-state recovery, and no probe at start-up.
- Recovery that prefers one tiny out-of-band probe (`ctx.generate.text`, no
  session, no tools, no history) and falls back to passive recovery on the next
  real model call when probing is disabled.
- Park reclamation: cancels a fallback request held by another plugin's pre-model
  hook, neutralises that plugin's own pending continuation, and resumes the same
  task on the free model with one invisible synthetic continuation.
- Concurrency handling: one shared cooldown, one probe in flight for any number
  of waiting sessions, duplicate-signal deduplication, and herd-safe expiry.
- Explicit manual model selection respected in both directions; plugin-initiated
  switches are recognised so they are never mistaken for user intent.
- Cache-aware switch minimisation: zero transitions while healthy, exactly two per
  free-limit cycle, no warm-up traffic on the paid route, no mid-stream switch.
- Diagnostics RPC (`status`, `reset`, `on`, `off`) and transition logging with
  credential redaction.
- 146 hermetic unit tests with injected fakes, and six live coexistence cases that
  run the real CLI with the real `opencode-offpeak`.

### Notes

- `opencode-offpeak` is optional and never a dependency. It must be listed
  *before* `opencode-free-first` so free-first's retry hook has the last word.
- A headless `opencode run` exits when the park reclamation interrupts the turn;
  the session, model, and continuation are already correct. The TUI continues the
  resumed step normally.

[0.1.10]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.10
[0.1.9]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.9
[0.1.8]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.8
[0.1.7]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.7
[0.1.6]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.6
[0.1.5]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.5
[0.1.4]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.4
[0.1.3]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.3
[0.1.2]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.2
[0.1.1]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.1
[0.1.0]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.0
