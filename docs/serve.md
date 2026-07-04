# `canonweave serve` — local read-only dashboard

A zero-dependency localhost dashboard over the **state of the last build**:
`graph.json` plus the artifact files on disk. It answers "what is the state of
my artifact graph?" visually — the same answer `canonweave check` prints.

```sh
canonweave build          # write graph.json (serve does not build)
canonweave serve          # http://127.0.0.1:8791
canonweave serve --port 0 # OS-assigned free port (printed on start)
```

Works from any directory inside an initialized repo (nearest `canonweave.yml`
upward, or `--config <path>`).

## What it shows

| View | Content |
|---|---|
| **Overview** | node/edge/suspect/gap counts, per-profile gate verdicts with blocking reasons, the suspect ingredient links (reconciled vs current fingerprint), the coverage gaps |
| **Graph** | tier columns in ontology order with derivation edges (upstream → downstream); suspect links drawn amber; filter by tier, suspects-only, or focus one artifact's full chain |
| **Artifacts** | browser over every artifact: type, tier, status, source kind, fingerprint, upstream/downstream links, projected issue anchor, and the raw file content |
| **Report** | the byte-exact `canonweave check` output for the built graph |

Per-node status uses the same vocabulary as the [issues/board projection](sync-issues.md):
`fresh` · `suspect` · `gap` · `placeholder`.

## Read-only, by construction

- Only `GET` routes exist; every other method is `405`. The dashboard has no
  save, edit, or write path — files stay the system of record, edited in your
  editor and rebuilt with `canonweave build`.
- Binds `127.0.0.1` only. No auth (design §9: a localhost tool); a foreign
  `Host` header is rejected with `403` so a hostile web page cannot reach it
  through DNS rebinding.
- The artifact endpoint serves **only ids from the loaded artifact index** —
  requests never name filesystem paths.

## Freshness

`serve` renders the last **built** state and re-reads it on every refresh, so
running `canonweave build` (or `reconcile --apply`) in another terminal shows
up on plain reload. When artifact files diverge from `graph.json` — a changed
inline body or repo file, an added/removed artifact, an edited ingredient
list — the dashboard shows a stale banner: run `canonweave build`, then
refresh. (`url`/plugin sources would need real resolution and are not
re-checked for the banner.)

If there is no `graph.json` yet, `serve` exits with code 2 and
`TW_SERVE_NO_GRAPH: run "canonweave build" first`.

## Endpoints

| Route | Returns |
|---|---|
| `GET /` | the dashboard (single self-contained page, no external assets) |
| `GET /api/state` | `{repo, config, tiers, stale, graph, status, report, artifacts}` — the parsed `graph.json`, per-node board status, the `check` report text, and the artifact index |
| `GET /api/artifact/<id>` | `{id, path, content}` — the artifact file, verbatim |

## Deployments

The dashboard is a local tool. Our own hosted instance (behind SSO, the
dogfood deployment) runs this same code — nothing here implements auth;
put a reverse proxy in front if you host it.
