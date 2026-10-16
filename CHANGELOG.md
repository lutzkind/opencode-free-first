# Changelog

Notable changes. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [semantic versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.7]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.7
[0.1.6]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.6
[0.1.5]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.5
[0.1.4]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.4
[0.1.3]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.3
[0.1.2]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.2
[0.1.1]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.1
[0.1.0]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.0
