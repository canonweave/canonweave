#!/usr/bin/env node
// canonweave — CLI verb router. Exit-code contract (design section 6):
//   0 pass · 1 gate fail · 2 config/ontology error · 3 resolve error without cache
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT, ConfigError, ResolveError,
  findConfigPath, loadConfig, CONFIG_FILENAME,
  loadOntology, loadArtifacts, buildGraph, gateVerdict, assertResolved,
  renderCheck, renderGate,
  resolveSource, fingerprint, loadResolverPlugins,
  parseFrontmatter, serializeFrontmatter,
  reconcileDraft, reconcileApply,
} from '../../engine/src/index.mjs';
import { runInit, availableTemplates } from '../src/init.mjs';
import { runSelftest } from '../src/selftest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    'canonweave — GitHub-native artifact traceability (files are the system of record)',
    '',
    'USAGE: canonweave <verb> [args] [--config <path-to-canonweave.yml>]',
    '',
    'VERBS:',
    '  init [--template <name>] [--dir <path>]',
    '                                 Scaffold a repo from a template (default: generic-software),',
    '                                 auto-reconcile links, write the first graph.json.',
    '  build                          Resolve+fingerprint all artifacts, validate edges, compute',
    '                                 suspects + per-profile gate verdicts, write graph.json.',
    '  check                          Human-readable suspect + coverage report (exit 0 unless',
    '                                 the repo itself is misconfigured).',
    '  gate [--profile <name>]        Gate verdict for a profile (default from canonweave.yml).',
    '                                 exit 0 PASS / 1 FAIL / 2 config error / 3 resolve error.',
    '  fingerprint <id>               Resolve one node and print its sha256 fingerprint.',
    '  clear <id> <ingredient>        Mark an ingredient link reconciled to its current fingerprint.',
    '  reconcile <id>                 DRAFT the corrected downstream artifact -> .canonweave/proposals/.',
    '  reconcile <id> --apply         APPLY the draft, clear the suspect link(s), rebuild graph.json.',
    '  selftest                       Hermetic deterministic self-test (template drafter, no network).',
    '  sync-issues                    (ships in WS4 — Issues/Projects projection)',
    '  serve                          (ships in WS6 — local read-only dashboard)',
    '',
    `Config: nearest ${CONFIG_FILENAME} upward from cwd, or --config <path>.`,
    'Docs: docs/quickstart.md · docs/file-format.md · docs/gate-profiles.md',
  ].join('\n');
}

function popFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return { args, value: null };
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new ConfigError('TW_CLI_USAGE', `${name} requires a value`);
  }
  return { args: [...args.slice(0, i), ...args.slice(i + 2)], value };
}

function hasFlag(args, name) {
  const i = args.indexOf(name);
  return { args: i === -1 ? args : [...args.slice(0, i), ...args.slice(i + 1)], present: i !== -1 };
}

function getConfig(configFlag) {
  const path = configFlag || findConfigPath(process.cwd());
  if (!path) {
    throw new ConfigError('TW_CONFIG_NOT_FOUND',
      `no ${CONFIG_FILENAME} found from ${process.cwd()} upward — run "canonweave init" or pass --config`);
  }
  return loadConfig(path);
}

async function makeCtx(cfg) {
  const plugins = await loadResolverPlugins(cfg.resolverModules);
  return { repoRoot: cfg.repoRoot, cacheDir: cfg.cacheDir, plugins, defaultProfile: cfg.gateProfile };
}

async function computeGraph(cfg) {
  const onto = loadOntology(cfg.ontologyPath);
  const ctx = await makeCtx(cfg);
  const byId = loadArtifacts(cfg.roots);
  const graph = await buildGraph(onto, byId, ctx);
  return { onto, ctx, byId, graph };
}

