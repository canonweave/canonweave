# AGENTS.md — working on traceweave with an AI agent

Facts an agent needs before touching this repo:

- **Zero runtime dependencies, enforced.** Never add a package dependency,
  never import anything but `node:*` builtins or relative paths under
  `packages/`. `node scripts/check-zero-deps.mjs` must stay green.
- **Run everything with plain `node` — there is no install step.**
  Full suite: `npm test` (= `packages/cli/bin/traceweave.mjs selftest`,
  `packages/action/selftest.mjs`, `scripts/determinism.mjs`,
  `scripts/check-zero-deps.mjs`). All hermetic; network is loopback-only.
- **Determinism invariant:** building twice, or from a CRLF checkout, must
  produce a byte-identical `graph.json`. No `Date.now()`, no `Math.random()`,
  sort every collection you emit. The only permitted timestamp is inside
  reconcile proposal files, never in the graph.
- **Versioned contracts** (breaking = major): frontmatter schema v1
  (`packages/engine/src/recipe.mjs`), ontology v1 (`ontology.mjs`),
  fingerprint normalize v1 = CRLF→LF only (`fingerprint.mjs`), exit codes
  0/1/2/3 with precedence 2>3>1 (`errors.mjs`), `TW_*` error codes
  (documented exhaustively in `docs/file-format.md` — keep the table exact),
  graph shape v1 (`graph.mjs`).
- **The engine's own YAML-subset parser** (`yaml.mjs`) is the only YAML reader.
  Anything you serialize (see `recipe.mjs`) must round-trip through it —
  add a selftest round-trip check for any new emitted shape.
- **Layout:** engine = `packages/engine/src` (pure library) · CLI =
  `packages/cli` (verb router + init + selftest) · action = `packages/action`
  (GitHub surfaces; hermetic selftest fakes the GitHub env incl. a loopback
  REST API) · templates = `templates/` · living fixture = `examples/demo-repo`
  (its committed `graph.json` is drift-checked by `scripts/determinism.mjs` —
  regenerate deliberately, per its README, never let it drift silently).
- **Internal/private adapters do not belong here.** Feishu resolvers and
  heuristic provenance live in a private downstream package; the OSS core
  ships `inline`/`repo`/`url` + the plugin seam only.
- Docs are contracts: behavior changes update `docs/` in the same change.
