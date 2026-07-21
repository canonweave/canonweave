# Concept: GitHub-Native ALM — the open-source alternative to Polarion/DOORS

Status: CONCEPT (pre-Gate-A) · Created 2026-07-01 · Owner: Arnold (runtime steward) + Sam (iMaoKe product)
Built on: Artifact ALM engine (`projects/imaoke/harness/trace/`)
Landscape evidence: `projects/workforce/knowledge_domains/wiki/synthesis/github_native_alm_landscape_2026_07_01.md`
Production design (downstream): `github_native_alm_design.md` (architecture, data model, contracts, security, delivery)

## One line

Requirements-to-code traceability that lives inside your GitHub repo, keeps itself honest in CI, and
uses an LLM to repair what drifts — the open-source, developer-first, AI-native alternative to
Polarion, IBM DOORS, and Jama that costs €700–2,600+/user/month.

## The idea

Heavyweight ALM tools (DOORS, Polarion, Codebeamer, Jama) do one thing GitHub cannot: a **living
traceability graph** — requirement → design → test → code, where changing an upstream artifact
automatically flags every downstream artifact as **suspect** until re-reviewed, and a **gate** blocks
release until coverage is clean. They charge a fortune for it and keep the data in a proprietary
database. GitHub does the opposite things they can't: it IS where the code, the reviews, the CI, and
the developers already are.

We already built the hard part. **Artifact ALM** (`harness/trace/`) is a zero-dependency, deterministic
engine that implements the whole traceability spine: a typed artifact ontology, SHA-256 fingerprint
suspect-links (Doorstop's mechanism), coverage-gap detection, a pass/fail gate, and — uniquely — an
**LLM reconcile loop** that re-drafts a stale downstream artifact for human approval. Today it points at
Paperclip + a Feishu OKR board and runs as a local app.

The product is: **repoint that engine at GitHub, package it as an installable GitHub Action + App, and
open-source it.** The research sweep (9 agent threads, ~12 sub-searches, 2026-07-01) confirmed nobody
ships this combination. It is genuine white space.

## Press release (imagined launch)

> **Today we're releasing [NAME], the open-source ALM that lives in your GitHub repo.**
>
> Software teams have two bad options for requirements traceability: pay €700–2,600 per user per month
> for DOORS or Polarion and move your requirements into a proprietary database — or track nothing and
> watch specs rot out of sync with code.
>
> [NAME] is a GitHub Action and App. Your requirements, designs, and test specs live as Markdown files
> in your repo, typed and linked into a traceability graph. On every pull request, [NAME] recomputes the
> graph: if you change a requirement, every design, test, and code artifact that derives from it is
> flagged **suspect** and the check fails until you review it. When something goes suspect, [NAME]'s bot
> opens a pull request with an AI-drafted fix for you to approve. Coverage gaps block the merge.
>
> It's free, it's open-source, and it takes ten minutes to add to a repo you already have. No migration,
> no seat licences, no database. For teams doing AI-assisted, spec-driven development, it's the missing
> guardrail that keeps your specs and your code telling the same story.

## FAQ

**Who is this for?** Serious software teams, open-source projects, and AI-heavy/spec-driven teams who
want DOORS-grade traceability discipline without the cost — and who do NOT need FDA 21 CFR Part 11
e-signatures (see "regulated" below). Beachhead: the spec-driven-development crowd (github/spec-kit has
116k stars) whose Markdown specs currently drift out of sync with the code AI agents generate.

**How is this different from spec-kit / OpenSpec / Kiro?** Those are scaffolds that help an AI *write*
code from a spec once. They have no persistent graph, no suspect-link detection when a spec later
changes, no CI gate, and no auto-repair. [NAME] is the opposite: it doesn't write your app, it keeps the
artifacts *provably in sync over time* and blocks merges when they aren't. It complements spec-kit — you
can run both.

**How is this different from Doorstop / StrictDoc / OpenFastTrace?** They pioneered docs-as-code
traceability but: (a) they're repo-file tools with no GitHub Issues/Projects integration and no packaged
Action; (b) only Doorstop has real suspect-links, and it has no `--fail-on-suspect` CI flag; (c) none has
an AI reconcile loop. [NAME] = Doorstop's rigor + OpenFastTrace's CI gate + a typed ontology + an AI
repair loop, delivered as a native GitHub App.

**How is this different from Ketryx / Jama / Trace.Space?** Those are the closest commercial players.
They keep a proprietary database (GitHub is a synced source, not the record), they're closed SaaS, and
none does autonomous LLM re-drafting of stale artifacts. [NAME] is open-source and GitHub-native.

**What about regulated industries (medical/aerospace)?** They're NOT the beachhead. FDA 21 CFR Part 11 and
IEC 62304 need tamper-evident, e-signed, immutable audit trails, which is exactly why every incumbent
keeps its own database — mutable GitHub Issues can't satisfy it. Our wedge is the large *unregulated*
middle. Regulated becomes a P2 opportunity by adding a signed, append-only, git-anchored audit layer on
top (our deterministic SHA-fingerprint design is already half of it) — a differentiator, not a rebuild.

## The key architectural decision — what "GitHub-native" actually means

The naive reading is "put requirements in GitHub Issues." That is wrong, and it's why innolitics/rdm (the
only tool that tried it) stayed niche: the suspect-link mechanism **requires content fingerprinting**, and
GitHub Issues are mutable, editable without a signed trail, and awkward to hash and diff. So the correct
model is a clean split — GitHub the *platform* is the system of record, across three surfaces:

