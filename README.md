# Canonweave

**GitHub-native artifact traceability.** Every product artifact — brief,
requirements, acceptance criteria, architecture, test plan — is a Markdown
file that declares what it derives from. Canonweave builds the derivation
graph, fingerprints every link, flags stale dependents the moment an upstream
changes, and gates CI until a human reconciles the thread.

- **Files are the system of record** — versioned, diffable, greppable; no
  hosted service, no database, no telemetry. State is your git history.
- **Deterministic** — same inputs, byte-identical `graph.json`; CRLF-safe on
  Windows checkouts; proven by a determinism snapshot in CI.
- **Zero runtime dependencies** — Node builtins only, enforced in CI. The
  dependency tree IS the audit.
- **Human gate on all AI output** — the reconcile drafter only ever produces a
  proposal for review; nothing is auto-applied.

## Try it

```bash
node packages/cli/bin/canonweave.mjs init --template generic-software --dir /tmp/demo
cd /tmp/demo && node <this-repo>/packages/cli/bin/canonweave.mjs check
```

Full walkthrough: [docs/quickstart.md](docs/quickstart.md)

## Layout

| path | what |
|---|---|
| `packages/engine` | zero-dep core: config, schema, ontology, resolvers, fingerprints, graph, gates, reconcile |
| `packages/cli` | the `canonweave` binary: init/build/check/gate/fingerprint/clear/reconcile/sync-issues/selftest |
| `packages/reconcile-action` | the reconcile GitHub Action: idempotent AI fix PRs for suspect links (docs/reconcile.md) |
| `packages/action` | the gate as a GitHub Action: inline annotations, sticky PR comment, job summary, fork-safe ([usage](packages/action/README.md)) |
| `templates/` | `generic-software`, `product-lifecycle` ontology templates |
| `examples/demo-repo` | living fixture: docs demo + CI drift check |
| `docs/` | [quickstart](docs/quickstart.md) · [file formats](docs/file-format.md) · [gate profiles](docs/gate-profiles.md) · [reconcile loop](docs/reconcile.md) · [issues/board projection](docs/sync-issues.md) · [security](docs/security.md) |

## Verify a checkout

```bash
npm test   # = CLI selftest + action selftest + determinism snapshot + zero-deps, no install step
```

Status: WS1 (core extraction) and WS2 (Action + demo + quickstart) complete —
engine, CLI, templates, gate action with hermetic GitHub-environment selftest,
consumer workflow template, branch-protection recipe, CI matrix
(ubuntu/windows/macos × Node 20/22/24). WS5 (release
engineering) complete: Apache-2.0, SHA-pinned CI, CodeQL + Scorecard
(activate at the public flip), tag-triggered provenance release pipeline
([docs/releasing.md](docs/releasing.md)). The repo stays private until the
dogfood gate (AIW-231) passes — the launch flip is a one-sitting checklist
in the runbook.
