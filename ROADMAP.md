# Roadmap

Deliberately short. The plugin's job is narrow, and most ideas here would widen
it, so each item needs evidence before it is implemented.

## Recently closed

- **In-TUI mode control (v0.3.0).** Closed with a native CLI companion
  (`./tui`): `/free-first`, `/free-first status`, `/free-first mode
  free-first|peak-only|disabled`, and a native selector. The choice is persisted
  in plugin storage with an explicit `saved choice > freeUsageMode > default`
  precedence, `clear-mode` returns to configuration, and the labels keep
  **Free-first disabled** distinct from `/offpeak off`.

- **Peak-only free usage (v0.2.0).** Closed with `freeUsageMode` and a read-only
  `pricing` RPC from `opencode-offpeak`: Free is spent only in a verified PEAK
  window, off-peak/weekend/holiday traffic routes to Go with no Free request or
  probe, and the default remains `always-free-first`.

- **Transient free-route availability failures (v0.1.10).** Closed by one
  `transient-availability` category (provider 5xx, structured provider-internal/
  timeout, qualifying transport failures) that reuses the shared cooldown with its
  own bounded ladder, plus a `transient` probe outcome. Supersedes the
  rate-limit-and-gate-only failover policy.

- **Compaction against a known cooldown (v0.1.8).** Closed by keeping the
  sessions that can reach a step boundary on the fallback while a cooldown is
  active, and by never retrying a compaction on a model that just limited.

- **Headless `opencode run` and park reclamation (v0.1.7).** Closed without
  changing OpenCode: reclamation now cancels the held request through the parking
  plugin's generic `cancelHold` capability, and the cancelled attempt is refused
  at the transport boundary, so OpenCode's own retry machinery continues the same
  execution on the free model.

## Candidates

- **Provider-reported scope.** Derive `cooldownScope` from evidence (for example a
  shared-quota header) instead of requiring an operator to choose, once a provider
  actually publishes that information.
- **A TUI status line.** The mode control is already native; a persistent footer
  indicator (`FREE`, `FREE cooldown: 8m`, `GO`) is still a candidate. Core
  behaviour must not depend on it, and `/free-first status` already exposes the
  same data.
- **Richer reset heuristics.** Additional reset header names and payload shapes, as
  fixtures, when a provider is observed to use them.
- **Session-scoped persistence pruning.** Drop persisted session hints when the
  session no longer exists, if OpenCode exposes a cheap existence check.

## Explicitly out of scope

- Off-peak windows, pricing, holiday calendars, queues, and holds — a cost/time
  policy plugin owns those. `peak-only` consumes their answer; it never copies
  the calendar.
- Provider proxying, credential management, or a second provider layer.
- Any daemon, external database, Redis, external queue, or systemd unit.
- A hosted or shared service of any kind.
- Keeping the paid fallback's prompt cache warm with synthetic traffic.
