# Security posture

## Supply chain: zero runtime dependencies

The engine, CLI, and action wrapper import only `node:` builtins and relative
modules — enforced in CI by `scripts/check-zero-deps.mjs`. There is no
dependency tree to audit and no `npm install` in any workflow. What you read
in `packages/` is everything that runs.

## Trust model

| input | trust | defense |
|---|---|---|
| artifact files (frontmatter + body) | **untrusted** | schema validation (exit 2); content only ever hashed, rendered in reports, or fed to the drafter behind the human PR gate |
| `canonweave.yml`, `ontology.yml` | repo-trusted (reviewed like code) | strict validation, unknown keys rejected |
| resolver plugins (`resolvers:` in canonweave.yml) | **executes arbitrary code** — treat exactly like a dev dependency; review before adding; collisions with builtin kinds are rejected | |
| `url` sources | untrusted remote content | fetched with a 30s timeout; content cached and committed — the diff of the cache file IS the review surface for remote changes |
| drafter `cmd` backend | runs a repo-configured argv | configure only trusted commands; the prompt is passed as one argument, never through a shell |

## AI drafter: prompt-injection defense (layered)

Anyone who can edit a Markdown artifact can try to steer the LLM drafter.
Layers, per design section 7:

1. drafter runs a **single completion with no tool access**;
2. pinned instruction — "output only the corrected artifact body";
3. input size caps and fence/preamble stripping on the response;
4. output lands as a **proposal file / PR that a human must review** — nothing
   AI-written is ever auto-applied (invariant 5);
5. worst case of a malicious artifact edit = a bad *proposal*, the same blast
   radius as any malicious PR.

Backends: `template` (deterministic, offline), `cmd` (local CLI), `none`
(brief-only), and the WS3 zero-dep API backends `anthropic` / `openai` — same
layering, key from the consumer's env only (docs/reconcile.md documents the
full threat model). Gate mode never needs any secret.

## Secretless gate

`build` / `check` / `gate` need **no credentials** — resolution is repo files,
committed caches, and plain HTTP GET for `url` sources. Only the reconcile
workflow ever sees a model key, and only as the user's own repo secret.

## Release engineering (WS5 — AIW-230)

Publishing lands with: SHA-pinned action usage guidance, npm provenance +
SLSA attestation, signed tags, OpenSSF Scorecard, CodeQL, SECURITY.md with a
disclosure policy, and branch protection gated by Canonweave itself (we are
user zero — the dogfood gate AIW-231 blocks any public launch).
