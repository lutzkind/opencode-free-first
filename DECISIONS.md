# Decisions

Short records of choices that are easy to re-litigate later.

## 001 — Availability only; paid timing belongs to a policy plugin

Free-model availability and paid cost/time policy are separate concerns. Merging
them would force every user to adopt one opinionated paid router, and would
duplicate an existing plugin's scheduler. This plugin therefore never delays,
queues, or prices anything.

## 002 — Failover through OpenCode's retry hook

OpenCode re-resolves a session's model for every provider attempt, and its retry
hook runs after failure classification but before the retry is scheduled. Leaving
`decision.retry = true` and switching the model in that hook therefore continues
the *same* turn on the fallback route with the same history, agent, working
directory, and tool state.

The alternatives were worse: `interrupt` plus a synthetic prompt interrupts
productive work on every failure; a second session loses the working directory and
tool state; a provider proxy duplicates credentials and bypasses the host's
routing.

## 003 — The failover retry delay is small and configurable

OpenCode's default policy for a rate limit with `Retry-After` is to wait for that
reset and retry the *free* model up to ten times. That is exactly the behaviour
this plugin removes. The failover retry uses `failoverRetryDelayMs` (default
250 ms) so the next attempt happens immediately on the fallback route.

## 004 — An authoritative reset wins over the ladder

When the provider states when the free model is usable again, waiting is free and
probing earlier is waste. `Retry-After`, `Retry-After-Ms`, `x-ratelimit-reset*`,
a reset timestamp in the payload, and a reset phrase are all honoured, and the
cooldown may exceed the ladder's maximum because the provider's claim is better
information than our guess. Nonsense values (already past, non-finite, or more
than a day away) fall back to the ladder.

## 005 — Detection is conservative and structured-first

A false positive hides a real fault behind a model switch, so only a `429`,
OpenCode's structured `provider.rate-limit` / `provider.quota` types, or
explicitly scoped exhaustion wording count. Structured non-limit types win over
matching phrases, and negations are rejected before positive patterns.

## 006 — Classification reads the provider contract, not prose alone

OpenCode 2.0.26+ classifies provider failures into stable structured types
(`provider.rate-limit`, `provider.quota`, `provider.auth`, `provider.internal`, …)
and carries the HTTP status and raw response body on the same error object. Using
those first keeps the parser from having to guess, and keeps unrelated failures
visible.

## 007 — Recovery prefers one out-of-band probe over a real request

Switching a session to the free model to find out whether it works spends a real
request and two model transitions when it fails. One tiny transient generation
(`ctx.generate.text`) settles health without a session, tools, or history, so a
failed probe changes nothing for a productive fallback session and a successful
one costs exactly one fallback → free transition.

## 008 — Passive recovery exists for the no-probe case

When probing is disabled, or nothing is waiting, the next real model call is the
test. This keeps the cheapest correct path available for users who do not want any
extra requests.

## 009 — Parked paid work is reclaimed by interruption, not by waiting

A policy plugin can hold a request inside its own pre-model hook, so no provider
attempt exists to fail. Waiting for the policy window would keep the task on paid
capacity for hours while the free model is available. Cancelling the parked
attempt is the only mechanism OpenCode exposes, so the plugin interrupts, waits
(bounded) for the cancellation to settle, then continues the same session with one
invisible synthetic input.

The order matters: interrupting first makes the parking plugin drop its own
pending continuation, so the obsolete paid work cannot run twice. A wake-up
admitted before the interrupt is what previously let the parked request win the
race.

## 010 — Detection of "parked" is generic

The signal is "a request was prepared for the fallback and was still undispatched
after a grace window while the session was executing". That is exactly what a
pre-model hold looks like, and it works for any such plugin without importing,
naming, or configuring one.

## 011 — Cooldown scope defaults to shared

A free tier is normally enforced per provider account, so one cooldown is shared
across sessions and at most one probe is ever in flight. `cooldownScope:
"session"` is available for a provider that demonstrably limits per session.
Sharing is also what prevents probe storms.

## 012 — Explicit user model selection ends management

If the user repoints a session at an unrelated model — or deliberately at the paid
route — free-first stops managing it. The plugin's own switches are recognised
through a short-lived pending intent, so they are never mistaken for user intent.

## 013 — `preferAsDefault` publishes the free model as the default

Preferring the free model for *new* sessions is the requested end state, and the
supported way to do that is a model transform. `adoptFallbackSessions` is separate
and defaults to `false`, because moving sessions a user deliberately left on a
paid route should be an explicit choice rather than a surprise.

## 014 — Duplicate limit signals share one cooldown