async function doBuild(cfg) {
  const { graph } = await computeGraph(cfg);
  writeFileSync(cfg.graphPath, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  const rel = cfg.graphPath.startsWith(cfg.repoRoot) ? cfg.graphPath.slice(cfg.repoRoot.length + 1) : cfg.graphPath;
  console.log(
    `build ok — ${graph.nodes.length} nodes, ${graph.edges.length} edges, ` +
    `${graph.suspects.length} suspects, ${graph.gaps.length} gaps (profile ${graph.defaultProfile}) -> ${rel}`
  );
  assertResolved(graph); // exit 3 AFTER writing the graph, so the state is inspectable
}

async function doCheck(cfg) {
  const { graph } = await computeGraph(cfg);
  console.log(renderCheck(graph));
}

async function doGate(cfg, profile) {
  const { graph } = await computeGraph(cfg);
  assertResolved(graph);
  const verdict = gateVerdict(graph, profile || undefined);
  console.log(renderGate(verdict));
  process.exitCode = verdict.pass ? EXIT.PASS : EXIT.GATE_FAIL;
}

async function doFingerprint(cfg, id) {
  if (!id) throw new ConfigError('TW_CLI_USAGE', 'fingerprint: missing <id>');
  const ctx = await makeCtx(cfg);
  const byId = loadArtifacts(cfg.roots);
  const rec = byId[id];
  if (!rec) throw new ConfigError('TW_NO_SUCH_ARTIFACT', `fingerprint: no artifact "${id}"`);
  const res = await resolveSource({ id, source: rec.data.source || { kind: 'inline' }, body: rec.body }, ctx);
  const fp = fingerprint(res.content);
  if (res.unresolved) {
    throw new ResolveError(`fingerprint: ${id} unresolved (${res.error}); stub/empty fingerprint = ${fp}`,
      [{ id, kind: rec.data.source && rec.data.source.kind, error: res.error }]);
  }
  console.log(fp);
  if (res.error) console.error(`  note: ${res.error}`);
  console.error(`  resolver: ${res.resolver}`);
}

async function doClear(cfg, id, ingredient) {
  if (!id || !ingredient) throw new ConfigError('TW_CLI_USAGE', 'clear: usage: clear <id> <ingredient>');
  const ctx = await makeCtx(cfg);
  const byId = loadArtifacts(cfg.roots);
  const rec = byId[id];
  if (!rec) throw new ConfigError('TW_NO_SUCH_ARTIFACT', `clear: no artifact "${id}"`);
  const { data, body } = parseFrontmatter(readFileSync(rec.path, 'utf8'));
  const ingredients = (data.recipe && data.recipe.ingredients) || [];
  if (!ingredients.includes(ingredient)) {
    throw new ConfigError('TW_CLI_USAGE',
      `clear: "${ingredient}" is not an ingredient of "${id}" (ingredients: [${ingredients.join(', ')}])`);
  }
  const ingRec = byId[ingredient];
  if (!ingRec) throw new ConfigError('TW_NO_SUCH_ARTIFACT', `clear: ingredient artifact "${ingredient}" not found`);
  const ingRes = await resolveSource({ id: ingredient, source: ingRec.data.source || { kind: 'inline' }, body: ingRec.body }, ctx);
  const fp = fingerprint(ingRes.content);
  data.reconciled = data.reconciled || {};
  const prev = data.reconciled[ingredient];
  data.reconciled[ingredient] = fp;
  writeFileSync(rec.path, serializeFrontmatter(data, body), 'utf8');
  console.log(`cleared ${id} <- ${ingredient}: ${prev || '(unset)'} -> ${fp}`);
}

async function doReconcile(cfg, args) {
  const apply = hasFlag(args, '--apply');
  const id = apply.args.find((a) => !a.startsWith('--'));
  if (!id) throw new ConfigError('TW_CLI_USAGE', 'reconcile: missing <downstream-id>');
  const onto = loadOntology(cfg.ontologyPath);
  const ctx = await makeCtx(cfg);

  if (apply.present) {
    const { cleared, graph } = await reconcileApply({ cfg, onto, ctx, id, loadArtifacts });
    console.log(`applied proposal to ${id} and reconciled its suspect link(s):`);
    for (const c of cleared) {
      if (c.skipped) console.log(`  skipped: ${c.skipped}`);
      else console.log(`  ${id} <- ${c.ing}: ${c.prev} -> ${c.fp}  (now fresh)`);
    }
    writeFileSync(cfg.graphPath, JSON.stringify(graph, null, 2) + '\n', 'utf8');
    const still = graph.suspects.filter((sp) => sp.node === id);
    console.log(still.length === 0
      ? `  verified: no remaining suspect links on ${id}.`
      : `  WARNING: ${still.length} link(s) still suspect — ${still.map((s) => s.ingredient).join(', ')}`);
    return;
  }

  const byId = loadArtifacts(cfg.roots);
  const r = await reconcileDraft({ cfg, onto, byId, ctx, id });
  if (!r.drafted && r.suspects.length === 0) { console.log(r.message); return; }
  const relP = r.proposalPath.startsWith(cfg.repoRoot) ? r.proposalPath.slice(cfg.repoRoot.length + 1) : r.proposalPath;
  if (r.kind === 'draft') {
    const lines = r.content.split('\n');
    console.log(`drafted (${r.backend}) -> ${relP}`);
    console.log(`  suspect links to clear on --apply: ${r.suspects.map((s) => s.ingredient).join(', ')}`);
    console.log(`  upstream ${r.upstream.id}: ${r.upstream.from} -> ${r.upstream.to}`);
    console.log(`  draft preview (first 8 lines, ${lines.length} total):`);
    for (const l of lines.slice(0, 8)) console.log(`    | ${l}`);
    if (lines.length > 8) console.log(`    | ... (+${lines.length - 8} more)`);
    console.log(`  approve with: canonweave reconcile ${id} --apply`);
  } else {
    console.log(`no draft produced — wrote a concrete reconcile BRIEF -> ${relP}`);
    console.log(`  reason: ${r.error}`);
  }
}

async function main() {
  let argv = process.argv.slice(2);
  const verb = argv[0];
  argv = argv.slice(1);

  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    console.log(usage());
    return;
  }
  if (verb === '--version' || verb === 'version') {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    console.log(pkg.version);
    return;
  }

  const cfgFlag = popFlag(argv, '--config');
  argv = cfgFlag.args;

  switch (verb) {
    case 'init': {
      const t = popFlag(argv, '--template');
      const d = popFlag(t.args, '--dir');
      const r = await runInit({ template: t.value, dir: d.value });
      console.log(`initialized ${r.templateName} template in ${r.targetDir}`);
      console.log(`  nodes: ${r.graph.nodes.length}, suspects: ${r.graph.suspects.length}, gaps: ${r.graph.gaps.length} (profile ${r.graph.defaultProfile})`);
      console.log(`  next: cd ${r.targetDir} && canonweave check && canonweave gate`);
      break;
    }
    case 'build': await doBuild(getConfig(cfgFlag.value)); break;
    case 'check': await doCheck(getConfig(cfgFlag.value)); break;
    case 'gate': {
      const p = popFlag(argv, '--profile');
      await doGate(getConfig(cfgFlag.value), p.value);
      break;
    }
    case 'fingerprint': await doFingerprint(getConfig(cfgFlag.value), argv[0]); break;
    case 'clear': await doClear(getConfig(cfgFlag.value), argv[0], argv[1]); break;
    case 'reconcile': await doReconcile(getConfig(cfgFlag.value), argv); break;
    case 'selftest': {
      const ok = await runSelftest();
      process.exitCode = ok ? EXIT.PASS : EXIT.GATE_FAIL;
      break;
    }
    case 'sync-issues':
      throw new ConfigError('TW_NOT_YET', 'sync-issues ships in WS4 (Issues/Projects projection — one-way files -> GitHub)');
    case 'serve':
      throw new ConfigError('TW_NOT_YET', 'serve ships in WS6 (local read-only dashboard)');
    default:
      throw new ConfigError('TW_CLI_USAGE', `unknown verb: ${verb}\n\n${usage()}`);
  }
}

main().catch((e) => {
  if (e instanceof ConfigError || e instanceof ResolveError || e.exitCode) {
    console.error(`canonweave: ${e.message}`);
    if (e.code && e.code.startsWith('TW_')) console.error(`  code: ${e.code}`);
    process.exitCode = e.exitCode || EXIT.CONFIG_ERROR;
  } else {
    console.error(`canonweave: unexpected error: ${e && e.stack || e}`);
    process.exitCode = EXIT.CONFIG_ERROR;
  }
});
