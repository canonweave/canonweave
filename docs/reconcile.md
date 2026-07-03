# The reconcile loop (WS3 — the AI plane)

When an upstream artifact changes, its dependents go **suspect** and the gate
blocks. The reconcile loop is the other half of the product: it drafts the
corrected downstream content and opens a PR whose **merge IS the review** —
the commit updates the artifact body AND its `reconciled` fingerprints, so
the suspect clears and the next gate run goes green.

Runs on **your** CI with **your** model key (a repo secret). Never our
infrastructure, never our key. No key configured? Runs degrade to reconcile
briefs in the job summary — nothing breaks.

## Drafter backends

Configured in `canonweave.yml` under `drafter:`.

| backend | mechanism | key | notes |
|---|---|---|---|
| `anthropic` | direct Messages API (zero-dep `fetch`) | env `ANTHROPIC_API_KEY`* | `model` default `claude-sonnet-5` |
| `openai` | OpenAI-compatible `{base_url}/chat/completions` | env `OPENAI_API_KEY`* | `model` REQUIRED; `base_url` covers self-hosted endpoints |
| `cmd` | run a configured CLI, prompt as final arg, draft from stdout | — | local agents (claude/codex/any CLI) |
| `template` | deterministic stub, no network | — | the hermetic selftest backend |
| `none` | never draft — always emit a reconcile **brief** | — | teams that want human-only redrafts |

\* the env var NAME is configurable via `api_key_env` (uppercase env-name
shape enforced). The key value never appears in config, output, briefs,
proposals, or errors — errors name only the variable.

```yaml
drafter:
  backend: anthropic
  model: claude-sonnet-5     # optional (this is the default)
  # api_key_env: MY_KEY_VAR  # optional; default ANTHROPIC_API_KEY
  # max_tokens: 8192         # optional cap on the draft
  # base_url: https://api.anthropic.com   # optional (proxies/compatible endpoints)
```

## The reconcile PR (idempotent by construction)

One PR per suspect **downstream**, branch:

```
canonweave/reconcile/<downstream-id>--<fp8>
```

`fp8` = first 8 hex of the NEW primary-upstream fingerprint. The branch name
is the idempotency key:

- **Re-run with the same state** → force-push the same branch, PATCH the same
  PR. Never a duplicate.
- **Upstream moves again** (new fp8) → a successor PR opens; the stale PR gets
  a linking comment, is closed, and its branch is deleted.
- **Multiple changed ingredients** on one downstream → one PR; the primary
  upstream names the branch, and ALL suspect links clear on merge.

The PR body carries: the changed upstream (old → new fingerprint), the build
rule applied, the drafter backend + model, and the full proposal. The commit
touches the artifact file, its `reconciled` map, and `graph.json` — merging
needs no follow-up build.

Labels: `canonweave:reconcile` (best-effort). Use CODEOWNERS on your artifact
roots to route the review to the artifact owner automatically.

## Workflow setup

```bash
cp <canonweave>/templates/github/canonweave-reconcile.yml .github/workflows/
```

Triggers: push to the default branch (the run no-ops when the graph is
clean), `workflow_dispatch`, optional schedule. Needs `contents: write` +
`pull-requests: write` and, for AI drafts, your model-key repo secret.

**One-time repo setting** (GitHub disables it by default): Settings →
Actions → General → Workflow permissions → check **"Allow GitHub Actions to
create and approve pull requests."** Without it the branch pushes but the
PR POST returns 403 (the action tells you exactly this).

The gate workflow (`canonweave-gate.yml`) stays the merge blocker; the
reconcile workflow is the fixer. They compose: push breaks a link → gate
blocks PRs → reconcile PR appears → review + merge → gate green.

**Deep chains converge in waves.** A reconcile run drafts only the DIRECTLY
suspect downstreams. Merging a reconcile PR rewrites that artifact, so its
own dependents go suspect next — and the merge (a push to the default
branch) triggers the next reconcile wave automatically. A chain
`brief → requirements → acceptance-criteria → test-plan` re-reviews itself
in successive waves, one reviewed hop at a time, until the gate greens.
That cascade is not a bug; it is the product — nothing goes silently stale,
and every hop gets a human merge.

## Threat model (layered injection defense)

A hostile artifact edit can try to steer the drafter. The layers (design §7):

1. **Single completion, no tools** — the drafter call has no tool access, no
   agentic loop, no filesystem; it can only return text.
2. **Pinned instruction** — the prompt pins "output only the corrected
   artifact body"; upstream content is fenced between explicit markers.
3. **Input size caps** — every content block is capped (32k chars) with an
   explicit truncation marker; a hostile artifact cannot stuff the context.
4. **Fence/preamble stripping** — chatty wrappers and code fences are
   stripped; an empty result falls back to a brief.
5. **Human PR gate** — nothing merges itself. The worst case of a malicious
   edit is a bad *proposal* a human must approve: the same blast radius as
   any malicious PR.

Exit codes mirror the CLI contract: `0` ok/clean · `1` some downstream failed
· `2` config/env error · `3` unresolvable source.
