// graph.mjs — load artifacts (multi-root), validate edges, resolve+fingerprint,
// compute suspects, per-profile gate verdicts, and coverage gaps.
// Deterministic: NO clocks, NO randomness; same inputs -> byte-identical graph.
import { readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { knownType, isLegalEdge, requiredTypes, allowedIngredients, profileNames, tierOf } from './ontology.mjs';
import { readRecipeFile } from './recipe.mjs';
import { fingerprint } from './fingerprint.mjs';
import { resolveSource } from './resolve.mjs';
import { ConfigError, ResolveError } from './errors.mjs';

export const GRAPH_FORMAT_VERSION = 1;

function byStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// Files scanned: *.md in each root (non-recursive), excluding README.md.
// Duplicate ids across files/roots are a config error (identity must be unique).
export function loadArtifacts(roots) {
  const byId = {};
  for (const root of roots) {
    if (!existsSync(root)) {
      throw new ConfigError('TW_ROOT_NOT_FOUND', `artifact root not found: ${root}`);
    }
    const files = readdirSync(root)
      .filter((f) => f.endsWith('.md') && basename(f).toLowerCase() !== 'readme.md')
      .sort(byStr);
    for (const f of files) {
      const rec = readRecipeFile(join(root, f));
      const id = rec.data.id;
      if (byId[id]) {
        throw new ConfigError('TW_DUPLICATE_ID',
          `duplicate artifact id "${id}": ${byId[id].path} and ${rec.path}`);
      }
      rec.id = id;
      rec.source = rec.data.source || { kind: 'inline' };
      byId[id] = rec;
    }
  }
  return byId;
}

// Validate ingredient edges against the ontology. Throws ConfigError on the
// FIRST illegal edge / unknown type / unknown ingredient id.
export function validateEdges(onto, byId) {
  const ids = Object.keys(byId).sort(byStr);
  for (const id of ids) {
    const node = byId[id];
    const type = node.data.type;
    if (!knownType(onto, type)) {
      throw new ConfigError('TW_TYPE_UNKNOWN', `unknown artifact type "${type}" on node "${id}" (not in ontology)`);
    }
    const ingredients = (node.data.recipe && node.data.recipe.ingredients) || [];
    for (const ingId of ingredients) {
      const parent = byId[ingId];
      if (!parent) {
        throw new ConfigError('TW_EDGE_UNKNOWN_INGREDIENT',
          `node "${id}" lists ingredient "${ingId}" but no artifact with that id exists`);
      }
      const parentType = parent.data.type;
      if (!isLegalEdge(onto, type, parentType)) {
        throw new ConfigError('TW_EDGE_ILLEGAL',
          `illegal ingredient edge: "${id}" (type ${type}) <- "${ingId}" (type ${parentType}). ` +
          `Allowed ingredient types for ${type}: [${allowedIngredients(onto, type).join(', ')}]`);
      }
    }
  }
}

// Gaps for one profile: (a) required type missing entirely, (b) required node
// still a placeholder, (c) any present node whose source is unresolved (blocks
// every profile — an unresolved record cannot be trusted by any gate).
function gapsForProfile(onto, nodes, profileName) {
  const gaps = [];
  const presentTypes = new Set(nodes.map((n) => n.type));
  for (const reqType of requiredTypes(onto, profileName)) {
    if (!presentTypes.has(reqType)) {
      gaps.push({ type: reqType, reason: 'required type missing entirely' });
    }
  }
  const required = new Set(requiredTypes(onto, profileName));
  for (const n of nodes) {
    if (required.has(n.type) && n.status === 'placeholder') {
      gaps.push({ type: n.type, id: n.id, reason: 'required artifact present as placeholder (status: placeholder)' });
    }
    if (n.status === 'present' && n.unresolved) {
      gaps.push({ type: n.type, id: n.id, reason: `status present but source unresolved (${n.resolveError || 'unresolved'})` });
    }
  }
  gaps.sort((a, b) => byStr(a.type, b.type) || byStr(a.id || '', b.id || '') || byStr(a.reason, b.reason));
  return gaps;
}

function verdictForProfile(onto, nodes, suspects, gaps, profileName) {
  const reasons = [];
  const byType = {};
  for (const n of nodes) (byType[n.type] ||= []).push(n);
  for (const reqType of requiredTypes(onto, profileName)) {
    const present = byType[reqType] || [];
    if (present.length === 0) {
      reasons.push(`missing required type: ${reqType}`);
      continue;
    }
    for (const n of present) {
      if (n.status !== 'present') reasons.push(`${n.id} (${reqType}) is not present (status: ${n.status})`);
      else if (n.unresolved) reasons.push(`${n.id} (${reqType}) source unresolved`);
    }
  }
  if (suspects.length > 0) reasons.push(`${suspects.length} suspect ingredient link(s)`);
  if (gaps.length > 0) reasons.push(`${gaps.length} coverage gap(s)`);
  return { pass: reasons.length === 0, reasons: reasons.sort(byStr) };
}

// Build the full graph object.
// ctx = { repoRoot, cacheDir, plugins?, defaultProfile, fetchImpl?, urlTimeoutMs? }
export async function buildGraph(onto, byId, ctx) {
  validateEdges(onto, byId);

  const ids = Object.keys(byId).sort(byStr);
  const nodes = [];
  const edges = [];
  const fpById = {};

  for (const id of ids) {
    const rec = byId[id];
    const d = rec.data;
    const res = await resolveSource({ id, source: rec.source, body: rec.body }, ctx);
    const fp = fingerprint(res.content);
    fpById[id] = fp;

    const source = { ...(rec.source || { kind: 'inline' }) };
    source.resolver = res.resolver;

    nodes.push({
      id,
      type: d.type,
      tier: tierOf(onto, d.type),
      status: d.status || 'placeholder',
      source,
      fingerprint: fp,
      ingredients: (d.recipe && d.recipe.ingredients) || [],
      reconciled: d.reconciled || {},
      suspectIngredients: [],
      // OSS core: provenance is the EXPLICIT frontmatter binding only
      // (provenance.issue). Heuristic matchers live in private adapters.
      provenance: { issue: (d.provenance && d.provenance.issue != null) ? d.provenance.issue : null },
      unresolved: !!res.unresolved,
      resolveError: res.error || null,
    });
  }

  const suspects = [];
  for (const n of nodes) {
    for (const ingId of n.ingredients) {
      edges.push({ from: ingId, to: n.id });
      const expected = Object.prototype.hasOwnProperty.call(n.reconciled, ingId) ? n.reconciled[ingId] : null;
      const actual = fpById[ingId];
      if (expected !== actual) {
        n.suspectIngredients.push(ingId);
        suspects.push({ node: n.id, ingredient: ingId, expected, actual });
      }
    }
  }
  edges.sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to));
  suspects.sort((a, b) => byStr(a.node, b.node) || byStr(a.ingredient, b.ingredient));

  const defaultProfile = ctx.defaultProfile || profileNames(onto)[0];
  requiredTypes(onto, defaultProfile); // throws TW_ONTOLOGY_UNKNOWN_PROFILE early

  const gates = {};
  for (const p of profileNames(onto)) {
    const gaps = gapsForProfile(onto, nodes, p);
    const verdict = verdictForProfile(onto, nodes, suspects, gaps, p);
    gates[p] = { pass: verdict.pass, reasons: verdict.reasons, gaps };
  }

  return {
    traceweave: GRAPH_FORMAT_VERSION,
    generatedAt: null,          // determinism invariant: no clocks in the graph
    defaultProfile,
    nodes,
    edges,
    suspects,
    gaps: gates[defaultProfile].gaps,
    gates,
  };
}

// Verdict accessor for a profile recorded in a built graph.
export function gateVerdict(graph, profileName) {
  const p = profileName || graph.defaultProfile;
  const g = graph.gates && graph.gates[p];
  if (!g) {
    throw new ConfigError('TW_ONTOLOGY_UNKNOWN_PROFILE',
      `graph has no gate profile "${p}" (profiles: ${Object.keys(graph.gates || {}).sort().join(', ')})`);
  }
  return { profile: p, pass: g.pass, reasons: g.reasons, gaps: g.gaps };
}

// Unresolved nodes -> ResolveError (CLI maps to exit 3, design section 6).
export function assertResolved(graph) {
  const un = graph.nodes.filter((n) => n.unresolved);
  if (un.length > 0) {
    const detail = un.map((n) => `${n.id} (${n.source && n.source.kind}): ${n.resolveError || 'unresolved'}`);
    throw new ResolveError(
      `${un.length} node(s) failed to resolve and have no cache:\n  - ${detail.join('\n  - ')}`,
      un.map((n) => ({ id: n.id, kind: n.source && n.source.kind, error: n.resolveError })));
  }
}