A session's automatic title request and its agent loop can observe the same
provider window at the same moment. Advancing the ladder twice for one limit makes
backoff jumpy, so a second signal inside `duplicateLimitWindowMs` *while a
cooldown from the same window is still running* extends the cooldown but does not
advance the level. A later limit is a fresh signal and arms a bounded cooldown.

## 015 — Invalid configuration disables the plugin

The failure that must never happen is routing traffic through a guessed model
route. Invalid configuration therefore logs an error and disables free-first
behaviour, which is exactly "normal OpenCode behaviour", rather than failing
closed on the user's requests.

## 016 — Restart never triggers a probe

A restored cooldown that has already elapsed is discarded, not replayed, and no
probe is issued merely because OpenCode restarted. The first real request decides.
This keeps a restart from spending free-tier quota on housekeeping.

## 018 — An inconclusive probe is *unknown*, never *limited*

A probe that cannot decide must fail open. Treating it as a limit arms a blocking
cooldown on no evidence, and because the probe is retried on every cycle the block
becomes permanent: on 2026-10-16 every new session was routed to the fallback for
hours after the authoritative free-tier reset had passed, because the probe path is
refused by OpenCode's own free tier and the inconclusive branch kept re-arming a
60-second cooldown. An inconclusive probe now only schedules the next probe and
returns the waiting sessions to the free model, so the next real model call is the
test. A genuine limit still arms a real cooldown, so nothing is lost.

## 019 — A refused probe path is distinguished from an unknown failure

`Generate.UnavailableError` ("OpenCode's free tier can only be used from within
OpenCode") means the probe *mechanism* is refused, not that the model is limited.
Retrying it every minute is pointless, so it is recognised explicitly, logged once
at `error` with the exact reason, and backed off for `probeUnsupportedBackoffMs`
(6h by default) while recovery continues passively. Structural refusals
(`invalid-request`, `no-route`, `auth`, `unsupported-operation`) get the same
treatment; transient failures keep the ordinary ladder.

## 020 — An elapsed cooldown leaves the record

A cooldown whose timestamp has passed must not stay in the state document: it makes
`status` report `FREE_PROBE` and keeps waking the scheduler for a boundary already
behind it. Every fail-open outcome normalises the record to `FREE_HEALTHY` while
preserving the ladder position and the probe bookkeeping.

## 021 — A new limit keeps the probe verdict

Whether the probe path works is a property of the host and the model route, not of
the current rate-limit window, so `applyLimited` carries the probe back-off and
attempt count forward. Otherwise a structurally refused probe would be retried once
per limit cycle forever.

## 022 — Park reclamation cannot be make headless-safe without an architecture change (superseded by 023)

`opencode run` ends its stream loop unconditionally on
`session.execution.interrupted` (verified in OpenCode 2.0.30), and cancelling a
fallback request held inside another plugin's pre-model hook requires an
interruption. So the same session, model, and invisible continuation are correct,
but the headless client exits before the resumed step completes — a live
`opencode serve` (the TUI's transport) completes it, which the integration suite
proves. Making the headless client stay attached would require changing OpenCode's
headless client, changing the parking plugin, or introducing a wrapper/daemon; all
three are outside the approved architecture, so it is reported as
`ARCHITECTURE CHANGE PROPOSED — USER APPROVAL REQUIRED` rather than changed
silently.

## 023 — Park reclamation cancels the hold instead of interrupting the session (supersedes 022)

OpenCode's plugin API gives a pre-model hook exactly three exits: return (the
request is dispatched), throw (a defect that fails the execution), or be
interrupted (the turn ends). None of them let a plugin cancel a held request and
continue the same execution, which is why reclamation used `session.interrupt`
and why the headless runner — which treats any interruption as terminal — exited
before the resumed step answered.

The way out is not another failure channel but the *transport* one: the plugin
that owns the hold can be asked, generically and through RPC, to cancel it, and
it then refuses the request at the boundary instead of sending it. A refusal is a
typed, retryable transport failure, so OpenCode's own retry machinery continues
the same execution, and this plugin's retry hook only has to route that retry to
the free model. No interruption, no continuation input, no second session, and
`opencode run` returns the final answer normally. The capability is versioned and
optional: when the neighbour is absent, older, or refuses the call, reclamation
keeps the interrupt-based sequence unchanged rather than guessing. Evidence: the
integration suite's headless case (free limit → failover → parked paid request →
free recovery → cancellation → zero paid requests → final answer printed by
`opencode run`, with transcript assertions for one user message, no continuation
input, two model transitions, one session, and the free model at the end), plus
unit coverage of the committed race, the unavailable capability, the resume
guards, and the degraded interrupt path.

## 024 — A known cooldown is represented in the session, because compaction resolves before any hook

