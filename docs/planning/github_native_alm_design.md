# Production Design: GitHub-Native ALM — Traceweave (name approved 2026-07-02)

> **Renamed 2026-07-03:** the product shipped publicly as **canonweave** (npm `canonweave`, github.com/canonweave/canonweave). Older mentions of "traceweave" in this document refer to the same product under its working name.


Status: DESIGN v1 (production target) · Created 2026-07-02 · Owner: Arnold (runtime steward) + Sam (product owner)
Upstream: concept brief `github_native_alm_concept.md` (positioning, market, PR-FAQ — not repeated here)
Engine baseline: `harness/trace/` — 1,916 lines, zero-dependency Node ESM (engine 753 + libs 1,117 + server 46)
Companion market evidence: `../../workforce/knowledge_domains/wiki/synthesis/github_native_alm_landscape_2026_07_01.md`

This document is the engineering design of the whole product at production level: architecture,
data model, contracts, flows, security, testing, operations, and the migration from the running
prototype. The concept brief owns "why and for whom"; this owns "what exactly and how".

---

## 1. Design goals and invariants

These are load-bearing; every section below must hold them.

1. **Zero-infrastructure v1.** Everything runs inside the user's repository and GitHub's compute
   (Actions). No hosted service, no database, no telemetry. State is files in git. This is both
   the open-source adoption wedge and the production-simplicity wedge: nothing to operate, nothing
   to trust us with.
2. **Files are the system of record.** Artifact content and derivation edges live as versioned,
   diffable, fingerprintable Markdown files. Issues/Projects are *projections* (views) of that
   record, never authoritative. Actions is the enforcement layer. (This is the concept brief's
   three-surface model made normative.)
3. **Determinism.** Same inputs produce a byte-identical `graph.json`. No clocks, no randomness in
   the graph (prototype already does this — `generatedAt: null`). Production adds newline
   normalization (CRLF→LF before hashing) so Windows checkouts fingerprint identically.
4. **Zero runtime dependencies.** The engine stays Node-builtins-only (`node:crypto`, `node:fs`,
   `node:path`, `node:child_process`). This is a security posture (supply chain) and an
   install-friction posture, not an aesthetic.
5. **Human gate on all AI output.** The drafter's output only ever lands as a pull request for
   review. Nothing AI-written is auto-applied. This is simultaneously the safety story, the
   quality story, and the prompt-injection defense of last resort.
6. **Artifact content is untrusted input.** Anyone who can edit a Markdown file can try to steer
   the LLM drafter. The drafter therefore runs with no tools, a pinned instruction, capped input
   sizes, and its output goes through the human PR gate (invariant 5).

## 2. Product surfaces (what ships)

| Surface | Form | Phase |
|---|---|---|
| `traceweave` | npm package: engine + CLI (`init`, `build`, `check`, `gate`, `fingerprint`, `clear`, `reconcile`, `sync-issues`, `serve`, `selftest`) | P0 |
| `traceweave-action` | GitHub Action (JS action wrapping the CLI): PR check, annotations, sticky comment, job summary | P0 |
| Reconcile workflow template | `traceweave.yml` workflow users copy in: drift detection → AI-drafted fix PR | P1 |
| `sync-issues` projection | CLI verb + workflow: artifacts → Issues/sub-issues/Projects v2 board | P1 |
| `traceweave serve` | Local read-only dashboard (productized from the current `:8791` app) | P1 |
| Ontology templates | `generic-software`, `product-lifecycle`, `iso26262-lite` | P0 (first), P2 (rest) |
| GitHub App | Hosted webhooks, org dashboard, Marketplace listing | P2 (additive, never required) |

## 3. Repository and package architecture

