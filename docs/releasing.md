# Releasing (WS5 runbook)

Decisions: GitHub org **canonweave** (2026-07-02) · License **Apache-2.0**
(approved 2026-07-02 — explicit patent grant matters in this product space).
The repo stays PRIVATE and nothing publishes publicly (repo flip, npm,
Marketplace) before the dogfood gate (AIW-231) passes.

## State (2026-07-02)

DONE: org + private repo live · Apache-2.0 · SHA-pinned CI matrix green on
3 OS × Node 20/22/24 · CodeQL/Scorecard workflows (guarded until public) ·
release pipeline (`.github/workflows/release.yml` + `scripts/pack-npm.mjs`) ·
ruleset prepared (`.github/ruleset-protect-main.json`; API returns 403 while
the repo is private on the free plan).

## Launch flip (after the AIW-231 dogfood gate — one sitting)

1. **NPM_TOKEN**: create an npm automation token (npm account: Aidar), store
   in Infisical as `NPM_TOKEN`, then `gh secret set NPM_TOKEN -R canonweave/canonweave`.
   The npm names `canonweave` + `@canonweave` were free on 2026-07-02 —
   first publish claims them. Collision sweep first: npm, PyPI, crates.io,
   trademark register ("canonweave" GitHub user is a dormant 2025-09 account).
2. Make the repo public: `gh repo edit canonweave/canonweave --visibility public`.
3. Apply the ruleset: `gh api -X POST /repos/canonweave/canonweave/rulesets --input .github/ruleset-protect-main.json`.
4. Enable private vulnerability reporting + secret scanning (Settings →
   Code security). CodeQL + Scorecard start running on the next push.
5. First release: bump versions if needed, update CHANGELOG, then
   `git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0` (annotated; `-s` once a signing key exists) — the release workflow runs
   the suite, packs, publishes `canonweave` with provenance (SLSA statement,
   `npm audit signatures` verifiable), creates the GitHub release with the
   pinned action ref, and moves the `v1` major tag.

## The npm artifact

ONE package `canonweave` (design §2): engine + CLI + templates + docs,
assembled by `scripts/pack-npm.mjs` into `dist-npm/` preserving the
monorepo-relative import layout (zero rewrites, zero dependencies). The
GitHub Action is NOT on npm — consumed via the pinned action ref only.
Verify any time: `node scripts/pack-npm.mjs && node dist-npm/packages/cli/bin/canonweave.mjs selftest`.

## Pinning contract (what we promise consumers)

- Release tags are immutable (tag signing begins once a release signing key is
  provisioned; supply-chain attestation today is npm provenance/SLSA on every
  release); the `v1` major tag moves only across
  backward-compatible releases.
- The recommended consumption form is always the full commit SHA.
- Fingerprint/format changes follow the versioned-contract rules in
  docs/file-format.md — a normalize() change is a MAJOR, never a patch.
