# Releasing

## Current public distribution

`v0.3.0` is the canonical release and is installable from its exact GitHub tag
with OpenCode CLI v2:

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-free-first.git#v0.3.0
```

The release includes the server plugin and its native CLI (TUI) companion. The
`./tui` export is loaded automatically by the TUI; a release is not complete
until both entries load on the current production OpenCode version.

OpenCode officially accepts npm-compatible Git package specifications, including
GitHub URLs and exact tags, and loads the plugin's `bun` entrypoint directly. npm
publication is an optional future distribution channel; no npm login, 2FA, or
registry publication is required for this release to be installed or used.

## GitHub release checklist

1. `npm run check` — lint, typecheck, unit tests.
2. `npm run test:integration` — real CLI plus the real `opencode-offpeak`.
3. `npm run test:offpeak-regression` — the neighbour plugin's own checks.
4. `npm run test:tui` — real TUI on the current binary (tmux, opt-in).
5. `npm pack --dry-run` — confirm the file list has no development or machine
   files and includes `tui.ts` and `dist/tui.js`.
6. Confirm `package.json` `version` matches the intended tag.
7. Update `CHANGELOG.md` with the release date and a link to the tag.
8. Commit, tag `vX.Y.Z`, push the branch and the tag.
9. Create the GitHub release from the tag with the changelog entry as the body.
10. Verify the exact-tag install in a scratch OpenCode home, including the TUI
    entry (`/free-first status`), and check that the saved mode starts from the
    configured `freeUsageMode`:

   ```sh
   XDG_CONFIG_HOME=/tmp/verify-config XDG_DATA_HOME=/tmp/verify-data \
   XDG_CACHE_HOME=/tmp/verify-cache \
   opencode plugin add git+https://github.com/lutzkind/opencode-free-first.git#vX.Y.Z
   XDG_CONFIG_HOME=/tmp/verify-config XDG_DATA_HOME=/tmp/verify-data \
   XDG_CACHE_HOME=/tmp/verify-cache opencode plugin list
   ```

11. Record the verification, including the loaded entrypoint path and the TUI
    version, in the release notes or the project handoff.

## Compatibility gate

Each release states the OpenCode range it was verified against. `engines.opencode`
is `>=2.0.26 <2.2.0` (server hooks verified on 2.0.27/2.0.30; server and TUI
verified on 2.1.3) and
`@opencode/plugin` is pinned to the exact tested version.
Before widening the range, verify the plugin loads and the failover, recovery, and
park-reclamation paths still behave in the new host, and update
`docs/testing.md`.

## Optional npm distribution

The package may be published to npm in the future if a maintainer chooses to add
that channel. Its absence does not block a release or require any user action.

For a future bootstrap, confirm the version is absent, review
`npm pack --dry-run`, publish through an authorized maintainer account, and never
commit an npm token. After the package exists, configure npm trusted publishing
for this repository and workflow so no long-lived credential is stored, and only
then enable a publish job. Do not create a version or a GitHub release merely to
test the channel: npm versions cannot be reused.

## Versioning

Semantic versioning over the plugin's public surface: configuration keys, the
behaviour described in `README.md`, and the RPC method and fields. A behaviour
change that alters when a session is switched, or which errors count as
exhaustion, is a minor bump at least; removing or renaming a configuration key is
a major bump.
