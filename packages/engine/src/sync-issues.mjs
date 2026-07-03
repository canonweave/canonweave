// sync-issues.mjs — WS4 work plane (design §8): project the artifact graph
// into GitHub's native work surfaces. STRICTLY ONE-WAY: files -> GitHub.
//
//   - one issue per artifact (create/update): title, artifact type as native
//     issue type (best-effort — falls back to a `canonweave:type:*` label when
//     the org lacks the type), tier + board status as labels, body links to
//     the file and shows current state
//   - derivation edges mirrored as sub-issue relations (GitHub allows ONE
//     parent per issue; the graph is a DAG, so when an upstream feeds several
//     downstreams the FIRST downstream in sorted-id order claims parenthood —
//     deterministic — and the remaining edges stay as body links)
//   - a Projects v2 board (GraphQL) with a single-select "canonweave-status"
//     field: fresh | suspect | gap | placeholder. The Actions GITHUB_TOKEN
//     cannot touch Projects v2, so this phase runs only when a token with
//     project scope is available (CANONWEAVE_PROJECTS_TOKEN, falling back to
//     GITHUB_TOKEN for local runs with a user token) and DEGRADES to a clear
//     skip line otherwise — issues/sub-issues still sync.
//
// Convergence contract (the tests pin all of these):
//   - issue edits never mutate files; the next sync overwrites the projection
//   - issue deletion never deletes artifacts; the next sync re-creates the
//     issue and re-binds the anchor
//   - the ONLY file write is the binding anchor `provenance.issue` in the
//     artifact frontmatter on first projection (frontmatter is hash-safe:
//     fingerprints cover the body only — docs/file-format.md)
//   - re-run with no drift performs ZERO GitHub writes (drift-diffed PATCHes)
//
// Rate limits: writes only on drift, bounded retries with exponential backoff
// (CANONWEAVE_BACKOFF_MS tunes the base; the selftest sets it to 1ms).
import { writeFileSync } from 'node:fs';
import { ConfigError } from './errors.mjs';
import { serializeFrontmatter } from './recipe.mjs';

export const SYNC_MARKER = (id) => `<!-- canonweave-sync:${id} -->`;
const MANAGED_LABEL = 'canonweave';
const STATUS_LABELS = ['fresh', 'suspect', 'gap', 'placeholder'];
const STATUS_FIELD = 'canonweave-status';

// Board status per node (precedence): placeholder > gap(unresolved) > suspect > fresh.
export function boardStatus(node) {
  if (node.status === 'placeholder') return 'placeholder';
  if (node.unresolved) return 'gap';
  if ((node.suspectIngredients || []).length > 0) return 'suspect';
  return 'fresh';
}

function fp8(fp) { return fp && String(fp).startsWith('sha256:') ? fp.slice(7, 15) : 'unknown0'; }

// Deterministic issue body — NO timestamps, so an unchanged graph produces a
// byte-identical body and the drift diff sees "no change".
export function issueBodyFor(node, rec, { serverUrl, repo, refName, repoRoot }) {
  // POSIX separators regardless of host OS — the link and the display path are
  // GitHub-side surfaces (the WS5 Windows lesson: never ship win32 separators).
  const rel = (rec.path.startsWith(repoRoot) ? rec.path.slice(repoRoot.length + 1) : rec.path)
    .split('\\').join('/');
  const fileUrl = `${serverUrl}/${repo}/blob/${refName}/${rel}`;
  const status = boardStatus(node);
  const lines = [
    SYNC_MARKER(node.id),
    `## \`${node.id}\` — ${rec.data.title || node.id}`,
    ``,
    `**The file is the record.** This issue is a one-way projection managed by`,
    `\`canonweave sync-issues\`; edits here are overwritten on the next sync.`,
    ``,
    `| | |`,
    `|---|---|`,
    `| file | [\`${rel}\`](${fileUrl}) |`,
    `| type | \`${node.type}\` (tier \`${node.tier}\`) |`,
    `| board status | \`${status}\` |`,
    `| fingerprint | \`${fp8(node.fingerprint)}\` |`,
    `| artifact status | \`${node.status}\` |`,
  ];
  if ((node.ingredients || []).length) {
    lines.push(`| ingredients | ${node.ingredients.map((i) => `\`${i}\``).join(', ')} |`);
  }
  if ((node.suspectIngredients || []).length) {
    lines.push(``, `### Suspect ingredients (upstream changed since last reconcile)`, ``);
    for (const s of node.suspectIngredients) lines.push(`- \`${s}\``);
  }
  if (node.unresolved) {
    lines.push(``, `> gap: source unresolved${node.resolveError ? ` — ${node.resolveError}` : ''}`);
  }
  return lines.join('\n');
}

