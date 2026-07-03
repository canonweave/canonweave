# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow semver; the frontmatter schema (`canonweave: 1`), ontology version,
fingerprint normalization, exit codes, and `TW_*` error codes are versioned
contracts — changing their meaning is a MAJOR (docs/file-format.md).

## [Unreleased]

### Added
- WS3 — the AI reconcile loop: zero-dep `anthropic` (Messages API) and
  `openai` (OpenAI-compatible `base_url`) drafter backends with layered
  injection defense (single completion, no tools, input caps, fence
  stripping, key-from-env-only); the reconcile GitHub Action
  (`packages/reconcile-action`) with idempotent PR mechanics — branch
  `canonweave/reconcile/<id>--<fp8>`, re-runs update in place, upstream moves
  close the stale PR and open a linked successor, merging IS the review;
  consumer workflow template + docs/reconcile.md. Hermetic selftests: engine
  suite grows 75 -> 83 (loopback API backends), reconcile-action suite adds
  22 checks (stateful fake PR store + bare git remote).

### Changed
- `draft()` in the engine is now async (API backends); `TW_CONFIG_DRAFTER_WS3`
  is retired — `anthropic`/`openai` are accepted, `openai` without `model`
  fails with the new `TW_CONFIG_DRAFTER_MODEL`.
- WS1 — zero-dependency core engine (config, frontmatter schema v1, ontology
  with named gate profiles, inline/repo/url resolvers + plugin seam,
  CRLF-normalized fingerprints, deterministic graph, reconcile draft/apply)
  and the `canonweave` CLI (init/build/check/gate/fingerprint/clear/
  reconcile/selftest). Hermetic selftest (75 checks), determinism snapshot,
  zero-deps enforcement, 3-OS × Node 20/22/24 CI matrix.
- WS2 — the gate GitHub Action: inline annotations on suspect artifact lines,
  one sticky PR comment updated in place, job summary, fork-safe degradation,
  merge-queue support; hermetic GitHub-environment selftest (22 checks);
  consumer workflow template + branch-protection recipe; ten-minute quickstart.
- WS5 — Apache-2.0; SECURITY.md; CONTRIBUTING.md; AGENTS.md; SHA-pinned CI;
  CodeQL + OpenSSF Scorecard (activate at public flip); provenance release
  pipeline (`release.yml` + `scripts/pack-npm.mjs`).

### Fixed
- Windows: annotation `file=` paths now use POSIX separators; repo-wide LF
  checkouts via `.gitattributes` keep the committed `graph.json` byte-stable.
