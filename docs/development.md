# Development

## Setup

```sh
git clone https://github.com/lutzkind/opencode-free-first.git
cd opencode-free-first
npm install
npm run check          # lint + typecheck + unit tests
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run lint` | Biome check |
| `npm run format` | Biome format (write) |
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `npm run compile` | Emit `dist/` for Node consumers and tests |
| `npm test` | Compile, then hermetic unit tests |
| `npm run test:integration` | Real CLI + real `opencode-offpeak` + mock provider |
| `npm run test:tui` | Real OpenCode TUI on the installed binary via tmux |
| `npm run test:offpeak-regression` | The neighbour plugin's own checks |
| `npm pack --dry-run` | Inspect the published file list |

## Layout

```
index.ts            directory-install entrypoint (re-exports the server entry)
server.ts           directory-install entrypoint (re-exports the server entry)
tui.ts              directory-install CLI entrypoint (re-exports src/tui.ts)
src/server.ts       plugin definition: hooks, events, transform, RPC
src/tui.ts          native /free-first commands and mode selector (RPC client)
src/engine.ts       orchestration and the single recovery path
src/health.ts       state machine, ladder, jitter, persistence codec
src/classify.ts     rate-limit classification and reset metadata
src/config.ts       option and file resolution, validation
src/log.ts          redacting logger
src/rpc.ts          control-RPC definition and context-free handler
src/types.ts        shared types and storage keys
test/               unit tests, fakes, integration suite, mock provider
docs/               operator-facing documentation
```

## Why the source is the entrypoint

OpenCode runs its plugin host on Bun and resolves a package's `bun` export
condition, so `src/server.ts` is executed directly — no build step is involved in
installing or updating the plugin. `dist/` exists for `node` consumers, for the
type declarations, and because the tests exercise the compiled output, which also
guarantees the code type-checks.

A directory install resolves `<dir>/server` and `<dir>/index`, which is why both
`server.ts` and `index.ts` exist at the repository root. The TUI companion is
loaded from the package's `./tui` export, so `tui.ts` and `src/tui.ts` must stay
in the published package.

## Adding a rate-limit signal

1. Add the narrowest possible rule to `src/classify.ts`, with a comment naming the
   provider wording it targets.
2. Add a positive fixture to `test/classify.test.mjs`.
3. Add a negative fixture proving a near-miss is still rejected.
4. If it is a reset source, add it to `HEADER_ORDER` (headers) or
   `RESET_BODY_KEYS` (payload) and to the `ResetSource` union in `src/types.ts`.
5. Update `docs/state-machine.md`.

## Changing routing

Keep these invariants:

- A switch happens only at a safe boundary: never mid-stream, never during an
  active tool call, never just to test availability.
- Recovery is confirmed before the main session moves.
- A complete free-limit cycle costs exactly two transitions.
- Failover never leaves the session, ends the turn, or duplicates a prompt.
- Nothing calls a provider except the probe, and the probe goes through
  `ctx.generate.text`.

Update `ARCHITECTURE.md`, `DECISIONS.md`, and `CHANGELOG.md` in the same change.

## Releasing

See [`RELEASING.md`](RELEASING.md).
