# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow semver; the frontmatter schema (`canonweave: 1`), ontology version,
fingerprint normalization, exit codes, and `TW_*` error codes are versioned
contracts — changing their meaning is a MAJOR (docs/file-format.md).

## [Unreleased]

## [0.3.0] — 2026-07-04

### Added
- `serve` (WS6, design §9 — the dashboard): local read-only dashboard over the
  last built state (`graph.json` + artifact files) at `http://127.0.0.1:8791`
  (`--port`, `--port 0` for an OS-assigned port). Overview with per-profile
  gate verdicts, tier-column graph view with derivation edges, suspects, gaps,
  artifact browser with file content, and the byte-exact `canonweave check`
  report. GET-only by construction (anything else is 405), loopback-bound with
  a foreign-Host guard, content-based stale-build banner. Docs: `docs/serve.md`.

## [0.2.0] — 2026-07-03

### Added
- `sync-issues` (WS4, design §8 — the work plane): project the graph into
  GitHub Issues (one issue per artifact; native issue type best-effort with a
  `canonweave:type:*` label fallback; tier/status labels; state-table body),
  sub-issue relations for derivation edges (deterministic single-parent rule),
  and a Projects v2 board with a `canonweave-status` field. Strictly one-way
  (files are the record), idempotent (zero writes on an unchanged graph),
  self-healing (deleted issues are re-created; the `provenance.issue`
  frontmatter anchor re-binds). Consumer workflow:
  `templates/github/canonweave-sync-issues.yml`; docs: `docs/sync-issues.md`.

## [0.1.0] — 2026-07-03

First public release, as **canonweave** (renamed from the working name
"traceweave" pre-launch — the old name was crowded on PyPI/GitHub and had no
clean domain; no released artifact ever shipped under it).

- Engine: artifact graph, body-only fingerprints, suspect propagation,
  gate profiles (zero-dependency, deterministic; Node 20+)
- CLI `canonweave`: init/build/check/reconcile/clear + hermetic selftest (83 checks)
- GitHub gate Action: inline annotations, one sticky PR comment, job summary,
  fork/no-token degradation, merge-queue-safe (22-check selftest)
- Reconcile Action (the AI plane): one idempotent fix PR per suspect artifact,
  merge-as-review, wave convergence; drafter backends: template | cmd | none |
  anthropic | openai-compatible (proven live with GLM 5.2) (28-check selftest)
- Templates: generic-software, product-lifecycle; consumer workflows
  canonweave-gate.yml + canonweave-reconcile.yml
- Release: single npm package `canonweave` with SLSA provenance

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
