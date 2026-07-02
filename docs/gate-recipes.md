# Gate recipes: making the check a merge blocker

The action fails the job per the exit-code contract; whether a failing job
BLOCKS the merge is your repository's branch-protection / ruleset policy.
Traceweave documents the recipe — it never controls your repo settings.

## 1. Wire the workflow

Copy [templates/github/traceweave-gate.yml](../templates/github/traceweave-gate.yml)
into `.github/workflows/traceweave-gate.yml`. It ships with:

- triggers: `pull_request`, `push` (default branch), `merge_group`
  (merge-queue), `workflow_dispatch`, optional `schedule` for a nightly drift audit;
- `concurrency: traceweave-${{ github.ref }}` with cancel-in-progress on PRs;
- least-privilege permissions (`contents: read`, `checks: write`,
  `pull-requests: write`) — gate mode itself needs **no secrets**.

## 2. Require the check — ruleset (recommended)

Repo → Settings → Rules → Rulesets → New branch ruleset:

1. Enforcement: Active. Target: your default branch.
2. Add rule **"Require status checks to pass"** → search for `gate`
   (the job name from the workflow) and select it.
3. Optionally enable **"Require branches to be up to date"** — with
   `merge_group` in the workflow this is what makes a merge queue re-run the
   gate on the queued state.

Classic branch protection works identically: Settings → Branches → Add rule →
"Require status checks to pass before merging" → select `gate`.

## 3. Merge queue

The workflow's `merge_group` trigger makes queued merges re-validate. In the
queue context there is no PR to comment on — the action skips the sticky
comment automatically and the check + job summary still gate the merge.

## 4. Fork PRs

Fork runs get a read-only `GITHUB_TOKEN`: the sticky comment is skipped with a
`::notice`, while annotations, the job summary, and the pass/fail conclusion
all still work. Nothing to configure.

## 5. What reviewers see on a red gate

- an inline annotation on the exact `reconciled:` entry line of each suspect
  artifact file, naming the link and both fingerprints;
- one sticky PR comment (updated in place, never a comment per push) with the
  suspect table, gap list, and per-profile verdicts;
- the same report as the job summary (the fork-safe surface).

Fix paths shown in every annotation: `traceweave reconcile <id>` (then
`--apply`), or `traceweave clear <id> <ingredient>` when the change was
reviewed and the downstream is still correct.

## 6. Different strictness per branch

`gates` in `graph.json` records every profile's verdict on every build, so one
workflow can gate `main` on `ready-to-build` while a `release/*` ruleset
requires a second job running the action with `profile: ready-to-ship`.