export function desiredLabels(node) {
  return [MANAGED_LABEL, `canonweave:type:${node.type}`, `tier:${node.tier}`, `status:${boardStatus(node)}`];
}

// Merge: keep every non-canonweave-managed label the humans added; replace the
// managed set. Managed = the marker, canonweave:type:*, tier:*, status:*.
function mergeLabels(current, desired) {
  const managed = (l) => l === MANAGED_LABEL || l.startsWith('canonweave:type:') || l.startsWith('tier:') || l.startsWith('status:');
  const kept = (current || []).filter((l) => !managed(l));
  return [...new Set([...kept, ...desired])].sort();
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Bounded-retry fetch: retries 5xx and 403-rate-limit; other statuses return.
async function callWithRetry(doCall, { backoffMs, tries = 3 }) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await doCall();
    const retriable = last.status >= 500 || (last.status === 403 && /rate limit/i.test(JSON.stringify(last.json || '')));
    if (!retriable) return last;
    if (i < tries - 1) await sleep(backoffMs * Math.pow(2, i));
  }
  return last;
}

function restClient(env) {
  const token = env.GITHUB_TOKEN || env.INPUT_GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const backoffMs = Number(env.CANONWEAVE_BACKOFF_MS || 1500);
  if (!token) throw new ConfigError('TW_SYNC_TOKEN', 'sync-issues: no GITHUB_TOKEN in the environment');
  if (!repo) throw new ConfigError('TW_SYNC_REPO', 'sync-issues: no GITHUB_REPOSITORY in the environment (owner/repo)');
  const call = (method, path, body) => callWithRetry(async () => {
    const res = await fetch(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, ok: res.ok, json };
  }, { backoffMs });
  return { token, repo, api, backoffMs, call };
}

async function graphqlClient(env, fallbackToken) {
  const token = env.CANONWEAVE_PROJECTS_TOKEN || fallbackToken;
  const url = env.GITHUB_GRAPHQL_URL || `${(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '')}/graphql`;
  const backoffMs = Number(env.CANONWEAVE_BACKOFF_MS || 1500);
  const run = (query, variables) => callWithRetry(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, ok: res.ok && !(json && json.errors && json.errors.length), json };
  }, { backoffMs });
  return { token, url, run };
}

