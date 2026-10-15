# Repository instructions

## Start here

- Run `git status -sb` before making changes. A local checkout is not proof that it
  matches the canonical `origin/main`; verify the repository and branch before
  editing or reporting state.
- Use `/root/REPO_MAP.md` as the host-level repository map when working on the
  canonical host checkout.
- Read `README.md`, `ARCHITECTURE.md`, and `DECISIONS.md` before changing routing,
  classification, recovery, or the park-reclamation sequence. `ROADMAP.md`
  describes future work and is not current scope unless explicitly promoted.

## Commands

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:integration` (real OpenCode CLI + real `opencode-offpeak`; opt-in)
- `npm run test:offpeak-regression` (the neighbour plugin's own checks)
- `npm pack --dry-run`

Tests use fixtures and a deterministic mock provider; they must never incur
provider charges or provoke a real free-tier limit.

## Production

- This repository contains one OpenCode CLI v2 package with a `server` entrypoint
  (plus root `index.ts` and `server.ts` shims for directory installs). Do not add a
  parallel daemon, database, scheduler, queue, provider proxy, or credential store.
- The plugin owns **free-model availability only**: preference, rate-limit
  classification, failover, cooldown, recovery, and their diagnostics. Paid
  cost/time policy belongs to a separate plugin.
- Failover must stay in the same session and the same turn: one prompt, no replayed
  tool calls, no new session. Recovery must be confirmed before the main session
  moves, and a complete free-limit cycle must cost exactly two model transitions.
- The only provider-facing call is the recovery probe, and it must go through
  `ctx.generate.text`. Never call a provider directly and never bypass OpenCode's
  routing.
- `opencode-offpeak` is a neighbour, not a dependency. Never import it, never
  modify it, and keep the fallback on ordinary OpenCode routing. It must be listed
  before `opencode-free-first` so this plugin's retry hook has the last word.
- Keep the OpenCode support range explicit and test the installed plugin API
  version before expanding it.
- Do not place credentials, auth files, provider responses, or private user prompts
  in documentation, issues, or handoffs.
