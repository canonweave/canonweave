# Traceweave — Delivery Plan

> **Renamed 2026-07-03:** the product shipped publicly as **canonweave** (npm `canonweave`, github.com/canonweave/canonweave). Older mentions of "traceweave" in this document refer to the same product under its working name.


Status: ACTIVE · Created 2026-07-02 · Name **Traceweave** approved by Aidar 2026-07-02
Builder: **Max** (AIW Software Engineering) · Steward: Arnold · Product gate: Aidar
Upstream: production design `github_native_alm_design.md` (architecture, contracts, §14 workstreams)
· concept `github_native_alm_concept.md` · engine `../harness/trace/`

This is the execution roadmap. The design owns WHAT each workstream contains; this document owns
the SEQUENCE, the per-issue acceptance criteria, and the Paperclip tracking handles Max works from.
Issues are tracking-only (no auto-dispatch assignee); Max picks them up in his own runtime.

## Decisions locked

- **Name: Traceweave** (approved 2026-07-02). Repo/package/action names derive from it.
- **GitHub org: traceweavehq** (approved 2026-07-02; exact `traceweave` squatted by a dormant
  account). Home: `github.com/traceweavehq/traceweave`; npm `traceweave` + `@traceweave` free as
  of 2026-07-02, reserved at first publish. Runbook: traceweave repo `docs/releasing.md`.
- **Builder: Max**, delivering workstream by workstream from the Paperclip board.
- Still pending with Aidar (blocks only WS5's publish step, nothing earlier): final license
  confirm (Apache-2.0 recommended). Public repo creation is an external-boundary step executed
  via the publish-github-project skill when WS5 reaches it.

## Sequence

```
WS1 core extraction ──> WS2 Action + demo ──> DOGFOOD GATE ──> launch-ready
        │                        │
        └── WS5 release eng (parallel with WS1+WS2; P0 cannot ship without it)
WS2 done ──> WS3 reconcile loop (P1)
         ──> WS4 issues/projects projection (P1)
         ──> WS6 serve dashboard (P1)
launch-ready ──> P2 backlog (templates library, GitHub App, signed audit layer, Marketplace)
```

Rule: nothing publishes publicly before the dogfood gate passes on our own 21-node artifact graph.

## Workstreams → Paperclip issues

| Issue | Workstream | Priority | Exit criterion (summary) |
|---|---|---|---|
| **AIW-228** | WS1 core extraction & monorepo scaffold | high | selftest + determinism snapshot green on ubuntu/windows/macos matrix |
| **AIW-229** | WS2 GitHub Action + demo repo + quickstart | high | a stranger gates a fresh repo in under ten minutes from the README |
| **AIW-230** | WS5 release engineering & security posture | high | pinned, provenance-attested, Scorecard-clean release pipeline |
| **AIW-231** | Dogfood gate on the iMaoKe graph | high | our 21-node graph gated by the P0 Action in a private repo |
| **AIW-232** | WS3 AI reconcile loop | medium | synthetic upstream change → mergeable AI fix PR on the demo repo |
| **AIW-233** | WS4 Issues/Projects projection | medium | demo repo board mirrors graph state, one-way convergence proven |
| **AIW-234** | WS6 `traceweave serve` dashboard | medium | read-only dashboard serves graph/suspects/gaps/gate locally |
| **AIW-235** | P2 backlog tracker | low | split into build issues when P1 lands |

Filed 2026-07-02 on the AIW Software Engineering board (company AIW, project Software Engineering),
all `status: backlog`, K1 interactive label, no assignee (tracking-only — Max picks up in his runtime).
Board: https://paperclip.unpackai.org:8443

## Working agreements for the build

- Acceptance criteria live in each issue; the design §-references are the normative spec.
- Every workstream lands with its tests (design §11) — the determinism snapshot and hermetic
  selftest are non-negotiable gates from WS1 onward.
- No time estimates on issues or in this plan; sequence and priority only.
- Engine changes preserve the prototype's public contracts unless the design's migration map
  (§13) explicitly changes them.
- Internal adapters (Feishu resolvers, Paperclip/OKR heuristic provenance) move to a private
  adapter package during WS1 — the OSS core never ships them.
