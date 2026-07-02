# Releasing (WS5 runbook)

Decisions: GitHub org **traceweavehq** (2026-07-02) · License **Apache-2.0**
(approved 2026-07-02 — explicit patent grant matters in this product space).
The repo stays PRIVATE and nothing publishes publicly (repo flip, npm,
Marketplace) before the dogfood gate (AIW-231) passes.

## One-time setup

1. Create the GitHub org `traceweavehq` (web UI — github.com/organizations/new),
   then create the empty repo `traceweavehq/traceweave`.
2. Reserve the npm names **immediately** (they were free on 2026-07-02, they
   are first-come): `npm org create traceweave` (scope `@traceweave`) and the
   unscoped CLI name `traceweave` (first publish claims it).
3. Collision sweep before the first public push: search npm, PyPI, crates.io,
   GitHub, and a trademark register for "traceweave" (a dormant GitHub user
   `traceweave` exists — created 2025-09, zero repos; no other collision known).
4. Push this monorepo; enable: branch ruleset requiring the `gate` +
   `test` checks (see docs/gate-recipes.md), CodeQL + Scorecard workflows
   (already in `.github/workflows/`), private vulnerability reporting.

## Every release

1. `npm test` green on the CI matrix (3 OS × Node 20/22/24).
2. Bump versions (engine/cli/action move together while pre-1.0), update
   CHANGELOG.md, drop `"private": true` (first release only), confirm
   `"license"` fields.
3. Tag: signed, `vX.Y.Z`. The action additionally moves the **major tag**
   (`v1`) — but consumers are told to pin by SHA, not tag (SECURITY.md).
4. Publish with provenance from a GitHub Actions release workflow (npm
   provenance requires CI): `npm publish --provenance --access public` for
   `traceweave` (CLI), `@traceweave/engine`, `@traceweave/action`.
5. Announce SHA-pinned action usage in the release notes:
   `uses: traceweavehq/traceweave/packages/action@<release-commit-sha>`.

## Pinning contract (what we promise consumers)

- Release tags are signed and immutable; the `v1` major tag moves only across
  backward-compatible releases.
- The recommended consumption form is always the full commit SHA.
- Fingerprint/format changes follow the versioned-contract rules in
  docs/file-format.md — a normalize() change is a MAJOR, never a patch.