One public monorepo (org + name pending Aidar's decision; Apache-2.0 recommended):

```
traceweave/
  packages/engine/        # zero-dep core: ontology, recipe, resolve, fingerprint, graph, report, reconcile
  packages/cli/           # the traceweave binary (arg parsing, config load, verb router)
  packages/action/        # GitHub Action: thin wrapper — checkout is the user's, engine does the work
  templates/              # ontology templates + starter artifact sets (init copies these)
  examples/demo-repo/     # living fixture: a small product with a full artifact graph (also the docs demo)
  docs/                   # quickstart, file-format spec, gate recipes, security notes
```

Internal-only adapters (Feishu doc/whiteboard resolvers, the Paperclip/OKR heuristic provenance
matcher) move OUT of the open-source core into a private adapter package consumed by our fork.
The OSS core stays clean and generic; we remain a downstream consumer of our own product.

## 4. Data model (normative)

### 4.1 Artifact file

Markdown + YAML frontmatter, under configured roots. Schema v1 (published as JSON Schema in docs;
`traceweave: 1` is the version key):

```yaml
---
traceweave: 1
id: acceptance-criteria          # stable identity — NOT the filename (renames are safe)
type: acceptance-criteria        # must exist in the ontology
title: Acceptance Criteria (Given/When/Then)
source:
  kind: inline                   # inline | repo | url | github-issue | <plugin>
recipe:
  ingredients: [customer-journey-map, pr-faq]
  build: "One Given/When/Then per must-have capability."
reconciled:
  customer-journey-map: "sha256:…"   # fingerprint of the ingredient when last reviewed
  pr-faq: "sha256:…"
owner: sam                       # free-form; maps to CODEOWNERS in practice
status: present                  # present | placeholder
provenance:
  issue: 123                     # explicit GitHub issue binding (projection anchor), optional
---
(body — for kind: inline, the body IS the fingerprinted content)
```

### 4.2 Ontology (`ontology.yml`)

User-editable, validated at build. Declares: types, tiers, legal ingredient edges (which types may
derive from which), and named **gate profiles** — the generalization of the prototype's single
Gate-A: each profile lists required types and the pass rule (all required present + resolved, zero
suspects, zero gaps). Ships as templates; `traceweave init --template generic-software` copies one in.

### 4.3 Repo config (`traceweave.yml` at repo root)

```yaml
roots: [docs/trace]              # where artifact files live (multi-root for monorepos)
ontology: docs/trace/ontology.yml
graph: docs/trace/graph.json     # committed by default (diff-reviewable state)
gate: ready-to-build             # default gate profile
drafter:
  backend: anthropic             # anthropic | openai | cmd | template | none
  model: claude-sonnet-latest    # configurable; key from env/secret, never in config
sync:
  issues: false                  # P1 projection, opt-in
resolvers: []                    # optional plugin resolver modules
```

### 4.4 Graph (`graph.json`)

Generated, deterministic, committed by default (so PR diffs show trace-state changes and cold CI
runs need no rebuild of remote content). Shape: nodes (id, type, tier, status, fingerprint,
resolver, provenance), edges (from recipe.ingredients), suspects (edge + old/new fingerprint),
gaps (missing required coverage), per-profile gate verdicts. No timestamps. Documented rule:
never hand-edit; regenerate on conflict.

### 4.5 Fingerprint spec

`"sha256:" + sha256hex(normalize(content))`, where normalize = CRLF→LF. The normalization
function is part of the versioned format contract: changing it is a major version (it flips
every fingerprint in the wild).

## 5. Resolver plane (content sources)

The prototype's contract is kept verbatim — `resolve(node, ctx) → { content, resolver, unresolved,
error }` — it is already a clean plugin seam (`engine/lib/resolve.mjs:31`).

| Resolver | Behavior | Phase |
|---|---|---|
| `inline` | body is the content (default, recommended) | P0 (exists) |
| `repo` | read `source.path` relative to repo root | P0 (exists) |
| `url` | HTTP GET, cache to `.traceweave/cache/<id>.content`, cache fallback offline | P0 |
| `github-issue` | issue body as content — supported for teams that draft in issues, documented as discouraged (mutable, weak for fingerprinting) | P1 |
| plugin | user module path in `traceweave.yml` `resolvers:` | P1 |
| `feishu_doc` / `feishu_whiteboard` | move to private internal adapter (our dogfood) | — |

Cache files are committed by default: remote-sourced builds stay deterministic and offline-safe in
CI (this generalizes the prototype's existing `.cache/<id>.content` + fallback behavior).

## 6. Enforcement plane: the GitHub Action

**Triggers:** `pull_request`, `push` (default branch), `merge_group` (merge-queue support),
`workflow_dispatch`, optional `schedule` (nightly drift audit).

**Behavior per run:** engine `build` + `gate` → then:
- **Check run** with the human report as summary (suspect links with old/new fingerprints, coverage
  gaps, per-profile verdict).
- **Inline annotations** on changed artifact files whose links went suspect.
- **Sticky PR comment** (single comment, updated in place — never a new comment per push).
- **Job summary** with the same report (fork-safe surface).

**Exit-code contract (CLI, mapped by the Action):**

| code | meaning | Action result |
|---|---|---|
| 0 | gate pass | success |
| 1 | gate fail: suspects and/or gaps | failure with report |
| 2 | config/ontology error (illegal edge, bad frontmatter, unknown type) | failure with setup guidance |
| 3 | resolve error without cache | failure naming the unresolved node |

**Permissions (least privilege):** `contents: read`, `checks: write`, `pull-requests: write`.
Gate mode needs **no secrets**. Fork PRs degrade gracefully: no comment/check permissions → job
summary only, still pass/fail. Merge blocking is the user's branch protection / repo ruleset
requiring the check — documented recipe, not something we control.

**Concurrency:** `concurrency: traceweave-${{ github.ref }}`, cancel-in-progress for PR runs.

**Performance budget:** 10,000 artifacts under 30 seconds excluding remote resolves (current
engine is trivially fast at 21 nodes; the budget forces streaming/no-quadratic discipline as it
grows). Remote resolves always cache-first in CI.

## 7. AI plane: the reconcile loop

**Where it runs:** the user's own CI (Actions) with the user's own model key (repo secret). Never
our infrastructure, never our key. v1 needs no hosted component.

**Trigger:** push to default branch that creates suspects (the gate run detects and dispatches),
manual `workflow_dispatch`, or schedule.

**Drafter backends** (generalizing `engine/lib/drafter.mjs` — the `agent|template` registry
becomes):

| backend | mechanism | notes |
|---|---|---|
| `anthropic` | direct Messages API call (Node https, zero-dep) | default; model configurable |
| `openai` | OpenAI-compatible endpoint (`base_url` + key) | covers local/self-hosted models |
| `cmd` | run a configured CLI, read stdout | the current mimo/claude path, generalized |
| `template` | deterministic stub, no network | selftest backend (kept) |
| `none` | emit a reconcile **brief** instead of a draft | teams that want human-only redraft |

The existing prompt assembly, fence-stripping, and brief fallback carry over unchanged.

**Output — the reconcile PR:**
- Branch `traceweave/reconcile/<downstream-id>--<fp8>` (fp8 = first 8 hex of the NEW upstream
  fingerprint). Deterministic name = **idempotency key**: a re-run updates the existing open PR,
  never duplicates it. A further upstream change produces a new fp8 → the bot closes the stale PR
  and opens the successor, linking them.
- PR body: which upstream changed (old→new fingerprint), the build rule applied, drafter backend
  and model, and the proposal. The commit updates the artifact body AND its `reconciled` entry, so
  **merging the PR is the review** — the suspect link clears and the next gate run goes green.
- Labels (`traceweave:reconcile`) + CODEOWNERS naturally routes review to the artifact owner.

**Injection defense (layered):** single completion, no tool access, pinned instruction ("output
only the corrected artifact body"), input size caps, fence/preamble stripping, and the human PR
gate. Documented threat model: a malicious artifact edit can at worst produce a bad *proposal*
that a human must approve — same blast radius as any malicious PR.

## 8. Work plane: Issues/Projects projection (P1)

`traceweave sync-issues` (CLI verb + workflow) projects the graph into GitHub's native surfaces:

- One issue per artifact (create/update): title, artifact type as **issue type**
  (GA since 2025-04), tier + status as labels, body links to the file and shows current state.
- Derivation edges mirrored as **sub-issue** relations.
- A **Projects v2** board (GraphQL) with a status field: `fresh | suspect | gap | placeholder`.

**Direction is strictly one-way: files → GitHub.** Issue edits never mutate files; issue deletion
never deletes artifacts; the next sync converges the projection back to the record. The binding
anchor is `provenance.issue` in frontmatter (explicit, deterministic). The prototype's
keyword-heuristic matcher (`provenance.mjs`) does NOT ship in the OSS core — heuristics stay in
our private adapter; the product uses explicit bindings only.

**Rate limits:** batched GraphQL mutations, conditional requests, exponential backoff; sync is
idempotent and resumable (converges on re-run).

## 9. Dashboard: `traceweave serve` (P1)

The current `app/server.mjs` + `public/app.html` (the `:8791` prototype) productized as a CLI verb:
read-only in v1 — graph view, suspects, gaps, gate state, artifact browser reading `graph.json` +
files locally. No auth (localhost tool). Our internal deployment (behind SSO, per the existing
deploy spec) continues as the dogfood instance of the same code.

## 10. Security and supply chain

- **Zero runtime deps** (invariant 4) — the dependency tree IS the audit.
- **Releases:** SHA-pinned Action usage documented (`uses: …@<sha>`), semver major tags, npm
  provenance + SLSA attestation on publish, signed tags.
- **Repo posture:** OpenSSF Scorecard in CI, SECURITY.md with disclosure policy, CodeQL, branch
  protection on the product repo itself (dogfooding our own gate on our own specs).
- **Secrets:** only the reconcile workflow ever sees a key; gate mode runs secretless. Keys are
  repo/org secrets in the user's GitHub — we never proxy them.
- **License:** Apache-2.0 recommended (explicit patent grant; the suspect-links mechanism has
  2011-era patent history in the incumbent space) — final call is Aidar's open decision.

## 11. Testing and release engineering

- **Hermetic selftest** (template drafter, fixed fixtures) stays the fast inner gate — it already
  proves ontology validation, suspect detection, gap detection, and the reconcile draft→apply loop
  offline.
- **Determinism snapshot:** build twice, byte-compare `graph.json`; run on ubuntu + windows +
  macos runners (the CRLF normalization proof), Node 20/22/24 matrix.
- **Integration:** `examples/demo-repo` is a real artifact set exercised in CI — open a synthetic
  PR that changes an upstream, assert the check fails with the right suspect; merge a reconcile
  PR, assert the gate greens. (`act` for local runs, real Actions in CI.)
- **Docs as fixtures:** the quickstart IS the demo repo; docs drift breaks CI.
- **Versioning:** engine npm semver; action major tag (`v1`) + pinned-SHA guidance; CHANGELOG;
  file-format changes gated by the `traceweave: 1` version key with documented migrations.

## 12. Failure modes and recovery

| Failure | Behavior |
|---|---|
| Remote source down, cache present | resolve from cache, report `resolver: *:cache` (exists today) |
| Remote source down, no cache | node `unresolved` → gate fail (exit 3) naming the node |
| Drafter unreachable / no key | brief-mode: PR carries a concrete reconcile brief instead of a draft (exists today, generalized) |
| Two reconcile runs race | deterministic branch key → second run updates the same PR |
| Upstream changes again mid-review | new fp8 → stale PR closed with pointer to successor |
| `graph.json` merge conflict | regenerate (deterministic); documented: never hand-resolve |
| Malicious artifact edit steering the LLM | bad *proposal* at worst; human PR gate is the backstop (§7) |
| Action on fork PR (no perms) | job-summary-only degradation, still pass/fail |

## 13. Migration map: prototype → product

| Prototype file | Production change |
|---|---|
| `engine/lib/resolve.mjs` | + `url`, `github-issue`, plugin loading; Feishu resolvers → private adapter |
| `engine/lib/drafter.mjs` | + `anthropic`/`openai` direct-API backends (zero-dep https); current CLI path becomes `cmd`; `template` kept for selftest |
| `engine/trace.mjs` | config-file loading (`traceweave.yml`), multi-root, exit-code taxonomy (§6), + `sync-issues`, `serve`, `init` verbs |
| `engine/lib/recipe.mjs` | frontmatter schema v1 + versioned validation errors (exit 2) |
| `engine/lib/provenance.mjs` | OSS core: explicit `provenance.issue` binding only; heuristic Paperclip/OKR matcher → private adapter |
| `engine/lib/graph.mjs` | semantics unchanged; + CRLF normalization in fingerprint path; named gate profiles |
| `engine/lib/fingerprint.mjs` | + normalize() per §4.5 |
| `app/server.mjs`, `app/public/` | become `traceweave serve` (read-only v1) |
| `engine/ontology.json` (21 types, 5 tiers) | becomes the `product-lifecycle` template; `generic-software` template authored for P0 |

## 14. Delivery workstreams (sequence, no estimates)

- **WS1 — Core extraction:** monorepo scaffold, config file, schema v1, exit codes, CRLF
  normalization, internal adapters split out. Exit: selftest + determinism snapshot green on the
  3-OS matrix.
- **WS2 — Action + demo:** the Action, demo repo, quickstart docs. Exit: a stranger can gate a
  fresh repo in under ten minutes following the README.
- **WS3 — Reconcile:** drafter backends, reconcile workflow, idempotent PR mechanics. Exit: the
  demo repo's synthetic upstream change produces a mergeable AI fix PR.
- **WS4 — Projection:** `sync-issues` + Projects board. Exit: demo repo board mirrors graph state.
- **WS5 — Release engineering:** npm + action publishing, pinning, provenance, Scorecard,
  SECURITY.md. Runs alongside WS1–2; P0 cannot ship without it.
- **WS6 — Serve dashboard:** productize the UI. P1, after WS2.

**P0 = WS1 + WS2 + WS5.** **P1 = WS3 + WS4 + WS6.** **P2 =** ontology template library, GitHub
App, signed append-only audit layer (regulated-adjacent), Marketplace listing.

**Dogfood gate before any public launch:** our own product artifact set (the current 21-node
graph) runs on the P0 Action in a private repo; the launch announcement's own claims live as
traced artifacts in that repo. We are user zero.

## 15. Non-goals for v1

Hosted service · FDA Part 11 signed audit trail (P2 layer, not v1) · ReqIF import/export ·
multi-repo graphs · GitLab/Bitbucket (a thin VCS-provider seam is kept in the Action wrapper, but
only GitHub is implemented) · real-time collaborative editing · WYSIWYG artifact editor ·
telemetry of any kind.

## 16. Decisions

**Made by this design** (engineering-level, within the concept's mandate): files-as-record with
one-way projection (§4, §8) · zero-infrastructure v1, App deferred to P2 (§1, §2) · committed
`graph.json` + committed caches (§4.4, §5) · deterministic reconcile-PR idempotency keys (§7) ·
secretless gate mode (§6) · heuristic provenance stays internal (§8) · CRLF-normalized
fingerprints as a versioned contract (§4.5).

**Still Aidar's**: license confirm (Apache-2.0 recommended). **Decided 2026-07-02:**
name = Traceweave (approved) · build greenlit, Max delivers (see `canonweave_delivery_plan.md`) ·
GitHub org = **traceweavehq** (exact name `traceweave` is squatted by a dormant 2025-09 user account;
npm package `traceweave` + scope `@traceweave` were free on 2026-07-02 — reserve at WS5 publish).
