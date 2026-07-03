# sync-issues — the work plane (design §8)

`canonweave sync-issues` projects the artifact graph into GitHub's native work
surfaces so the team plans and tracks where they already work — while the
files stay the only system of record.

## What it projects

| Graph | GitHub |
|---|---|
| artifact | one issue: `<title> [<id>]`, body with file link + state table |
| artifact type | native **issue type** (best-effort) + `canonweave:type:<type>` label (always) |
| tier | `tier:<tier>` label |
| board status | `status:<fresh\|suspect\|gap\|placeholder>` label + Projects v2 single-select |
| derivation edge | **sub-issue** relation (see the single-parent rule below) |

Board status per node: `placeholder` (status: placeholder) → `gap` (source
unresolved) → `suspect` (any suspect ingredient) → `fresh`.

## One-way convergence contract

- **Files → GitHub only.** Issue edits never mutate files; the next sync
  overwrites the projection (human-added labels outside the managed set are
  preserved).
- **Issue deletion never deletes artifacts.** The next sync re-creates the
  issue and re-binds the anchor.
- **The binding anchor is `provenance.issue`** in artifact frontmatter —
  explicit and deterministic; no matching heuristics. Frontmatter is hash-safe
  (fingerprints cover the body only), so anchor writes never make anything
  suspect. This is the only file write sync performs.
- **Idempotent:** writes happen only on drift; an unchanged graph re-syncs
  with zero GitHub writes. Bounded retries with exponential backoff.

## The single-parent rule (DAG → tree)

GitHub allows one parent per sub-issue; the graph is a DAG. When an upstream
feeds several downstreams, the FIRST downstream in sorted-id order claims the
sub-issue relation — deterministic — and the remaining edges stay visible as
ingredient links in the issue bodies. The sync summary counts them as
`body-only`.

## Setup

1. `sync:\n  issues: true` in `canonweave.yml`.
2. Copy `templates/github/canonweave-sync-issues.yml` into `.github/workflows/`.
3. Optional board: add a fine-grained token with **project** scope as the
   `CANONWEAVE_PROJECTS_TOKEN` secret. The Actions `GITHUB_TOKEN` cannot access
   Projects v2 — without the extra token the board phase skips cleanly (the
   run says so) and issues, labels, and sub-issues still sync.
4. Native issue types are org-defined; when the org lacks an artifact type the
   sync falls back to the `canonweave:type:*` label and says so once per run.

Local run (uses your own token, which usually CAN reach Projects v2):

```bash
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=<owner>/<repo> canonweave sync-issues
```
