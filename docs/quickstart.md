# Quickstart

Traceweave keeps the thread between what was decided and what was built:
every artifact (brief, requirements, architecture, test plan …) is a Markdown
file that **declares what it derives from**. When an upstream file changes,
every stale dependent is flagged until a human reconciles it — and a CI gate
blocks the merge until the graph is clean.

Runs on Node >= 20. **Zero runtime dependencies** — nothing to `npm install`.

Total time for this page: about ten minutes.

## 0. Get traceweave (one minute)

Until the npm publish lands (WS5), traceweave runs straight from a checkout —
there is deliberately no install step:

```bash
git clone https://github.com/traceweavehq/traceweave ~/traceweave   # or use an existing checkout
traceweave() { node ~/traceweave/packages/cli/bin/traceweave.mjs "$@"; }
traceweave selftest   # optional: proves your checkout works (~5s, no network)
```

The shell function is what the rest of this page (and the CLI's own output)
assumes — unlike an `alias`, it also works in scripts and non-interactive
shells. Put it in your shell profile to keep it.

## 1. Initialize (one minute)

```bash
traceweave init --template generic-software --dir my-product
cd my-product
```

You get:

```
traceweave.yml            # repo config: roots, ontology, graph, default gate
docs/trace/ontology.yml   # artifact types + legal derivation edges + gate profiles
docs/trace/*.md           # five seed artifacts, derivation edges already wired
docs/trace/graph.json     # the built graph (committed on purpose)
```

The seed skeleton starts green: `init` auto-reconciles every ingredient link.

## 2. Look around

```bash
traceweave check   # human report: suspects, coverage gaps, per-profile verdicts
traceweave gate    # exit 0 — the ready-to-build profile passes
```

(`traceweave` here = `node <repo>/packages/cli/bin/traceweave.mjs`; alias it.)

## 3. Break the thread, watch it get caught

Edit `docs/trace/product-brief.md` — change the outcome promise. Then:

```bash
traceweave check
# SUSPECT INGREDIENT LINKS:
#   - requirements <- product-brief        (old fingerprint -> new fingerprint)
traceweave gate; echo $?   # 1 — the gate is red until you reconcile
```

## 4. Reconcile (the ripple is the point)

```bash
traceweave reconcile requirements          # drafts a corrected artifact -> .traceweave/proposals/
# review the proposal, then:
traceweave reconcile requirements --apply  # applies the draft, clears the suspect link
traceweave check                           # requirements is fresh — but now ITS dependents went suspect
```

Applying a reconcile rewrites `requirements`, so its own fingerprint changed —
and the artifacts derived from it (`acceptance-criteria`,
`architecture-overview`, then `test-plan`) are flagged stale in turn. That
cascade is not a bug; it is the product: an upstream change ripples down the
derivation graph one reviewed hop at a time, and nothing goes silently stale.

Repeat `traceweave reconcile <id> --apply` for whatever `check` lists as
suspect (top-down), then:

```bash
traceweave gate; echo $?                   # 0 — green again, the whole chain re-reviewed
```

If the upstream change does not actually invalidate a downstream (no rewrite
needed), mark the link reviewed instead: `traceweave clear <id> <ingredient>`.
Clearing only updates the link's fingerprint, never the artifact body — so
nothing cascades.

The default drafter backend is `template` (deterministic stub, no network).
Point `drafter.backend: cmd` at any local CLI, or wait for the `anthropic` /
`openai` backends (WS3). Every AI draft lands as a reviewable proposal —
nothing is ever auto-applied without a human step.

## 5. Gate your CI (three minutes)

Copy the ready workflow into your repo:

```bash
cp ~/traceweave/templates/github/traceweave-gate.yml .github/workflows/
```

It runs the gate action on every PR, push to the default branch, and merge
queue — inline annotations on the exact suspect line, one sticky PR comment
updated in place, a job summary, least-privilege permissions, and **no
secrets** (the default `GITHUB_TOKEN` is only used for the comment; fork PRs
degrade to annotations + summary automatically).

Until the WS5 publish, the `uses:` line points at the action inside your
traceweave checkout — vendor the repo (or a submodule) and use
`uses: ./<path-to>/packages/action`; the published `traceweavehq/traceweave` form is
noted in the template for later. Any non-GitHub CI can gate with the CLI
directly:

```yaml
- run: node <traceweave>/packages/cli/bin/traceweave.mjs gate
```

Then make the check a merge blocker (two clicks in a ruleset):
[gate-recipes.md](gate-recipes.md).

Exit codes: `0` pass · `1` gate fail (suspects/gaps) · `2` config error ·
`3` unresolvable source. Full contract: [file-format.md](file-format.md).

## Verbs

| verb | what it does |
|---|---|
| `init [--template <name>] [--dir <path>]` | scaffold from a template, auto-reconcile, first build |
| `build` | resolve + fingerprint + validate + write `graph.json` |
| `check` | human report (exit 0 unless the repo is misconfigured) |
| `gate [--profile <name>]` | verdict for one gate profile |
| `fingerprint <id>` | resolve one artifact, print its fingerprint |
| `clear <id> <ingredient>` | mark one link reviewed at the current fingerprint |
| `reconcile <id> [--apply]` | draft / apply the corrected downstream artifact |
| `selftest` | hermetic self-test (no network) |
| `sync-issues`, `serve` | ship in WS4 / WS6 |
