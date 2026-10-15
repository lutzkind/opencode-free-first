# Roadmap

Deliberately short. The plugin's job is narrow, and most ideas here would widen
it, so each item needs evidence before it is implemented.

## Candidates

- **Provider-reported scope.** Derive `cooldownScope` from evidence (for example a
  shared-quota header) instead of requiring an operator to choose, once a provider
  actually publishes that information.
- **A TUI status line.** If OpenCode gains a stable status extension point, show
  `FREE`, `FREE cooldown: 8m`, or `FALLBACK` there. Core behaviour must not depend
  on it, and the RPC already exposes the same data.
- **Richer reset heuristics.** Additional reset header names and payload shapes, as
  fixtures, when a provider is observed to use them.
- **Session-scoped persistence pruning.** Drop persisted session hints when the
  session no longer exists, if OpenCode exposes a cheap existence check.

## Explicitly out of scope

- Off-peak windows, pricing, holiday calendars, queues, and holds — a cost/time
  policy plugin owns those.
- Provider proxying, credential management, or a second provider layer.
- Any daemon, external database, Redis, external queue, or systemd unit.
- A hosted or shared service of any kind.
- Keeping the paid fallback's prompt cache warm with synthetic traffic.
