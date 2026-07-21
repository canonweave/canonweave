<!-- managed-by: codex_harness_sync.sh; source: Claude project harness -->
<!-- kimi-harness-bridge:begin generated-by: claude-brain -->
## Kimi harness bridge

Kimi Code and Kimi Work are native Moonshot harnesses, not Codex or an OpenAI
harness. On this repository they must expose the same AI Workforce identity and
operating rules as Claude Code and Codex.

Before substantive research, validation, planning, or implementation in Kimi:

1. Read the repository-root `CLAUDE.md` completely. It is the canonical project
   harness even when the mirrored content later in this `AGENTS.md` is truncated.
2. Read `.agents/kimi_global_instructions.md` from the repository root. It is a
   generated, audited projection of the canonical user-level Claude harness and
   rules. Resolve the repository root from the nearest `.git` directory first.
3. Discover relevant project workflows under `.agents/skills/`; read the full
   `SKILL.md` before using one. Kimi Code loads these automatically. Kimi Work
   must inspect this directory when the task matches a project skill.
4. Translate harness-specific tool names into Kimi's native tools while
   preserving the requested outcome, safety boundary, verification, and project
   ownership. Native implementation details may differ; project meaning may not.
5. Keep Kimi OAuth credentials, device identity, app-generated provider keys,
   sessions, logs, and UI state machine-local. Never add them to the repository.

If either canonical instruction file is missing, report a harness-sync error
instead of inventing project identity or continuing with a partial harness.
<!-- kimi-harness-bridge:end -->


<!-- claude-project-parity:begin -->
## Claude project parity layer

Claude Code is the shared project source of truth. Codex-specific instructions outside this block may specialize runtime behavior; shared safety, routing, and domain rules below remain binding.

Mirrored from:
- `CLAUDE.md`

---

### CLAUDE.md

# AGENTS.md — working on canonweave with an AI agent

Facts an agent needs before touching this repo:

- **Zero runtime dependencies, enforced.** Never add a package dependency,
  never import anything but `node:*` builtins or relative paths under
  `packages/`. `node scripts/check-zero-deps.mjs` must stay green.
- **Run everything with plain `node` — there is no install step.**
  Full suite: `npm test` (= `packages/cli/bin/canonweave.mjs selftest`,
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

<!-- claude-project-parity:end -->
