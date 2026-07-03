// Canonweave reconcile action — the AI plane (design section 7).
// Zero runtime dependencies: engine via relative import, git via the runner's
// git binary, GitHub via global fetch against GITHUB_API_URL.
//
// Per run: build the graph; for every suspect DOWNSTREAM artifact draft the
// corrected content (repo-configured drafter backend) and open/refresh ONE
// idempotent reconcile PR:
//   - branch canonweave/reconcile/<downstream-id>--<fp8> (fp8 = first 8 hex
//     of the NEW primary-upstream fingerprint) — the idempotency key: a
//     re-run force-pushes the same branch and PATCHes the same PR, never
//     duplicates; a further upstream change (new fp8) opens the successor
//     and closes the stale PR with a link.
//   - the commit updates the artifact body AND its reconciled fingerprints
//     (plus graph.json), so MERGING THE PR IS THE REVIEW.
// Drafts that fall back to a BRIEF (backend "none", missing key, API failure)
// produce no PR — they surface in the job summary instead. Never our key,
// never our infra: the drafter key comes from the consumer's repo secret.
//
// Exit codes: 0 ok/clean · 1 one or more downstreams failed · 2 config/env
// error · 3 resolve error. Workflow-command helpers mirror packages/action.
import { appendFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ConfigError, ResolveError,
  findConfigPath, loadConfig, CONFIG_FILENAME,
  loadOntology, loadArtifacts, buildGraph, loadResolverPlugins,
  reconcileDraft, reconcileApply, proposalPath,
} from '../engine/src/index.mjs';

function relPosix(from, to) { return relative(from, to).replace(/\\/g, '/'); }

// ---- workflow-command escaping (GitHub Actions toolkit rules) --------------
function escData(s) { return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'); }
function escProp(s) { return escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C'); }
function annotateError(message) { console.log(`::error::${escData(message)}`); }
function notice(message) { console.log(`::notice::${escData(message)}`); }
function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${name}=${value}\n`, 'utf8');
}
function writeSummary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) appendFileSync(f, md + '\n', 'utf8');
}
function fp8(fp) { return fp && String(fp).startsWith('sha256:') ? fp.slice(7, 15) : 'unknown0'; }

// ---- git (runs in the workspace; checkout has already authenticated) ------
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

// ---- GitHub REST ------------------------------------------------------------
function ghClient() {
  const token = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  return {
    token, repo, api,
    async call(method, path, body) {
      const res = await fetch(`${api}/repos/${repo}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json = null;
      const text = await res.text();
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      return { status: res.status, ok: res.ok, json };
    },
  };
}

const BRANCH_PREFIX = 'canonweave/reconcile/';
const RECONCILE_LABEL = 'canonweave:reconcile';

function branchNameFor(id, newFp) { return `${BRANCH_PREFIX}${id}--${fp8(newFp)}`; }

function prBody({ id, draftResult, backendLine, proposalExcerpt }) {
  const s = draftResult.suspects.map((sp) =>
    `| \`${sp.ingredient}\` | \`${fp8(sp.expected)}\` | \`${fp8(sp.actual)}\` |`).join('\n');
  return [
    `<!-- canonweave-reconcile:${id} -->`,
    `## Canonweave reconcile: \`${id}\``,
    ``,
    `An upstream ingredient changed; this PR re-derives \`${id}\` and updates its`,
    `\`reconciled\` fingerprints. **Merging this PR is the review** — the suspect`,
    `link clears and the next gate run goes green. If the draft is wrong, edit it`,
    `on this branch before merging (the fingerprints still clear), or close the`,
    `PR and reconcile by hand.`,
    ``,
    `| suspect ingredient | reconciled | current |`,
    `|---|---|---|`,
    s,
    ``,
    backendLine,
    ``,
    `A further upstream change will supersede this PR: the successor links back`,
    `here and this branch is closed automatically. Merging re-fingerprints this`,
    `artifact, so ITS dependents may go suspect next — the reconcile workflow`,
    `opens the next wave automatically and the graph converges to green one`,
    `reviewed hop at a time (the ripple is the point).`,
    ``,
    `### Proposal`,
    ``,
    proposalExcerpt,
  ].join('\n');
}