// ---- issues phase -----------------------------------------------------------
async function ensureIssue({ gh, node, rec, urls, summary, log }) {
  const desiredBody = issueBodyFor(node, rec, urls);
  const desiredTitle = `${rec.data.title || node.id} [${node.id}]`;
  const labels = desiredLabels(node);
  const bound = node.provenance && node.provenance.issue != null ? Number(node.provenance.issue) : null;

  let current = null;
  if (bound != null) {
    const r = await gh.call('GET', `/issues/${bound}`);
    if (r.ok && r.json && !r.json.pull_request) current = r.json;
    // 404 / 410 (deleted) / a PR wearing the number -> projection lost, re-create below
  }

  if (!current) {
    const create = { title: desiredTitle, body: desiredBody, labels, type: node.type };
    let r = await gh.call('POST', '/issues', create);
    if (r.status === 422) {
      // org may not define this issue type — retry without the native type
      const { type: _drop, ...noType } = create;
      r = await gh.call('POST', '/issues', noType);
      if (r.ok) summary.typeFallbacks.push(node.type);
    }
    if (!r.ok) throw new ConfigError('TW_SYNC_FAILED', `sync-issues: create failed for "${node.id}" (HTTP ${r.status})`);
    summary.created.push(node.id);
    log(`  created #${r.json.number} <- ${node.id}${bound != null ? ` (rebound; #${bound} was gone)` : ''}`);
    return { issue: r.json, rebind: true };
  }

  // drift diff — write only what changed
  const patch = {};
  if (current.title !== desiredTitle) patch.title = desiredTitle;
  if ((current.body || '').trim() !== desiredBody.trim()) patch.body = desiredBody;
  const currentLabels = (current.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const merged = mergeLabels(currentLabels, labels);
  if (JSON.stringify([...currentLabels].sort()) !== JSON.stringify(merged)) patch.labels = merged;
  if (current.state !== 'open') patch.state = 'open'; // artifacts live; the projection stays open
  const currentType = current.type && current.type.name;
  // only correct a WRONG existing type — when the org lacks the type entirely
  // (currentType null after the create-time 422 fallback), the canonweave:type:*
  // label carries the typing and re-PATCHing would 422 on every run.
  if (currentType != null && currentType !== node.type) patch.type = node.type;

  if (Object.keys(patch).length === 0) {
    summary.unchanged.push(node.id);
    return { issue: current, rebind: false };
  }
  let r = await gh.call('PATCH', `/issues/${current.number}`, patch);
  if (r.status === 422 && patch.type !== undefined) {
    const { type: _drop, ...noType } = patch;
    r = Object.keys(noType).length ? await gh.call('PATCH', `/issues/${current.number}`, noType) : { ok: true, json: current };
    if (r.ok) summary.typeFallbacks.push(node.type);
  }
  if (!r.ok) throw new ConfigError('TW_SYNC_FAILED', `sync-issues: update failed for "${node.id}" #${current.number} (HTTP ${r.status})`);
  summary.updated.push(node.id);
  log(`  updated #${current.number} <- ${node.id} (${Object.keys(patch).join(', ')})`);
  return { issue: r.json || current, rebind: false };
}

// Anchor write — the one sanctioned file mutation (frontmatter only).
function writeAnchor(rec, issueNumber) {
  const data = rec.data;
  data.provenance = { ...(data.provenance || {}), issue: issueNumber };
  writeFileSync(rec.path, serializeFrontmatter(data, rec.body), 'utf8');
}

// ---- sub-issues phase --------------------------------------------------------
// One parent per issue (GitHub constraint). Deterministic: iterate downstream
// nodes in sorted-id order; each claims its not-yet-parented ingredients.
async function syncSubIssues({ gh, ordered, issueByNode, summary, log }) {
  const parented = new Set(); // NODE IDS that already have a parent (seen server-side or claimed this run)
  const numberToId = new Map([...issueByNode].map(([id, issue]) => [issue.number, id]));
  for (const node of ordered) {
    const parentIssue = issueByNode.get(node.id);
    if (!parentIssue || !(node.ingredients || []).length) continue;
    const r = await gh.call('GET', `/issues/${parentIssue.number}/sub_issues`);
    const existing = new Set(((r.ok && r.json) || []).filter((s) => s && s.number != null).map((s) => s.number));
    for (const childNumber of existing) {
      const childId = numberToId.get(childNumber);
      if (childId) parented.add(childId); // this child already has a parent server-side
    }
    for (const ingId of node.ingredients) {
      const childIssue = issueByNode.get(ingId);
      if (!childIssue) continue;
      if (existing.has(childIssue.number)) continue;               // already linked here
      if (parented.has(ingId)) { summary.edgesBodyOnly++; continue; } // someone else's child
      const add = await gh.call('POST', `/issues/${parentIssue.number}/sub_issues`, { sub_issue_id: childIssue.id });
      if (add.ok) {
        parented.add(ingId);
        summary.subIssuesAdded++;
        log(`  sub-issue: #${childIssue.number} (${ingId}) -> parent #${parentIssue.number} (${node.id})`);
      } else if (add.status === 422) {
        summary.edgesBodyOnly++; // already has a parent server-side — body link carries the edge
      } else {
        throw new ConfigError('TW_SYNC_FAILED', `sync-issues: sub-issue link ${ingId} -> ${node.id} failed (HTTP ${add.status})`);
      }
    }
  }
}

// ---- Projects v2 phase (GraphQL; optional by token) ---------------------------
const Q_OWNER = `query CwOwner($login:String!){ repositoryOwner(login:$login){ __typename id } }`;
const Q_FIND = `query CwFindProject($login:String!,$q:String!){ repositoryOwner(login:$login){ projectsV2(first:20, query:$q){ nodes { id title number } } } }`;
const M_CREATE = `mutation CwCreateProject($ownerId:ID!,$title:String!){ createProjectV2(input:{ownerId:$ownerId,title:$title}){ projectV2 { id number } } }`;
const Q_FIELDS = `query CwFields($id:ID!){ node(id:$id){ ... on ProjectV2 { fields(first:50){ nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }`;
const M_FIELD = `mutation CwCreateField($projectId:ID!,$name:String!,$opts:[ProjectV2SingleSelectFieldOptionInput!]!){ createProjectV2Field(input:{projectId:$projectId,dataType:SINGLE_SELECT,name:$name,singleSelectOptions:$opts}){ projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } } } }`;
const Q_ITEMS = `query CwItems($id:ID!,$after:String){ node(id:$id){ ... on ProjectV2 { items(first:100, after:$after){ pageInfo { hasNextPage endCursor } nodes { id fieldValueByName(name:"${STATUS_FIELD}"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } content { ... on Issue { number } } } } } } }`;
const M_ADD = `mutation CwAddItem($projectId:ID!,$contentId:ID!){ addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){ item { id } } }`;
const M_SET = `mutation CwSetStatus($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){ updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){ projectV2Item { id } } }`;

async function syncProject({ gql, repo, ordered, issueByNode, summary, log }) {
  const [login] = repo.split('/');
  const title = `canonweave: ${repo.split('/')[1]}`;

  const owner = await gql.run(Q_OWNER, { login });
  if (!owner.ok) { summary.projectSkipped = `no Projects v2 access (HTTP ${owner.status}${owner.json && owner.json.errors ? ' — ' + owner.json.errors[0].message : ''})`; return; }
  const ownerId = owner.json.data.repositoryOwner.id;

  const found = await gql.run(Q_FIND, { login, q: title });
  if (!found.ok) {
    const why = found.json && found.json.errors ? found.json.errors[0].message : `HTTP ${found.status}`;
    summary.projectSkipped = `no Projects v2 access (${why}) — set CANONWEAVE_PROJECTS_TOKEN to sync the board`;
    return;
  }
  let project = (found.json.data.repositoryOwner.projectsV2.nodes || []).find((p) => p.title === title) || null;
  if (!project) {
    const created = await gql.run(M_CREATE, { ownerId, title });
    if (!created.ok) { summary.projectSkipped = `cannot create project (${created.json && created.json.errors ? created.json.errors[0].message : 'HTTP ' + created.status})`; return; }
    project = created.json.data.createProjectV2.projectV2;
    summary.projectCreated = true;
    log(`  project created: "${title}" (#${project.number})`);
  }

  // status field (single-select, 4 options)
  const fields = await gql.run(Q_FIELDS, { id: project.id });
  if (!fields.ok) { summary.projectSkipped = 'field lookup failed'; return; }
  let field = (fields.json.data.node.fields.nodes || []).find((f) => f && f.name === STATUS_FIELD) || null;
  if (!field) {
    const opts = STATUS_LABELS.map((n) => ({ name: n, color: n === 'fresh' ? 'GREEN' : n === 'suspect' ? 'YELLOW' : n === 'gap' ? 'RED' : 'GRAY', description: '' }));
    const created = await gql.run(M_FIELD, { projectId: project.id, name: STATUS_FIELD, opts });
    if (!created.ok) { summary.projectSkipped = 'cannot create status field'; return; }
    field = created.json.data.createProjectV2Field.projectV2Field;
  }
  const optionId = Object.fromEntries(field.options.map((o) => [o.name, o.id]));

  // current items (paged) — issue number -> { itemId, statusName }
  const byNumber = new Map();
  let after = null;
  do {
    const page = await gql.run(Q_ITEMS, { id: project.id, after });
    if (!page.ok) { summary.projectSkipped = 'items lookup failed'; return; }
    const items = page.json.data.node.items;
    for (const it of items.nodes) {
      if (it.content && it.content.number != null) {
        byNumber.set(it.content.number, { itemId: it.id, status: it.fieldValueByName ? it.fieldValueByName.name : null });
      }
    }
    after = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (after);

  for (const node of ordered) {
    const issue = issueByNode.get(node.id);
    if (!issue) continue;
    const want = boardStatus(node);
    let item = byNumber.get(issue.number);
    if (!item) {
      const added = await gql.run(M_ADD, { projectId: project.id, contentId: issue.node_id });
      if (!added.ok) throw new ConfigError('TW_SYNC_FAILED', `sync-issues: project add failed for "${node.id}"`);
      item = { itemId: added.json.data.addProjectV2ItemById.item.id, status: null };
      summary.projectItemsAdded++;
    }
    if (item.status !== want) {
      const set = await gql.run(M_SET, { projectId: project.id, itemId: item.itemId, fieldId: field.id, optionId: optionId[want] });
      if (!set.ok) throw new ConfigError('TW_SYNC_FAILED', `sync-issues: status set failed for "${node.id}"`);
      summary.projectStatusSet++;
      log(`  board: ${node.id} -> ${want}`);
    }
  }
  summary.projectSynced = `"${title}" #${project.number}`;
}

// ---- entry --------------------------------------------------------------------
export async function syncIssues({ cfg, byId, graph, env = process.env, log = console.log }) {
  if (!cfg.sync.issues) {
    throw new ConfigError('TW_SYNC_DISABLED',
      'sync-issues: disabled — set "sync:\\n  issues: true" in canonweave.yml to project this graph to GitHub');
  }
  const gh = restClient(env);
  const urls = {
    serverUrl: (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, ''),
    repo: gh.repo,
    refName: env.GITHUB_REF_NAME || 'main',
    repoRoot: cfg.repoRoot,
  };
  const summary = {
    created: [], updated: [], unchanged: [], anchorsWritten: [], typeFallbacks: [],
    subIssuesAdded: 0, edgesBodyOnly: 0,
    projectCreated: false, projectItemsAdded: 0, projectStatusSet: 0, projectSynced: null, projectSkipped: null,
  };

  const ordered = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const issueByNode = new Map();

  log(`sync-issues: projecting ${ordered.length} artifacts -> ${gh.repo} (one-way, files are the record)`);
  for (const node of ordered) {
    const rec = byId[node.id];
    if (!rec) continue;
    const { issue, rebind } = await ensureIssue({ gh, node, rec, urls, summary, log });
    issueByNode.set(node.id, issue);
    const boundNow = rec.data.provenance && rec.data.provenance.issue != null ? Number(rec.data.provenance.issue) : null;
    if (rebind || boundNow !== issue.number) {
      writeAnchor(rec, issue.number);
      summary.anchorsWritten.push(node.id);
      log(`  anchor: provenance.issue = ${issue.number} -> ${node.id}`);
    }
  }

  await syncSubIssues({ gh, ordered, issueByNode, summary, log });
  const gql = await graphqlClient(env, gh.token);
  await syncProject({ gql, repo: gh.repo, ordered, issueByNode, summary, log });

  const line = `sync ok — created ${summary.created.length}, updated ${summary.updated.length}, ` +
    `unchanged ${summary.unchanged.length}, anchors ${summary.anchorsWritten.length}, ` +
    `sub-issues +${summary.subIssuesAdded} (${summary.edgesBodyOnly} body-only), ` +
    (summary.projectSynced ? `board ${summary.projectSynced} (+${summary.projectItemsAdded} items, ${summary.projectStatusSet} status writes)` :
      `board skipped: ${summary.projectSkipped || 'unknown'}`);
  log(line);
  if (summary.typeFallbacks.length) {
    log(`  note: native issue types unavailable for: ${[...new Set(summary.typeFallbacks)].join(', ')} — the canonweave:type:* labels carry the typing`);
  }
  return summary;
}
