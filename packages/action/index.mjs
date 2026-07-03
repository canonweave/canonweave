// Canonweave gate action — the enforcement plane (design section 6).
// Zero runtime dependencies: engine via relative import, GitHub surfaces via
// workflow commands + GITHUB_STEP_SUMMARY + global fetch against GITHUB_API_URL.
//
// Per run: build the graph in memory (no workspace mutation), then emit
//   - inline ::error annotations on artifact files whose links went suspect
//   - a job summary (fork-safe surface, always written when available)
//   - ONE sticky PR comment updated in place (skipped gracefully on forks,
//     missing token, non-PR events — never fails the job by itself)
//   - outputs: result / exit-code / suspects / gaps / profile
// Exit codes mirror the CLI contract: 0 pass · 1 gate fail · 2 config error ·
// 3 unresolved source. Precedence 2 > 3 > 1.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

// Workspace-relative path with FORWARD slashes regardless of OS — GitHub
// annotation file= properties and markdown links require POSIX separators
// (a backslash path silently fails to attach to the file on Windows runners).
function relPosix(from, to) { return relative(from, to).replace(/\\/g, '/'); }
import {
  ConfigError,
  findConfigPath, loadConfig, CONFIG_FILENAME,
  loadOntology, loadArtifacts, buildGraph, gateVerdict, loadResolverPlugins,
} from '../engine/src/index.mjs';

const MARKER = '<!-- canonweave-gate -->';

// ---- workflow-command escaping (GitHub Actions toolkit rules) --------------
function escData(s) { return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'); }
function escProp(s) { return escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C'); }

function annotate({ file, line, title, message }) {
  const props = [];
  if (file) props.push(`file=${escProp(file)}`);
  if (line) props.push(`line=${line}`);
  if (title) props.push(`title=${escProp(title)}`);
  console.log(`::error ${props.join(',')}::${escData(message)}`);
}

function notice(message) { console.log(`::notice::${escData(message)}`); }

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${name}=${value}\n`, 'utf8');
}

function writeSummary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) appendFileSync(f, md + '\n', 'utf8');
}

function fp8(fp) { return fp && fp.startsWith('sha256:') ? fp.slice(7, 15) : (fp || '(unset)'); }

// Line of the reconciled entry for `ingredient` inside the artifact file —
// the exact line a reviewer should look at. Fallback: the reconciled: line, then 1.
function reconciledLine(path, ingredient) {
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const esc = ingredient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entryRe = new RegExp(`^\\s+["']?${esc}["']?:`);
    let inRec = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^reconciled:/.test(l)) { inRec = true; continue; }
      if (inRec) {
        if (!/^\s/.test(l)) inRec = false;
        else if (entryRe.test(l)) return i + 1;
      }
    }
    const idx = lines.findIndex((l) => /^reconciled:/.test(l));
    return idx === -1 ? 1 : idx + 1;
  } catch { return 1; }
}

// ---- report rendering -------------------------------------------------------
function summaryMarkdown({ graph, verdict, byId, workspace }) {
  const L = [];
  L.push(`## Canonweave gate: ${verdict.pass ? '✅ PASS' : '❌ FAIL'} — profile \`${verdict.profile}\``);
  L.push('');
  L.push(`\`${graph.nodes.length}\` nodes · \`${graph.edges.length}\` edges · \`${graph.suspects.length}\` suspect link(s) · \`${verdict.gaps.length}\` gap(s)`);
  L.push('');
  if (graph.suspects.length) {
    L.push('### Suspect ingredient links (upstream changed since last reconcile)');
    L.push('');
    L.push('| downstream | ingredient | reconciled | current | fix |');
    L.push('|---|---|---|---|---|');
    for (const s of graph.suspects) {
      const rec = byId && byId[s.node];
      const file = rec ? relPosix(workspace, rec.path) : '';
      L.push(`| \`${s.node}\`${file ? ` ([file](${file}))` : ''} | \`${s.ingredient}\` | \`${fp8(s.expected)}\` | \`${fp8(s.actual)}\` | \`canonweave reconcile ${s.node}\` |`);
    }
    L.push('');
  }
  if (verdict.gaps.length) {
    L.push(`### Coverage gaps (profile \`${verdict.profile}\`)`);
    L.push('');
    for (const g of verdict.gaps) L.push(`- **${g.type}**${g.id ? ` (\`${g.id}\`)` : ''}: ${g.reason}`);
    L.push('');
  }
  const unresolved = graph.nodes.filter((n) => n.unresolved);
  if (unresolved.length) {
    L.push('### Unresolved sources');
    L.push('');
    for (const n of unresolved) L.push(`- \`${n.id}\` (${n.source && n.source.kind}): ${n.resolveError || 'unresolved'}`);
    L.push('');
  }
  const profiles = Object.keys(graph.gates || {}).sort();
  if (profiles.length > 1) {
    L.push('### All gate profiles');
    L.push('');
    L.push('| profile | verdict |');
    L.push('|---|---|');
    for (const p of profiles) L.push(`| \`${p}\` | ${graph.gates[p].pass ? '✅ PASS' : `❌ FAIL (${graph.gates[p].reasons.length})`} |`);
    L.push('');
  }
  if (!verdict.pass && verdict.reasons.length) {
    L.push('<details><summary>Blocking reasons</summary>');
    L.push('');
    for (const r of verdict.reasons) L.push(`- ${r}`);
    L.push('');
    L.push('</details>');
  }
  return L.join('\n');
}

