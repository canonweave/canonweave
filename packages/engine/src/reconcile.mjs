// reconcile.mjs — the local reconcile loop: DRAFT (an agent or template drafts
// the corrected downstream artifact into a proposal file) then APPLY (write the
// draft into the artifact, clear the suspect links, rebuild).
//
// Proposals live at <repoRoot>/.traceweave/proposals/<id>.proposal.md — review
// artifacts, safe to commit. The proposal header carries the ONLY timestamp the
// engine ever emits; it never enters graph.json (determinism invariant).
// GitHub reconcile-PR mechanics (idempotent branch keys etc.) ship in WS3.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './recipe.mjs';
import { fingerprint } from './fingerprint.mjs';
import { resolveSource } from './resolve.mjs';
import { buildGraph } from './graph.mjs';
import { draft as runDrafter, buildDraftPrompt } from './drafter.mjs';
import { ConfigError } from './errors.mjs';

export function proposalsDir(repoRoot) { return join(repoRoot, '.traceweave', 'proposals'); }
export function proposalPath(repoRoot, id) { return join(proposalsDir(repoRoot), `${id}.proposal.md`); }

function suspectLinksFor(graph, downstreamId) {
  return graph.suspects.filter((sp) => sp.node === downstreamId);
}

async function resolveContent(rec, ctx) {
  return resolveSource({ id: rec.id, source: rec.data.source || { kind: 'inline' }, body: rec.body }, ctx);
}

function renderProposal({ downstream, suspects, backend, kind, content, briefPrompt }) {
  const H = [];
  H.push('---');
  H.push(`proposal_for: ${downstream.id}`);
  H.push(`downstream_type: ${downstream.type}`);
  H.push(`drafter_backend: ${backend}`);
  H.push(`kind: ${kind}`); // draft | brief
  H.push(`suspect_ingredients: [${suspects.map((sp) => sp.ingredient).join(', ')}]`);
  H.push('fingerprints_old:');
  for (const sp of suspects) H.push(`  ${sp.ingredient}: ${sp.expected || '(unset)'}`);
  H.push('fingerprints_new:');
  for (const sp of suspects) H.push(`  ${sp.ingredient}: ${sp.actual || '(unknown)'}`);
  H.push(`generated_at: ${new Date().toISOString()}`); // proposal-only; NOT in graph.json
  H.push('---');
  H.push('');
  if (kind === 'draft') {
    H.push(`<!-- Drafted by the ${backend} backend. Review, then apply with:`);
    H.push(`     traceweave reconcile ${downstream.id} --apply -->`);
    H.push('');
    H.push(content.trimEnd());
    H.push('');
  } else {
    H.push(`# Reconcile brief — ${downstream.id}`);
    H.push('');
    H.push(`No draft was produced (backend/CLI unavailable or brief mode), so this is a`);
    H.push(`CONCRETE brief instead of an auto-draft. It carries the full context an agent`);
    H.push(`(or a human) needs to re-derive **${downstream.id}**, after which the corrected`);
    H.push(`content can be applied and the link cleared (\`traceweave clear\`).`);
    H.push('');
    H.push('```');
    H.push(briefPrompt.trimEnd());
    H.push('```');
    H.push('');
  }
  return H.join('\n');
}