| Surface | What it holds | Why here |
|---|---|---|
| **Repo files** (Markdown + YAML frontmatter) | Artifact **content** (requirements, designs, test specs) + the recipe/derivation edges + `graph.json` | Versioned, diffable, **fingerprintable** (SHA-256 → suspect links need this), reviewable in PRs, signed via commits |
| **Issues + Projects** | The **work/status** layer: tasks, assignees, review state, the coverage/gate board | Native UI, notifications, sub-issues (GA Apr 2025) as edges, issue types as the ontology surface |
| **Actions + Checks + App** | **Enforcement + AI**: recompute graph on PR, fail check on suspects/gaps, post report, open reconcile PRs | Where CI and developers already are; this is the moat nobody packaged |

This is exactly Artifact ALM's existing **two-plane design** (artifact graph + work ledger via the
provenance bridge) — we just repoint the work plane from Paperclip/Feishu to Issues/Projects, and wrap
the engine in an Action. It also neatly sidesteps the Part-11 problem and cleanly differentiates from
innolitics/rdm.

## Five pillars → GitHub mapping (and what we reuse)

| Pillar | Artifact ALM today | In the product | Build effort |
|---|---|---|---|
| 1. System of record | files + Paperclip/OKR | repo files (content) + Issues/Projects (work) | adapter — **new** |
| 2. Typed ontology + edges | `ontology.json` (21 types, 5 tiers) | generalize → configurable ontology; map to issue types | **reuse + generalize** |
| 3. Suspect links | SHA-256 fingerprint + `clear` | same engine, unchanged | **reuse as-is** |
| 4. CI readiness gate | `trace gate` (local exit code) | packaged **GitHub Action**: build+gate, fail check, PR comment | wrap — **new-ish** |
| 5. LLM auto-redraft | `reconcile` → proposal → `--apply` | **App/bot**: suspect → opens PR with AI draft; human approves via review | wrap — **new-ish** |

The engine (pillars 2, 3, 5) already exists and is deterministic and dependency-free. The genuinely new
work is a **GitHub adapter** (Issues/Projects/repo as source resolvers — Artifact ALM already has a
`resolve.mjs` with inline/repo/feishu resolvers; add a `github` resolver) + a **packaged Action** + a
**GitHub App** for the interactive/PR layer. Roughly the "hard 20%."

## MVP scope

- **P0 — the wedge (small; engine exists).** A GitHub Action that runs the trace engine on a repo of
  Markdown artifacts: computes the graph, detects suspect links + coverage gaps, **fails the PR check**,
  and posts a traceability report as a check summary / PR comment. Repo-files-as-artifacts only. Publish
  as an open-source Action on the GitHub Marketplace. This alone already beats Doorstop (no packaged
  Action), OpenFastTrace (no suspect-links, no ontology), and is genuinely novel.