OpenCode resolves a request's model at the step boundary, before any plugin hook
runs, and it issues an automatic compaction at that same boundary. A prepared
compaction cannot be re-routed either: its retry re-sends the request it resolved
(verified in OpenCode 2.0.30's `SessionRunnerLLM.runStep`,
`SessionContext.select`, `SessionCompaction.compact`/`deliver`, and
`SessionModelRequest.prepare`). The lazy strategy — guard at `prompt` admission
and at each request preparation — is therefore structurally too late for a
compaction, and a session left on the free model through a known cooldown spends
a doomed free request and surfaces a failed `Rate limit exceeded` compaction.

The fix is to keep the *representation* true instead: while a cooldown is active,
every managed session with an active execution is moved to its fallback as soon
as the cooldown is established or adopted, and the shared cooldown is adopted at
every request preparation. Idle sessions are deliberately skipped — they cannot
compact, and both prompt admission and preparation route them — which keeps a
limit cycle from churning sessions that were never going to spend a request. The
retry decision learns from the dispatched request's kind for the same reason: a
primary request is re-resolved on retry, a compaction is not, so a compaction
that just limited is answered `{ retry: false }` while the session moves to the
fallback for the next attempt. A cancelled paid compaction follows the same rule
so the reclaim cannot dispatch the request it just cancelled.

Evidence: unit coverage for the routing pass, adoption from another instance,
idempotence, idle sessions, overrides, expiry and the retry-kind decisions; and
integration cases that run the real CLI — a known cooldown issues the compaction
on the fallback with zero free requests and no failed compaction, and a genuine
limit discovered by a compaction fails over and succeeds exactly once on the
fallback.

## 025 — The free-tier gate shares the cooldown, with a distinct reason

OpenCode's own free-tier eligibility gate ("OpenCode's free tier can only be used
from within OpenCode") answers a real model request as a `provider.auth` failure
with HTTP 403, so before this change it was left to surface and every affected
session died. It is not a rate limit (no 429, no quota signal, no provider reset)
and it is not a credential problem (the same refusal reaches ordinary OpenCode
users on a healthy account; it was a transient upstream condition on 2026-10-17).

The refusal therefore arms the *existing* shared cooldown with
`cooldownReason: "free-route"` instead of introducing a second blocking state.
The consequence is identical — the free route cannot service a request — so
recovery, cross-instance adoption, the cooldown-routing guard, and diagnostics all
reuse one mechanism, and nothing new can drift out of sync with it. What must stay
separate is the *cause*: a `free-route` cooldown is armed for `routeRejectRetryMs`
(a bounded window, since no provider reset exists), records `routeRejectedAt`,
never advances the ladder, and touches none of the rate-limit bookkeeping, so
diagnostics can never present it as a 429 and `statusLine` names the route rather
than a cooldown.

Detection stays exact: only the gate's own sentence on a real model request
matches. A generic 401/403, an invalid key, an unsupported provider, or a
malformed request keeps its real type and never fails over — a false positive
would silently hide an operator problem behind a model switch, which is the same
reasoning as decision 005.

Evidence: the live incident (several concurrent sessions, each failing with the
gate, no failover), unit coverage for the classification boundary, the shared
episode, failover, recovery and restart, and integration cases that run the real
CLI: the gate fails the same turn over to the fallback exactly once with no
duplicated prompt, and the existing recovery path returns the session to the free
model once the gate clears.

## 026 — A refused probe path stays a bounded, passive-only problem

Decision 019 already handles the gate when it arrives on the out-of-band probe:
the probe path is structurally refused, so it is `unsupported`, backed off for
`probeUnsupportedBackoffMs` (6h), and recovery continues passively. That is
retained unchanged: a persisted probe-capability verdict keyed to an OpenCode
version and model would add a second compatibility framework for a request that
runs at most once per back-off window, fails open, and disturbs nothing. The
distinction that matters instead is path-dependent and is asserted in tests: the
same sentence is a *probe-path refusal* on `ctx.generate.text` and a
*free-route rejection* on a real model request.

## 027 — Passive recovery drops the elapsed cooldown too

Decision 020 said an elapsed cooldown must leave the record so `status` stops
reporting `FREE_PROBE` and the scheduler stops waking for a boundary already
behind it. The passive branch (probing disabled) had never applied it, so with
`"probe": false` the record kept an elapsed timestamp and the scheduler re-armed
a due wake-up in a tight loop. Writing the free-route tests surfaced it; the
passive branch now normalises the record before returning the waiting sessions to
the free model, which is what the probe branch already did.

## 017 — No paid traffic to keep a cache warm

There is no evidence that warming the paid fallback's prompt cache pays for the
tokens, so no synthetic paid request is ever made for cache reasons. Cache misses
are accepted as a cost and latency concern, and the plugin minimises transitions
instead.
