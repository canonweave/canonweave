# Canonweave demo repo (living fixture)

A minimal product with a full traced artifact graph, generated from the
`generic-software` template. It serves three jobs at once:

1. **Docs demo** — the quickstart walks through exactly this repo.
2. **CI fixture** — `scripts/determinism.mjs` rebuilds it and byte-compares
   the result against the committed `docs/trace/graph.json`; any engine/demo
   drift fails CI.
3. **Integration surface** — the action's hermetic selftest
   (`packages/action/selftest.mjs`) copies this repo, mutates an upstream, and
   asserts the gate goes red naming the right suspect link; the CI `gate-demo`
   job runs the real action against this committed state on every push.
   GitHub-hosted synthetic-PR runs land with the WS5 publish.

Regenerate after intentional engine-format changes:

    rm -rf examples/demo-repo && node packages/cli/bin/canonweave.mjs init --template generic-software --dir examples/demo-repo
    (then restore this README)

`docs/trace/graph.json` and any `.canonweave/cache/` content are committed on
purpose — deterministic, diff-reviewable state (design sections 4.4, 5).