- **P1 — GitHub-native + AI.** Issues/Projects binding (artifact ↔ issue provenance; sub-issues as
  edges; a Projects board showing coverage/gate state). The **reconcile bot**: on a suspect link, open a
  PR with the AI-drafted downstream fix for review.
- **P2 — depth.** Web dashboard (reuse the existing `artifact-alm` UI at :8791), ontology templates
  (generic / product-lifecycle / ISO-26262-lite), the signed-audit layer for regulated-adjacent teams,
  multi-repo/portfolio, Marketplace polish + docs.

## Competitive positioning (distilled)

| | GitHub SoR | Typed ontology | Suspect links | CI gate | AI redraft | OSS |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| **[NAME] (proposed)** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| DOORS/Polarion/Jama | ✗ own DB | ✓ | ✓ | ~ | ~ | ✗ €€€ |
| Ketryx (Series B) | ✗ own DB | ✓ | ✓ | ✓ | ✗ | ✗ |
| Doorstop | ✗ files | ~ | ✓ | ~ | ✗ | ✓ |
| OpenFastTrace | ✗ tags | ✓ | ✗ | ✓ | ✗ | ✓ |
| spec-kit (116k★) | ✗ md | ✗ | ✗ | ~ | code-gen | ✓ |

## Why us

The engine is built, deterministic, zero-dependency, and git-native — time-to-MVP is weeks, not months.
We have a live multi-agent runtime (AIW) to **dogfood** it on real internal work (iMaoKe's own
product-lifecycle artifacts are already in the graph: 21 nodes, Gate-A wired). First-mover timing is now:
multiple 2026 OSS tools (ContextGit, Intent Integrity Kit, Tessl) are circling the same primitives but
nobody has arrived.

## Risks + mitigations

- **GitHub itself / spec-kit gravity** (116k★, GitHub's own): if GitHub bolts traceability onto Projects,
  they own it. → Build *on* the platform as an App, ride the wave, integrate with spec-kit rather than
  compete. Ship fast while the chair is empty.
- **Small OSS market** (Doorstop/StrictDoc ~300-640★): pure traceability is niche. → The **AI-redraft +
  spec-sync** angle targets the much larger AI-assisted-dev audience, not just the compliance crowd.
- **Doorstop/StrictDoc add GitHub+AI first.** → Moat = the *combination* + reconcile loop + execution
  speed + AIW dogfooding. Ship P0 quickly.
- **Regulated needs immutable store.** → Deferred to P2 signed-audit layer; not the beachhead.

## Naming — DECIDED: Traceweave (approved 2026-07-02) — was: (Aidar's decision — vetted-available shortlist)

Most obvious names are taken (throughline, clew, traceloom, reqweave = taken on npm; traceway collides
with a 907★ repo). Verified-available (npm free + no/low GitHub collision):

| Name | Meaning | npm | GitHub | Note |
|---|---|---|---|---|
| **Traceweave** (rec.) | weaves traceability through the repo | free | no collision | clear, safe, slightly generic |
| Provenant | provenance / where things come from | free | 23★ only | distinctive, mild spelling risk |
| Keelreq | keel = structural backbone | free | free | ownable, a bit awkward |

Recommendation: **Traceweave** as a safe default, but naming is genuinely your call — it should also
clear domain + a dedicated GitHub org. Not locking it.

## Open decisions for Aidar

1. **Name** + which GitHub org hosts it (a new dedicated org vs `faizer1989` vs `imaoke`).
2. **License**: Apache-2.0 (recommended — patent grant matters given the "suspect links" patent history)
   vs MIT.
3. **Build now vs later**, and **who owns the build** (Max engineering under Arnold's steward, per the
   runtime split).
4. **Beachhead confirm**: AI/spec-driven dev teams first (recommended) vs regulated-adjacent first.
5. **Dogfood-first**: prove P0 on our own iMaoKe artifacts before any public launch (recommended).

## Next steps (proposed)

1. Aidar picks name + org + license + go/hold.
2. If go: run this through the Product Lifecycle Gate A (`knowledge_domains/product_lifecycle/spec.md`) —
   this doc is already most of the PR-FAQ + risk framing that Gate A wants.
3. P0 build: `github` source resolver + the Action + a demo repo, dogfooded on iMaoKe's own graph.
