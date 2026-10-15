# Security

## Scope

`opencode-free-first` is an OpenCode plugin. It decides which model a session
uses and when to switch back. It does not authenticate to any provider, does not
hold credentials, and does not proxy traffic.

## Credentials

- The plugin never reads, stores, copies, or logs a provider credential.
- The fallback and the recovery probe both use OpenCode's own provider
  configuration and credential store.
- There is no second credential store, no `.env` handling, and no token in
  configuration examples.

## Logging

The logger redacts anything whose key looks like a credential (`key`, `token`,
`secret`, `password`, `authorization`, `cookie`, `credential`), omits response
bodies and header maps entirely, bounds every string to 200 characters, bounds
nesting depth, and truncates long arrays. Prompts are never logged.

## Network

The plugin makes exactly one kind of outbound request: the recovery probe, issued
through `ctx.generate.text` against the configured primary model, using OpenCode's
normal routing. It also reads and writes OpenCode's own plugin storage. It opens
no listening socket, starts no server, and talks to no service other than the one
OpenCode already talks to.

## Failure containment

- A malformed configuration disables the plugin instead of routing traffic
  through a guessed model.
- Corrupt persisted state is discarded; only this plugin's derived state is
  affected.
- A storage or session-API failure is reported and degrades a single transition,
  never the session.
- A failure in one session's recovery never interrupts another session's work.

## Model switching

Switching a session's model is an ordinary OpenCode operation. The plugin never
disables, bypasses, or weakens OpenCode's permission rules, and the fallback route
is subject to exactly the same permissions as any other model.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer listed
in `package.json`. Please include the OpenCode version, the plugin version, the
configuration (with any credential removed), and a reproduction. Do not open a
public issue for a credential leak or a routing bug that can send data to an
unintended provider.
