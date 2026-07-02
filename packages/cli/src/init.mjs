// init.mjs — `traceweave init --template <name>`: copy a template into the
// target directory, then auto-reconcile every ingredient link so the fresh
// skeleton starts green (reconciled fingerprints match the template content —
// deterministic, since template content is fixed).
import { readFileSync, writeFileSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError, CONFIG_FILENAME, loadConfig, loadOntology, loadArtifacts,
  buildGraph, parseFrontmatter, serializeFrontmatter, resolveSource, fingerprint,
} from '../../engine/src/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// monorepo layout: packages/cli/src -> ../../../templates
export const TEMPLATES_DIR = resolve(__dirname, '..', '..', '..', 'templates');

export function availableTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// Fill reconciled{} of every artifact with its ingredients' CURRENT fingerprints.
async function autoReconcile(cfg, onto, ctx) {
  const byId = loadArtifacts(cfg.roots);
  const fpById = {};
  for (const id of Object.keys(byId).sort()) {
    const rec = byId[id];
    const res = await resolveSource({ id, source: rec.data.source || { kind: 'inline' }, body: rec.body }, ctx);
    fpById[id] = fingerprint(res.content);
  }
  for (const id of Object.keys(byId).sort()) {
    const rec = byId[id];
    const ingredients = (rec.data.recipe && rec.data.recipe.ingredients) || [];
    if (ingredients.length === 0) continue;
    const { data, body } = parseFrontmatter(readFileSync(rec.path, 'utf8'));
    data.reconciled = {};
    for (const ing of ingredients) data.reconciled[ing] = fpById[ing];
    writeFileSync(rec.path, serializeFrontmatter(data, body), 'utf8');
  }
}

export async function runInit({ template, dir }) {
  const targetDir = resolve(dir || process.cwd());
  const templateName = template || 'generic-software';
  const src = join(TEMPLATES_DIR, templateName);
  if (!existsSync(src)) {
    throw new ConfigError('TW_INIT_NO_TEMPLATE',
      `unknown template "${templateName}" (available: ${availableTemplates().join(', ') || '(none found)'})`);
  }
  const targetConfig = join(targetDir, CONFIG_FILENAME);
  if (existsSync(targetConfig)) {
    throw new ConfigError('TW_INIT_EXISTS', `${targetConfig} already exists — refusing to overwrite an initialized repo`);
  }
  try {
    cpSync(src, targetDir, { recursive: true, force: false, errorOnExist: true });
  } catch (e) {
    throw new ConfigError('TW_INIT_COPY', `template copy failed (a template file already exists in the target?): ${e.message}`);
  }

  const cfg = loadConfig(targetConfig);
  const onto = loadOntology(cfg.ontologyPath);
  const ctx = { repoRoot: cfg.repoRoot, cacheDir: cfg.cacheDir, plugins: new Map(), defaultProfile: cfg.gateProfile };
  await autoReconcile(cfg, onto, ctx);
  const byId = loadArtifacts(cfg.roots);
  const graph = await buildGraph(onto, byId, ctx);
  writeFileSync(cfg.graphPath, JSON.stringify(graph, null, 2) + '\n', 'utf8');

  return { targetDir, templateName, cfg, graph };
}
