# Troubleshooting

Start with the plugin's own view of the world:

```sh
opencode api post /api/rpc/opencode-free-first/control --data '{"action":"status"}'
```

Every decision is also logged with the `[opencode-free-first]` prefix. Set
`"logLevel": "debug"` for per-request detail.

## Nothing happens at all

1. Confirm the plugin is installed and loaded:
   ```sh
   opencode plugin list
   ```
   The installed entry should show `opencode-free-first` with the tag or path you
   installed.
2. Confirm the plugin logged its start-up line. With `--print-logs` you should see
   `[opencode-free-first] loading { … }` followed by `[opencode-free-first] ready`.
3. If you see
   `free-first configuration invalid; plugin disabled` at `error` level, the
   message names the offending field. Fix it and reload.
4. Confirm the primary model id exists:
   ```sh
   opencode models | grep deepseek-v4.1-flash-free
   ```
   If it is missing, the id or provider is wrong for your OpenCode version and the
   plugin logs
   `primary model is not available; leaving the default selection unchanged`.

## Sessions do not start on the free model

- `preferAsDefault` must be `true` (the default). With it off, the plugin never
  changes OpenCode's default selection; it only manages sessions that are already
  on the free model.
- The terminal's model selector can remember a previous choice. Select the free
  model once, or set `model` in `opencode.json`.
- Sessions that were already on the paid route stay there unless
  `adoptFallbackSessions` is `true`. That is deliberate: free-first does not move
  a session you left on a paid route by default.

## A rate limit is hit but the session does not fail over

Check the debug log for one of these:

- `provider failure is not a free-model rate limit` — classification declined.
  The detail shows the `type`, `status`, and `classification` reason. If a
  provider returns something unexpected that is genuinely a limit, add it as a
  fixture-backed test rather than loosening the parser ad hoc.
- `session is not managed by free-first; leaving its model unchanged` — the
  session was repointed by hand, so management ended.
- `no fallback model available; surfacing the free-model failure` — no
  `fallback` option, no remembered previous model, and no OpenCode default could
  be resolved. Set `fallback` explicitly.
- `failed to switch session to the fallback model` — the switch call itself
  failed; the underlying error is logged alongside.

If the *transition* line appears but the retry still lands on the free model,
another plugin's `retry` hook ran after free-first's and vetoed it. List
`opencode-free-first` after any plugin that can veto retries.

## The session never leaves the fallback

Recovery has not been confirmed yet. Look at:

- `state` and `cooldownMs` from `status` — the cooldown may still be running.
- `cooldown started` in the log and its `resetSource`:
  - `retry-after` / `retry-after-ms` / `x-ratelimit-reset` /
    `reset-timestamp` — the provider told us when the free model returns, and the
    plugin waits for it. If the provider's claim is very generous, that is the
    provider's own number.
  - `backoff` — no reset metadata was supplied, so the ladder applies.
- `recovery probe rate-limited` — the free model is still limited; the cooldown
  was extended and the ladder advanced.
- `recovery probe inconclusive` — the probe failed for a reason that is not
  exhaustion (a transport error, a 5xx, a bad route). Free health is unchanged and
  a short retry was armed. This one is worth investigating: it usually means the
  free model route itself is broken.
- With `"probe": false`, recovery is passive. A session that is idle will stay on
  the fallback until it makes another model call.

## The task seems to restart after recovery

After a parked paid request is reclaimed, the log shows `stale fallback
continuation neutralized` and `duplicate continuation prevented`, and the session
records exactly one additional `synthetic` message containing the continuation
sentence. That synthetic message is not rendered in the terminal and is not a
duplicated prompt: the conversation history, agent, and working directory are
unchanged.

A headless `opencode run` exits as soon as the interrupt settles, before the
resumed step completes. The session, the model, and the continuation are already
correct; open the session (or use `--continue`) to see it finish. The TUI does not
have this limitation.

## Switch churn

Use `status().transitions`. A healthy free period records **zero** transitions. A
complete free-limit cycle records exactly two: `failover` and one of
`probe-recovery` / `passive-recovery` / `park-preemption`. Anything more means a
repeated limit is being signalled faster than the cooldown, which the debug log
shows as `duplicate: true` on the second `free rate limit detected`.

## Two plugin instances, or a stale version

```sh
opencode plugin list
opencode api get /api/plugin | grep -i free-first
```

There must be exactly one active instance. A local development path and a
published package installed at the same time both load. Remove the one you do not
want:

```sh
opencode plugin remove opencode-free-first
```

OpenCode caches installed packages under `~/.cache/opencode/npm/`. If the log
still shows an outdated entrypoint after a supported update, remove the specific
cached package directory for this plugin and reload. Never clear the whole cache:
it holds credentials-adjacent state for other plugins and the session store does
not live there.

## Resetting state

- Lift a cooldown you know is gone:
  ```sh
  opencode api post /api/rpc/opencode-free-first/control --data '{"action":"reset"}'
  ```
- Pause routing entirely:
  ```sh
  opencode api post /api/rpc/opencode-free-first/control --data '{"action":"off"}'
  ```
  Persisted cooldown state is preserved, and `on` resumes.
- Permanently forget derived state by removing the
  `plugin:<id>:opencode-free-first/*` rows from OpenCode's plugin storage. This
  never touches sessions, prompts, credentials, or configuration.

## Reporting a problem

Include `opencode --version`, the offending option block, the `status` output,
and a `logLevel: "debug"` excerpt. Redact API keys, authorization headers,
prompts, and file contents.
