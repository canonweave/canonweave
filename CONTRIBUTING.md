# Contributing

## Ground rules

- **Zero runtime dependencies is load-bearing.** PRs adding a dependency to
  `packages/*` are declined; `node:` builtins and relative imports only
  (CI enforces this).
- **Determinism is a contract.** Same inputs must produce a byte-identical
  `graph.json` — no clocks, no randomness, no map-iteration ambiguity. The
  determinism snapshot in CI is non-negotiable.
- **Format changes are versioned.** Frontmatter schema (`traceweave: 1`),
  ontology version, fingerprint normalization, and the `TW_*` error codes are
  public contracts (see [docs/file-format.md](docs/file-format.md)); changing
  their meaning is a major version.

## Working on the repo

```bash
git clone https://github.com/traceweavehq/traceweave
cd traceweave
npm test        # CLI selftest + action selftest + determinism + zero-deps — no install step
```

There is deliberately **no `npm install`** — if your change needs one, the
change is wrong for this repo.

- Engine code: `packages/engine/src` · CLI: `packages/cli` · Action: `packages/action`
- Add or extend selftest checks with any behavior change; hermetic only
  (loopback network at most).
- Docs are fixtures: if you change behavior the quickstart or file-format doc
  describes, update the doc in the same PR.

## Pull requests

All changes land via PR against the default branch — no direct pushes. CI
(3 OS × Node 20/22/24 matrix + the dogfood gate on `examples/demo-repo`) must
be green. Keep PRs single-purpose; reference the issue they close.