async function main() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const gh = ghClient();

  if (!gh.token) {
    annotateError('canonweave-reconcile needs GITHUB_TOKEN (contents:write + pull-requests:write) — reconcile PRs cannot be opened without it.');
    process.exitCode = 2;
    return;
  }
  if (!gh.repo) {
    annotateError('canonweave-reconcile: GITHUB_REPOSITORY is not set.');
    process.exitCode = 2;
    return;
  }

  // config (input or auto-discovery from the workspace)
  const inputConfig = (process.env.INPUT_CONFIG || '').trim();
  const configPath = inputConfig ? resolve(workspace, inputConfig) : findConfigPath(workspace);
  if (!configPath) {
    annotateError(`no ${CONFIG_FILENAME} found in the workspace — is this repo initialized for canonweave?`);
    process.exitCode = 2;
    return;
  }
  const cfg = loadConfig(configPath);
  const onto = loadOntology(cfg.ontologyPath);
  const plugins = await loadResolverPlugins(cfg.resolverModules);
  const ctx = { repoRoot: cfg.repoRoot, cacheDir: cfg.cacheDir, plugins, defaultProfile: cfg.gateProfile };

  // base state: the checked-out default branch
  const baseSha = git(workspace, 'rev-parse', 'HEAD');
  let baseRef = process.env.GITHUB_REF_NAME || '';
  if (!baseRef) {
    try { baseRef = git(workspace, 'symbolic-ref', '--short', 'HEAD'); } catch { baseRef = ''; }
  }
  if (!baseRef) baseRef = 'main';

  // committer identity for the reconcile commits
  git(workspace, 'config', 'user.name', 'github-actions[bot]');
  git(workspace, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');

  const graph = await buildGraph(onto, loadArtifacts(cfg.roots), ctx);
  const byDownstream = new Map();
  for (const sp of graph.suspects) {
    if (!byDownstream.has(sp.node)) byDownstream.set(sp.node, []);
    byDownstream.get(sp.node).push(sp);
  }

  setOutput('suspects', graph.suspects.length);
  setOutput('downstreams', byDownstream.size);

  if (byDownstream.size === 0) {
    notice('canonweave reconcile: graph is clean — nothing to reconcile.');
    setOutput('prs-created', 0); setOutput('prs-updated', 0);
    setOutput('prs-closed', 0); setOutput('briefs', 0);
    setOutput('result', 'clean');
    writeSummary(`## Canonweave reconcile: nothing to do\n\n\`${graph.nodes.length}\` nodes · \`0\` suspect links — the graph is clean.`);
    return;
  }

  const rows = [];
  let created = 0, updated = 0, closed = 0, briefs = 0, failures = 0;

  const ids = [...byDownstream.keys()].sort();
  for (const id of ids) {
    try {
      // fresh working state per downstream, branched from the base
      git(workspace, 'checkout', '-f', baseSha);
      const byId = loadArtifacts(cfg.roots);
      const artifactPath = byId[id] ? byId[id].path : null;
      const d = await reconcileDraft({ cfg, onto, byId, ctx, id });

      if (!d.drafted) {
        briefs++;
        rows.push(`| \`${id}\` | \`${d.upstream ? d.upstream.id : '—'}\` | brief — ${d.error || 'no auto-draft'} |`);
        try { unlinkSync(proposalPath(cfg.repoRoot, id)); } catch { /* keep workspace tidy; absence is fine */ }
        continue;
      }

      const branch = branchNameFor(id, d.upstream.to);
      git(workspace, 'checkout', '-B', branch, baseSha);

      const a = await reconcileApply({ cfg, onto, ctx, id, loadArtifacts });
      writeFileSync(cfg.graphPath, JSON.stringify(a.graph, null, 2) + '\n', 'utf8');
      try { unlinkSync(proposalPath(cfg.repoRoot, id)); } catch { /* proposal content rides in the PR body */ }

      // Explicit adds of exactly the record files — never a tree sweep. -f
      // because consumers may gitignore .canonweave/ wholesale: naming an
      // ignored path (even inside an :(exclude) pathspec) makes git add die
      // with the ignored-paths advice error (caught live by the dogfood repo,
      // whose .gitignore covers .canonweave/proposals/).
      const toAdd = [relPosix(workspace, cfg.graphPath)];
      if (artifactPath) toAdd.push(relPosix(workspace, artifactPath));
      const cacheFile = join(ctx.cacheDir, `${id}.content`);
      if (existsSync(cacheFile)) toAdd.push(relPosix(workspace, cacheFile));
      git(workspace, 'add', '-f', '--', ...toAdd);
      git(workspace, 'commit', '-m',
        `canonweave reconcile: ${id} <- ${d.upstream.id} (${fp8(d.upstream.to)})\n\n` +
        `Upstream ${d.upstream.id} moved ${fp8(d.upstream.from)} -> ${fp8(d.upstream.to)}; ` +
        `re-derived ${id} with the ${d.backend} drafter and cleared its reconciled fingerprints. ` +
        `Merging this commit IS the review.`);
      git(workspace, 'push', '--force', 'origin', `HEAD:refs/heads/${branch}`);

      // create-or-update the PR (idempotency: find by head branch)
      const owner = gh.repo.split('/')[0];
      const found = await gh.call('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      const existing = Array.isArray(found.json) && found.json.length > 0 ? found.json[0] : null;

      const backendLine = `Drafter: \`${d.backend}\`${cfg.drafter.model ? ` · model \`${cfg.drafter.model}\`` : ''} — single completion, no tools, input-capped (see docs/reconcile.md threat model).`;
      const excerpt = (d.content || '').length > 20000
        ? d.content.slice(0, 20000) + '\n\n[proposal truncated in the PR body — the full content is this PR\'s diff]'
        : (d.content || '');
      const body = prBody({ id, draftResult: d, backendLine, proposalExcerpt: excerpt });
      const title = `canonweave reconcile: ${id} (upstream ${d.upstream.id} changed)`;

      let prNumber;
      if (existing) {
        const r = await gh.call('PATCH', `/pulls/${existing.number}`, { title, body });
        if (!r.ok) throw new Error(`PR update failed: HTTP ${r.status}`);
        prNumber = existing.number;
        updated++;
        rows.push(`| \`${id}\` | \`${d.upstream.id}\` | updated #${prNumber} (\`${fp8(d.upstream.from)}\` -> \`${fp8(d.upstream.to)}\`) |`);
      } else {
        const r = await gh.call('POST', `/pulls`, { title, head: branch, base: baseRef, body });
        if (!r.ok || !r.json || r.json.number === undefined) {
          throw new Error(`PR creation failed: HTTP ${r.status}${r.status === 403
            ? " — enable 'Allow GitHub Actions to create and approve pull requests' (repo Settings → Actions → General → Workflow permissions); the reconcile branch is already pushed and the next run will attach the PR"
            : ''}`);
        }
        prNumber = r.json.number;
        created++;
        rows.push(`| \`${id}\` | \`${d.upstream.id}\` | created #${prNumber} (\`${fp8(d.upstream.from)}\` -> \`${fp8(d.upstream.to)}\`) |`);
      }
      await gh.call('POST', `/issues/${prNumber}/labels`, { labels: [RECONCILE_LABEL] }); // best-effort

      // succession: close stale reconcile PRs for the same downstream, other fp8
      const open = await gh.call('GET', `/pulls?state=open&per_page=100`);
      const stale = (Array.isArray(open.json) ? open.json : []).filter((p) =>
        p && p.head && typeof p.head.ref === 'string'
        && p.head.ref.startsWith(`${BRANCH_PREFIX}${id}--`)
        && p.head.ref !== branch);
      for (const p of stale) {
        await gh.call('POST', `/issues/${p.number}/comments`, {
          body: `Superseded by #${prNumber}: the upstream moved again (now \`${fp8(d.upstream.to)}\`). Closing in favor of the successor.`,
        });
        await gh.call('PATCH', `/pulls/${p.number}`, { state: 'closed' });
        await gh.call('DELETE', `/git/refs/heads/${encodeURIComponent(p.head.ref)}`);
        closed++;
      }
    } catch (e) {
      failures++;
      annotateError(`reconcile ${id}: ${e.message}`);
      rows.push(`| \`${id}\` | — | FAILED — ${e.message} |`);
    }
  }

  // restore the workspace to the base branch state
  try { git(workspace, 'checkout', '-f', baseRef); } catch { git(workspace, 'checkout', '-f', baseSha); }

  setOutput('prs-created', created);
  setOutput('prs-updated', updated);
  setOutput('prs-closed', closed);
  setOutput('briefs', briefs);
  setOutput('result', failures > 0 ? 'partial' : 'ok');

  writeSummary([
    `## Canonweave reconcile: ${byDownstream.size} suspect downstream(s)`,
    ``,
    `\`${graph.suspects.length}\` suspect link(s) · \`${created}\` PR(s) created · \`${updated}\` updated · \`${closed}\` superseded/closed · \`${briefs}\` brief(s)${failures ? ` · \`${failures}\` FAILED` : ''}`,
    ``,
    `| downstream | upstream | action |`,
    `|---|---|---|`,
    ...rows,
    ``,
    briefs > 0 ? `Briefs mean no auto-draft was possible (backend \`none\`, missing key, or API failure) — reconcile those by hand or fix the drafter config.` : ``,
  ].join('\n'));

  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  if (e instanceof ConfigError) {
    annotateError(`canonweave-reconcile config error: ${e.message}`);
    process.exitCode = 2;
  } else if (e instanceof ResolveError) {
    annotateError(`canonweave-reconcile resolve error: ${e.message}`);
    process.exitCode = 3;
  } else {
    annotateError(`canonweave-reconcile: ${e.stack || e.message}`);
    process.exitCode = 2;
  }
});
