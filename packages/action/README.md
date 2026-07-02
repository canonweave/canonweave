# @traceweave/action

The Traceweave **gate** as a GitHub Action: build the artifact graph in memory,
fail the check when required coverage is missing, a derivation link went
suspect, or a source cannot resolve — with the evidence surfaced where
reviewers look.

## Surfaces per run

| surface | mechanism | works on fork PRs |
|---|---|---|
| Inline annotations on the suspect artifact file (exact `reconciled:` entry line) | workflow commands -> the job's check run | yes |
| Job summary (full report) | `GITHUB_STEP_SUMMARY` | yes |
| ONE sticky PR comment, updated in place (marker `<!-- traceweave-gate -->`) | REST via `GITHUB_TOKEN` | no — skipped gracefully |
| Outputs `result` / `exit-code` / `suspects` / `gaps` / `profile` | `GITHUB_OUTPUT` | yes |

Exit codes mirror the CLI contract: `0` pass · `1` gate fail · `2` config
error · `3` unresolved source (precedence 2 > 3 > 1). Gate mode needs **no
secrets**; the default `GITHUB_TOKEN` is used only for the comment.

## Usage

Same-repo (dogfood) form:

```yaml
- uses: actions/checkout@v4
- uses: ./packages/action
  with:
    profile: ready-to-build   # optional; defaults to traceweave.yml `gate`
```

Cross-repo form (after the WS5 publish):

```yaml
- uses: traceweavehq/traceweave/packages/action@<pinned-sha>   # pin by SHA, not tag
```

Full consumer workflow (triggers, concurrency, permissions, merge-queue):
[templates/github/traceweave-gate.yml](../../templates/github/traceweave-gate.yml).
Branch-protection / ruleset recipe: [docs/gate-recipes.md](../../docs/gate-recipes.md).

## Verify locally

```bash
node packages/action/selftest.mjs
```

Hermetic: fakes the GitHub environment (event payload, summary/output files,
API server on loopback) and drives clean-pass, suspect-fail, sticky-update,
fork-degradation, and config-error scenarios against `examples/demo-repo`.
