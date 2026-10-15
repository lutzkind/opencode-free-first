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

## 017 — No paid traffic to keep a cache warm

There is no evidence that warming the paid fallback's prompt cache pays for the
tokens, so no synthetic paid request is ever made for cache reasons. Cache misses
are accepted as a cost and latency concern, and the plugin minimises transitions
instead.