// DRAFT phase. Returns a summary object; writes the proposal file.
// cfg: loaded config. onto: loaded ontology. byId: loaded artifacts. ctx: resolver ctx.
export async function reconcileDraft({ cfg, onto, byId, ctx, id }) {
  if (!byId[id]) throw new ConfigError('TW_NO_SUCH_ARTIFACT', `reconcile: no artifact "${id}"`);
  const graph = await buildGraph(onto, byId, ctx);
  const suspects = suspectLinksFor(graph, id);
  if (suspects.length === 0) {
    return { drafted: false, suspects: [], message: `no suspect links for ${id} — nothing to reconcile (every ingredient is fresh).` };
  }

  const dnode = graph.nodes.find((n) => n.id === id);
  const drec = byId[id];
  const dtitle = (drec.data && drec.data.title) || id;
  const dbuild = (drec.data && drec.data.recipe && drec.data.recipe.build) || '';
  const downstreamCurrent = (await resolveContent(drec, ctx)).content;

  // Prefer a present/resolvable upstream so the drafter gets real content.
  const primary = suspects.find((sp) => {
    const up = graph.nodes.find((n) => n.id === sp.ingredient);
    return up && up.status === 'present' && !up.unresolved;
  }) || suspects[0];

  const upId = primary.ingredient;
  const upNode = graph.nodes.find((n) => n.id === upId);
  const urec = byId[upId];
  const utitle = (urec && urec.data && urec.data.title) || upId;
  const upContent = urec ? (await resolveContent(urec, ctx)).content : '';

  const req = {
    downstream: { id, type: dnode.type, title: dtitle, build: dbuild },
    upstream: {
      id: upId, type: upNode ? upNode.type : '(unknown)', title: utitle,
      fingerprintOld: primary.expected || '(unset)',
      fingerprintNew: primary.actual || (upNode && upNode.fingerprint) || '(unknown)',
      content: upContent,
    },
    downstreamCurrent,
  };

  const result = await runDrafter(req, cfg.drafter);

  const dir = proposalsDir(cfg.repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = renderProposal({
    downstream: req.downstream,
    suspects,
    backend: result.backend,
    kind: result.kind,
    content: result.kind === 'draft' ? result.content : null,
    briefPrompt: result.kind === 'brief' ? buildDraftPrompt(req) : null,
  });
  const ppath = proposalPath(cfg.repoRoot, id);
  writeFileSync(ppath, out, 'utf8');

  return {
    drafted: result.kind === 'draft',
    kind: result.kind,
    backend: result.backend,
    error: result.error || null,
    suspects,
    upstream: { id: upId, from: primary.expected || '(unset)', to: primary.actual },
    proposalPath: ppath,
    content: result.kind === 'draft' ? result.content : null,
  };
}

// Read a proposal file back. Returns { kind, backend, suspectIngredients, draftBody, ppath }.
export function readProposal(repoRoot, id) {
  const ppath = proposalPath(repoRoot, id);
  if (!existsSync(ppath)) {
    throw new ConfigError('TW_NO_PROPOSAL',
      `reconcile --apply: no proposal for "${id}" — run "traceweave reconcile ${id}" first`);
  }
  const text = readFileSync(ppath, 'utf8');
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (e) {
    throw new ConfigError('TW_PROPOSAL_PARSE',
      `reconcile --apply: proposal for "${id}" has unreadable frontmatter (${e.message}) — ` +
      `re-run "traceweave reconcile ${id}" to regenerate it`);
  }
  const { data, body } = parsed;
  const kind = (data && data.kind) || 'draft';
  const backend = (data && data.drafter_backend) || 'unknown';
  const ings = (data && Array.isArray(data.suspect_ingredients))
    ? data.suspect_ingredients.map((x) => String(x))
    : [];
  if (kind !== 'draft') return { kind, backend, suspectIngredients: ings, draftBody: null, ppath };
  const draftBody = body.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
  return { kind, backend, suspectIngredients: ings, draftBody, ppath };
}

// APPLY phase: write the drafted content into the artifact (inline body, or the
// managed cache file for non-inline kinds), flip placeholder -> present, clear
// the suspect links, rebuild the graph. Returns { cleared, graph }.
export async function reconcileApply({ cfg, onto, ctx, id, loadArtifacts }) {
  const prop = readProposal(cfg.repoRoot, id);
  if (prop.kind !== 'draft' || !prop.draftBody) {
    throw new ConfigError('TW_PROPOSAL_IS_BRIEF',
      `reconcile --apply: proposal for "${id}" is a BRIEF (no auto-draft to apply). ` +
      `Paste corrected content into the artifact (or re-run reconcile with a working drafter), then clear the link.`);
  }

  let byId = loadArtifacts(cfg.roots);
  const rec = byId[id];
  if (!rec) throw new ConfigError('TW_NO_SUCH_ARTIFACT', `reconcile --apply: no artifact "${id}"`);

  const { data, body } = parseFrontmatter(readFileSync(rec.path, 'utf8'));
  const kind = (data.source && data.source.kind) || 'inline';

  if (kind === 'inline') {
    const newBody = '\n' + prop.draftBody.trim() + '\n';
    if (data.status === 'placeholder') data.status = 'present';
    writeFileSync(rec.path, serializeFrontmatter(data, newBody), 'utf8');
  } else {
    if (!existsSync(ctx.cacheDir)) mkdirSync(ctx.cacheDir, { recursive: true });
    writeFileSync(join(ctx.cacheDir, `${id}.content`), prop.draftBody.trim() + '\n', 'utf8');
    if (data.status === 'placeholder') data.status = 'present';
    writeFileSync(rec.path, serializeFrontmatter(data, body), 'utf8');
  }

  // Clear the suspect link(s): reconciled[ingredient] = ingredient's CURRENT fingerprint.
  byId = loadArtifacts(cfg.roots);
  const { data: data2, body: body2 } = parseFrontmatter(readFileSync(byId[id].path, 'utf8'));
  data2.reconciled = data2.reconciled || {};
  const cleared = [];
  for (const ing of prop.suspectIngredients) {
    const ingRec = byId[ing];
    if (!ingRec) { cleared.push({ ing, skipped: `ingredient "${ing}" not found` }); continue; }
    const ingRes = await resolveContent(ingRec, ctx);
    const fp = fingerprint(ingRes.content);
    const prev = data2.reconciled[ing];
    data2.reconciled[ing] = fp;
    cleared.push({ ing, prev: prev || '(unset)', fp });
  }
  writeFileSync(byId[id].path, serializeFrontmatter(data2, body2), 'utf8');

  byId = loadArtifacts(cfg.roots);
  const graph = await buildGraph(onto, byId, ctx);
  return { cleared, graph, proposalBackend: prop.backend };
}