// ---- sticky PR comment ------------------------------------------------------
async function stickyComment(md) {
  const token = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN;
  const event = process.env.GITHUB_EVENT_NAME;
  const repo = process.env.GITHUB_REPOSITORY;
  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  if (event !== 'pull_request' && event !== 'pull_request_target') {
    return `skipped (event ${event || 'unknown'} has no PR context)`;
  }
  if (!token) return 'skipped (no GITHUB_TOKEN — fork PR or permissions withheld; job summary carries the report)';
  if (!repo) return 'skipped (no GITHUB_REPOSITORY)';
  let prNumber = null;
  try {
    const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    prNumber = (payload.pull_request && payload.pull_request.number) || payload.number || null;
  } catch { /* no payload */ }
  if (!prNumber) return 'skipped (no PR number in event payload)';

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'canonweave-action',
    'content-type': 'application/json',
  };
  const body = `${MARKER}\n${md}`;
  try {
    const listRes = await fetch(`${api}/repos/${repo}/issues/${prNumber}/comments?per_page=100`, {
      headers, signal: AbortSignal.timeout(10000),
    });
    if (!listRes.ok) throw new Error(`list comments: HTTP ${listRes.status}`);
    const comments = await listRes.json();
    const mine = Array.isArray(comments) ? comments.find((c) => c.body && c.body.includes(MARKER)) : null;
    if (mine) {
      const patch = await fetch(`${api}/repos/${repo}/issues/comments/${mine.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ body }), signal: AbortSignal.timeout(10000),
      });
      if (!patch.ok) throw new Error(`update comment: HTTP ${patch.status}`);
      return `updated sticky comment ${mine.id}`;
    }
    const post = await fetch(`${api}/repos/${repo}/issues/${prNumber}/comments`, {
      method: 'POST', headers, body: JSON.stringify({ body }), signal: AbortSignal.timeout(10000),
    });
    if (!post.ok) throw new Error(`create comment: HTTP ${post.status}`);
    const created = await post.json();
    return `created sticky comment ${created.id}`;
  } catch (e) {
    return `skipped (${e.message}) — job summary carries the report`;
  }
}

// ---- main -------------------------------------------------------------------
async function main() {
  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const inputProfile = (process.env.INPUT_PROFILE || '').trim() || null;
  const inputConfig = (process.env.INPUT_CONFIG || '').trim() || null;

  const configPath = inputConfig ? resolve(workspace, inputConfig) : findConfigPath(workspace);
  if (!configPath) {
    throw new ConfigError('TW_CONFIG_NOT_FOUND',
      `no ${CONFIG_FILENAME} found in ${workspace} — run "canonweave init" or set the "config" input`);
  }
  const cfg = loadConfig(configPath);
  const onto = loadOntology(cfg.ontologyPath);
  const plugins = await loadResolverPlugins(cfg.resolverModules);
  const ctx = { repoRoot: cfg.repoRoot, cacheDir: cfg.cacheDir, plugins, defaultProfile: cfg.gateProfile };
  const byId = loadArtifacts(cfg.roots);
  const graph = await buildGraph(onto, byId, ctx);
  const verdict = gateVerdict(graph, inputProfile || undefined);

  // Annotations: suspects on the downstream file's reconciled entry line.
  for (const s of graph.suspects) {
    const rec = byId[s.node];
    const file = rec ? relPosix(workspace, rec.path) : null;
    annotate({
      file, line: rec ? reconciledLine(rec.path, s.ingredient) : 1,
      title: 'Canonweave: suspect ingredient link',
      message: `${s.node} <- ${s.ingredient}: upstream changed since last reconcile ` +
        `(reconciled ${fp8(s.expected)}, current ${fp8(s.actual)}). ` +
        `Fix: canonweave reconcile ${s.node} (then --apply), or canonweave clear ${s.node} ${s.ingredient} if reviewed.`,
    });
  }
  // Annotations: gaps of the ACTIVE profile.
  for (const g of verdict.gaps) {
    const rec = g.id ? byId[g.id] : null;
    annotate({
      file: rec ? relPosix(workspace, rec.path) : null,
      line: rec ? 1 : null,
      title: 'Canonweave: coverage gap',
      message: `${g.type}${g.id ? ` (${g.id})` : ''}: ${g.reason}`,
    });
  }

  const unresolved = graph.nodes.filter((n) => n.unresolved);
  const exitCode = unresolved.length > 0 ? 3 : (verdict.pass ? 0 : 1);

  const md = summaryMarkdown({ graph, verdict, byId, workspace });
  writeSummary(md);
  const commentResult = await stickyComment(md);
  notice(`sticky comment: ${commentResult}`);

  setOutput('result', verdict.pass && exitCode === 0 ? 'pass' : 'fail');
  setOutput('exit-code', String(exitCode));
  setOutput('suspects', String(graph.suspects.length));
  setOutput('gaps', String(verdict.gaps.length));
  setOutput('profile', verdict.profile);

  console.log(`Canonweave gate ${verdict.profile}: ${verdict.pass && exitCode === 0 ? 'PASS' : 'FAIL'} ` +
    `(${graph.suspects.length} suspect(s), ${verdict.gaps.length} gap(s), ${unresolved.length} unresolved)`);
  process.exitCode = exitCode;
}

main().catch((e) => {
  const code = e && e.exitCode ? e.exitCode : 2;
  const label = e.code && String(e.code).startsWith('TW_') ? `${e.code}: ${e.message}` : (e.message || String(e));
  annotate({ title: `Canonweave: ${code === 3 ? 'resolve error' : 'configuration error'}`, message: label });
  writeSummary(`## Canonweave gate: ⚠️ ${code === 3 ? 'RESOLVE ERROR (exit 3)' : 'CONFIG ERROR (exit 2)'}\n\n\`\`\`\n${label}\n\`\`\`\n\nSetup guidance: docs/quickstart.md and docs/file-format.md in the canonweave repo.`);
  setOutput('result', 'fail');
  setOutput('exit-code', String(code));
  process.exitCode = code;
});
