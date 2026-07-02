# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** via GitHub Security Advisories:
[Report a vulnerability](https://github.com/traceweavehq/traceweave/security/advisories/new).
Do not open a public issue for a security report.

You can expect an acknowledgement within **72 hours** and a fix or a concrete
remediation plan within **14 days** for confirmed issues. Credit is given in
the advisory unless you ask otherwise.

## Supported versions

Until 1.0, only the latest published minor receives fixes.

## Posture (what you are trusting)

- **Zero runtime dependencies** — engine, CLI, and action import only `node:`
  builtins and relative modules, enforced in CI (`scripts/check-zero-deps.mjs`).
  What you read in `packages/` is everything that runs.
- **Secretless gate** — `build`/`check`/`gate` need no credentials; only the
  sticky PR comment uses the workflow's own `GITHUB_TOKEN`.
- **Human gate on AI output** — reconcile drafts land as proposals/PRs, never
  auto-applied.
- Full trust model and injection defenses: [docs/security.md](docs/security.md).
- Consume the action **pinned by commit SHA**, never a floating tag:
  [docs/releasing.md](docs/releasing.md) documents the pinning contract.
