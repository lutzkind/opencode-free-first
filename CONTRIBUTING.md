# Contributing

Thanks for helping. This repository contains one OpenCode v2 plugin with a narrow
job, and keeping it narrow is the main review criterion.

## Before you start

- `git status -sb` — a local checkout is not proof that it matches `origin/main`.
- Read `README.md`, `ARCHITECTURE.md`, and `DECISIONS.md`.
- For anything touching routing, classification, recovery, or the park sequence,
  open an issue describing the observed behaviour first.

## What belongs here

Free-model availability: preference, rate-limit classification, failover,
cooldown, recovery, and the diagnostics for those.

## What does not

Off-peak windows, pricing, holiday calendars, paid queues, holds, provider
proxies, credential stores, daemons, external databases, or a second scheduler for
paid work. Those belong to a cost/time policy plugin, and duplicating them here
would break the boundary that makes the two plugins installable and testable
independently.

## Checklist

1. `npm run check` passes.
2. Behaviour changes come with a unit test driven by injected fakes, and with a
   negative test where a false positive is the risk.
3. Never provoke a real free-tier limit in a test. Add a fixture instead.
4. `README.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `docs/`, and `CHANGELOG.md` are
   updated in the same change.
5. No credentials, tokens, prompts, response bodies, or machine-specific absolute
   paths in code, tests, or documentation.
6. The plugin stays installable, configurable, enableable, disableable, testable,
   and publishable on its own.
7. If `opencode-offpeak` behaviour could be affected, run
   `npm run test:offpeak-regression`. Never modify that repository from here.

## Style

- TypeScript, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Biome decides formatting and lint.
- Comments explain *why*, especially where OpenCode's behaviour is
  non-obvious. Cite the mechanism you are relying on.
- Keep functions small and pure where possible; put side effects behind an
  injected port.

## Commits and pull requests

- Small, focused commits with a clear imperative subject.
- Describe the observed behaviour, the change, and the verification in the pull
  request body.
- Note any behaviour that is deliberately unchanged.
