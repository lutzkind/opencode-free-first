# Changelog

Notable changes. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [semantic versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.3]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.3
[0.1.2]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.2
[0.1.1]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.1
[0.1.0]: https://github.com/lutzkind/opencode-free-first/releases/tag/v0.1.0
