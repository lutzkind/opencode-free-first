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

## 028 — Transient free-route availability failures fail over (supersedes the rate-limit-only policy)

Until now the failover covered exactly two causes: a genuine rate limit and
OpenCode's free-tier eligibility gate. Everything else was left to surface — so a
provider 500 on the free route killed the turn even when the configured fallback
was available. The live incident (2026-10-18): `AI.Error.ProviderInternal`
("Provider request failed with HTTP 500") failed a session's drain while the
paid route was healthy. That policy is **superseded**.

The invariant now is:

> If the configured free route is temporarily unable to serve an otherwise valid
> request, continue the same turn on the configured fallback. If the request,
> credentials, configuration, or plugin itself is broken, surface the real error
> instead of hiding it behind fallback.

The repair keeps the shape of the gate work (decisions 025–027) exactly: one new
classifier category (`transient-availability`), one new health transition that
reuses the shared cooldown, one new reason on `cooldownReason`, and the existing
failover, cooldown-routing, recovery, retry-kind, and persistence paths, with no
new mechanism of any kind. The category covers provider/server `500`/`502`/`503`/
`504`, OpenCode's structured `provider.internal` (which OpenCode 2.0.30 only
constructs for server-side or network-error paths), structured `provider.timeout`,
and the transport/connectivity failures OpenCode's own retry policy already
treats as transient (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`,
`ConnectionRefused`, `ConnectionClosed`, `FailedToOpenSocket`, any `UND_ERR_*`,
`fetch failed`, `terminated`, `other side closed`, `socket hang up`, a timeout
wording) — the plugin sees the message, not the code, so the predicate is
mirrored from OpenCode's own transient test rather than invented.

Being a *separate* category, not a broadened rate limit, is the point: a 500 is
not a quota event and must never be recorded as one. It walks its own bounded
ladder (`transientFailures` against the configured `backoffMs`), so a single
isolated outage blocks the free route for one short rung — never hours — and
repeated outages back off further, bounded by `maxCooldownMs`. A confirmed
success resets the ladder. A rate limit still wins its own bookkeeping: the
`level` ladder, the reset source, and `lastRateLimit*` are never touched by an
outage, and vice versa.

The conservative half is unchanged in direction and only refined in scope: a
`400`, a `401`, a generic `403`, an invalid key, an invalid model, a content
filter, a context-length error, a tool failure, a plugin bug, or an unclassified
failure without positive evidence keeps its real type and never fails over. A
false positive would silently hide an operator problem behind paid routing, which
is the same reasoning as decision 005.

Evidence: the live `ProviderInternal` 500 shape is covered by unit tests for the
classifier and the engine (failover, session retention, compaction suppression,
no-fallback, opt-out, duplicates, bounded escalation, recovery, probe re-arm,
restart, adoption), and by two live-CLI integration cases that run the real
OpenCode CLI against the deterministic mock provider: a 500 fails the same turn
over with no duplicated prompt and the continuation carrying the same
conversation and tool set, and the existing recovery path returns the session to
the free model automatically once the outage clears.

## 029 — The reason label names the cause that owns the current deadline

Three causes share the one cooldown (decision 025's reasoning, extended by 028).
What must stay apart is the diagnosis. Two rules make the shared record honest in
both directions:

- a live cooldown is never shortened by a later signal — the later deadline wins;
- `cooldownReason` names the cause that owns the deadline, not merely the most
  recent signal.

So a transient outage that arrives while a live rate-limit or free-route cooldown
still has the longer deadline is *recorded* (its ladder and timestamps move, so
escalation continues) but does not relabel the cooldown or hide the rate limit's
metadata; and a transient cooldown keeps its own label until it is superseded by a
cause with a longer deadline. Diagnostics can therefore always answer "why is the
free route out right now" without conflating a provider 500 with a quota event —
which is exactly the standard decision 025 set for the gate.

## 030 — An elapsed cooldown with no waiting session is dropped

Decision 020/027 required an elapsed cooldown to leave the record, but the
no-waiting-session path (an opted-out session observes a limit, a limit with no
reachable fallback) still kept it: recovery returned early, nothing normalised the
record, and the scheduler re-armed a 1 ms wake-up for a boundary already behind it
— a measurable busy loop (1000 wake-ups per second) for as long as the record
stayed elapsed. The same gap existed when both probing and passive recovery were
disabled. Recovery now normalises the elapsed record on every branch before it
decides anything else, while keeping the ladder positions and the outage/limit
history. Dropping the record here is explicitly *not* a claimed recovery:
`lastHealthyAt` is not set.

## 036 — A saved mode lives in plugin storage, not in the config file

The TUI needs a mode choice that survives a restart without editing JSON. Live
configuration editing is not part of OpenCode's plugin API, and rewriting the
user's `opencode.json` (or `free-first.json`) from a plugin would be a second,
surprising configuration authority. The mode therefore lives in the same plugin
storage the plugin already uses for health and session hints, under
`opencode-free-first/mode-v1`.

Precedence is explicit and reversible:

1. the saved mode (TUI or `set-mode` RPC),
2. the configured `freeUsageMode`,
3. the historical default `always-free-first`.

`clear-mode` removes the saved document and returns to configuration. The master
`enabled` switch always wins over either, so a saved mode can never override an
operator's deliberate disable. There is no database, daemon, second service, or
duplicate store.

Evidence: unit tests for save/restore, override precedence, corrupt documents,
persistence failure, clear-mode, restart, and cross-instance adoption; the real
TUI test restarts OpenCode and observes the saved choice; the live mode-switch
integration restarts the real server and observes the same choice.

## 037 — The TUI is a thin client of the control RPC

The CLI companion registers `/free-first` with the supported `keymap.layer`
slash API and uses `ui.dialog.select` for the selector. It deliberately stores
nothing: `status`, `set-mode`, and `clear-mode` all go through the server
plugin's control RPC, which owns the engine and the persistent choice. This keeps
one source of truth, makes the same commands work in the TUI and over HTTP, and
avoids a second state machine in a UI layer.

Mode changes rebuild model defaults with `model.reload` and emit the existing
portable `transition` event so other locations can adopt the choice. The engine
alone performs routing; the UI never calls `switchModel` or touches a session.
The selector labels the third choice **Disable Free-first**, and every status
message says **Free-first disabled**, because `/offpeak off` is a different
control owned by the neighbouring plugin.

Evidence: `test/tui.test.mjs` (deterministic fake TUI context) and
`test/tui-smoke.test.mjs` (real OpenCode 2.1.3 TUI in tmux, including the
`/offpeak off` independence check and a restart).

## 017 — No paid traffic to keep a cache warm

There is no evidence that warming the paid fallback's prompt cache pays for the
tokens, so no synthetic paid request is ever made for cache reasons. Cache misses
are accepted as a cost and latency concern, and the plugin minimises transitions
instead.

## 031 — `peak-only` consumes one canonical pricing answer; it never owns a calendar

Free-usage timing is derived entirely from `opencode-offpeak`'s read-only
`pricing` RPC for the configured fallback model. Copying the weekly windows or
the Chinese holiday calendar into this plugin would create two authorities that
drift. The mode only spends free quota on a positive `PEAK` answer; `OFF_PEAK`,
`FLAT`, `UNTRACKED`, `UNKNOWN`, a missing neighbour, and an RPC failure are all
closed. This is deliberately stricter than "not peak": an uncertain state must
not consume free quota. The capability is optional infrastructure, exactly like
`cancelHold`; no import, shared mutable state, or new service is introduced.

## 032 — Pricing is refreshed at existing safe boundaries, not by a timer

The cached answer expires at the earlier of the canonical `nextTransition` and a
60-second freshness bound. Prompt admission, request preparation, retry,
recovery, and probe dispatch refresh it, so the first supported boundary after a
change applies the new route and no extra scheduler, daemon, or wake-up is
created. An already-resolved in-flight request is allowed to finish because the
supported API cannot recall it; the next attempt or step is routed.

## 033 — A concurrent auxiliary 2xx is not a recovery proof

OpenCode 2.1 issues title and other auxiliary requests concurrently with the main
turn. A free title request that slipped through at a cooldown boundary returned
2xx and cleared the cooldown while a recovery probe was still in flight, which
masked the probe's refusal and could route a session back to Free prematurely.
A 2xx now proves free health only when that request was dispatched while Free was
eligible and no probe was in flight; the probe is the only verdict while it runs.

## 034 — OpenCode 2.1 compatibility is an explicit, tested claim

OpenCode 2.1 changed the session/compaction payload schema (`providerState` became
`native`) but not the plugin hooks used here (`model.request`, `http.request`,
`retry`, session events, RPC, model transforms). The only behavioural difference
observed on the real 2.1.3 binary was internal retry of buffered model calls,
which makes a refused recovery probe settle after the bounded retry schedule
rather than immediately; the probe remains bounded and never blocks Free forever.
The supported range is `>=2.0.26 <2.2.0`, declared in `engines.opencode`, and the
real-CLI coexistence suite runs on 2.1.3.

## 035 — The default mode cannot silently change an existing installation

`freeUsageMode` defaults to `always-free-first`. `peak-only` requires an explicit
fallback because the session-previous heuristic cannot be priced ahead of time.
An invalid mode is a visible configuration error that disables routing rather
than guessing. This preserves existing users' behaviour until they opt in.

## 036 — Free-route titles use a prompt fallback plus a settled upgrade

OpenCode's automatic title request is tool-less, and the free tier refuses that
shape even when the tool-bearing turn on the same model succeeds. The failure is
swallowed in core, so no retry/failover hook can recover it, and a core patch or
fork is out of scope for a plugin.

The chosen seam is the supported `title` hook plus the supported
`ctx.session.generate` call:

1. The hook returns the bounded, normalized first user prompt on the free
   primary. This costs no provider request, cannot race the turn or a failover,
   and makes the session durably named as soon as the turn starts.
2. After `session.execution.succeeded`, one tool-bearing `session.generate`
   request on the same session replaces the fallback. This mirrors upstream PR
   #57624 without a core patch. It is attempted only while the session is on the
   free primary and the router would spend free quota, is capped at three
   attempts, and re-checks the stored title immediately before renaming, so it
   cannot create paid traffic or overwrite a manual rename.
3. A native title failure on a non-free route is observed at `http.response` and
   filled from the first prompt through `session.update`. Title failures never
   feed the health/failover state.

Alternatives rejected: `ctx.generate.text` (also tool-less; live 403), building a
tool-bearing request through `http.request`/model-request rewrites (spoofing the
request shape), a title daemon/service/scheduler, a permanent OpenCode fork, or
writing the fallback as an empty title (OpenCode treats an empty stored title as
titled and suppresses every later attempt).
