// selftest.mjs — hermetic, deterministic self-test. Template drafter only,
// loopback HTTP only (no external network), fixed scratch root, no randomness
// in anything asserted. Exit contract: the CLI maps a false return to exit 1.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  ConfigError,
  fingerprint,
  loadConfig, loadOntology, loadArtifacts, buildGraph, gateVerdict, assertResolved,
  parseFrontmatter, serializeFrontmatter,
  loadResolverPlugins,
  draft, buildDraftPrompt,
  reconcileDraft, reconcileApply,
} from '../../engine/src/index.mjs';
import { runInit } from './init.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, '..', 'bin', 'canonweave.mjs');
const ROOT = join(tmpdir(), 'canonweave-selftest'); // fixed, NOT random

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const ONTOLOGY_FIXTURE = [
  'version: 1',
  'tiers: [base, derived]',
  'types:',
  '  root:',
  '    tier: base',
  '    ingredients: []',
  '  child:',
  '    tier: derived',
  '    ingredients: [root]',
  '  extra:',
  '    tier: derived',
  '    ingredients: [root, child]',
  'profiles:',
  '  core:',
  '    required: [root, child]',
  '  full:',
  '    required: [root, child, extra]',
  '',
].join('\n');

function configText({ gate = 'core', drafterBackend = 'template', resolvers = [], syncIssues = false } = {}) {
  const L = [
    'roots: [docs/trace]',
    'ontology: docs/trace/ontology.yml',
    'graph: docs/trace/graph.json',
    `gate: ${gate}`,
    'drafter:',
    `  backend: ${drafterBackend}`,
  ];
  if (resolvers.length) L.push(`resolvers: [${resolvers.map((r) => `"${r}"`).join(', ')}]`);
  if (syncIssues) { L.push('sync:'); L.push('  issues: true'); }
  return L.join('\n') + '\n';
}

// Make a fixture repo under ROOT/<name>: canonweave.yml + docs/trace/ontology.yml.
function makeRepo(name, opts = {}) {
  const repo = join(ROOT, name);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, 'docs', 'trace'), { recursive: true });
  writeFileSync(join(repo, 'canonweave.yml'), configText(opts), 'utf8');
  writeFileSync(join(repo, 'docs', 'trace', 'ontology.yml'), opts.ontology || ONTOLOGY_FIXTURE, 'utf8');
  return repo;
}

function bodyText(b) { return b == null || b === '' ? '\n' : '\n' + b + '\n'; }
function fpBody(b) { return fingerprint(bodyText(b)); }

// Write one artifact file (dogfoods the canonical serializer).
function art(repo, { id, type, body = '', ingredients = [], reconciled = {}, status = 'present', source = { kind: 'inline' }, extra = {} }) {
  const data = {
    canonweave: 1, id, type, title: `${id} fixture`,
    source, recipe: { ingredients, build: 'fixture build rule' },
    reconciled, owner: 'selftest', status,
    provenance: { issue: null },
    ...extra,
  };
  writeFileSync(join(repo, 'docs', 'trace', `${id}.md`), serializeFrontmatter(data, bodyText(body)), 'utf8');
}

function rawArt(repo, file, text) {
  writeFileSync(join(repo, 'docs', 'trace', file), text, 'utf8');
}

async function engine(repo, { defaultProfile } = {}) {
  const cfg = loadConfig(join(repo, 'canonweave.yml'));
  const onto = loadOntology(cfg.ontologyPath);
  const plugins = await loadResolverPlugins(cfg.resolverModules);
  const ctx = { repoRoot: cfg.repoRoot, cacheDir: cfg.cacheDir, plugins, defaultProfile: defaultProfile || cfg.gateProfile };
  return { cfg, onto, ctx };
}

async function buildRepo(repo, opts = {}) {
  const { cfg, onto, ctx } = await engine(repo, opts);
  const byId = loadArtifacts(cfg.roots);
  const graph = await buildGraph(onto, byId, ctx);
  return { cfg, onto, ctx, byId, graph };
}

// Expect fn (sync or async) to throw a ConfigError with the given TW_ code.
async function expectCode(fn, code) {
  try {
    await fn();
    return { ok: false, detail: 'did not throw' };
  } catch (e) {
    const got = e && e.code;
    return { ok: got === code, detail: `threw ${e && e.name}/${got}: ${String(e && e.message).slice(0, 100)}` };
  }
}

function runCliAsync(args, cwd, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ status: code, stdout, stderr }); });
  });
}

function runCli(args, cwd, env) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status == null ? -1 : e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------
export async function runSelftest() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const results = [];
  const check = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond });
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  };

  // ---- 1. schema v1 validation errors -------------------------------------
  {
    const repo = makeRepo('schema');
    const cases = [
      ['TW_SCHEMA_NO_FRONTMATTER', 'no frontmatter', 'x.md', '# just markdown\n'],
      ['TW_SCHEMA_MISSING_VERSION', 'missing version key', 'a.md', '---\nid: a\ntype: root\n---\nbody\n'],
      ['TW_SCHEMA_UNSUPPORTED_VERSION', 'unsupported version', 'b.md', '---\ncanonweave: 99\nid: b\ntype: root\n---\nbody\n'],
      ['TW_SCHEMA_MISSING_ID', 'missing id', 'c.md', '---\ncanonweave: 1\ntype: root\n---\nbody\n'],
      ['TW_SCHEMA_BAD_ID', 'bad id (uppercase)', 'd.md', '---\ncanonweave: 1\nid: BadId\ntype: root\n---\nbody\n'],
      ['TW_SCHEMA_BAD_STATUS', 'bad status', 'e.md', '---\ncanonweave: 1\nid: e\ntype: root\nstatus: wip\n---\nbody\n'],
      ['TW_SCHEMA_BAD_PROVENANCE', 'non-integer provenance.issue', 'f.md', '---\ncanonweave: 1\nid: f\ntype: root\nprovenance:\n  issue: soon\n---\nbody\n'],
    ];
    for (const [code, label, file, text] of cases) {
      rmSync(join(repo, 'docs', 'trace'), { recursive: true, force: true });
      mkdirSync(join(repo, 'docs', 'trace'), { recursive: true });
      writeFileSync(join(repo, 'docs', 'trace', 'ontology.yml'), ONTOLOGY_FIXTURE, 'utf8');
      rawArt(repo, file, text);
      const r = await expectCode(() => loadArtifacts([join(repo, 'docs', 'trace')]), code);
      check(`schema v1: ${label} -> ${code}`, r.ok, r.detail);
    }
  }

  // ---- 2. ontology validation ----------------------------------------------
  {
    const legacy = ONTOLOGY_FIXTURE.replace('    tier: base\n    ingredients: []',
      '    tier: base\n    ingredients: []\n    requiredForGate: true');
    const repo = makeRepo('onto-legacy', { ontology: legacy });
    const r1 = await expectCode(() => loadOntology(join(repo, 'docs', 'trace', 'ontology.yml')), 'TW_ONTOLOGY_LEGACY_REQUIRED');
    check('ontology: legacy requiredForGate rejected with migration pointer', r1.ok, r1.detail);

    const noProfiles = ONTOLOGY_FIXTURE.split('profiles:')[0];
    const repo2 = makeRepo('onto-noprof', { ontology: noProfiles });
    const r2 = await expectCode(() => loadOntology(join(repo2, 'docs', 'trace', 'ontology.yml')), 'TW_ONTOLOGY_NO_PROFILES');
    check('ontology: zero gate profiles rejected', r2.ok, r2.detail);

    const repo3 = makeRepo('onto-unknown-profile');
    art(repo3, { id: 'root', type: 'root', body: 'R1' });
    const r3 = await expectCode(async () => { await buildRepo(repo3, { defaultProfile: 'nope' }); }, 'TW_ONTOLOGY_UNKNOWN_PROFILE');
    check('gate: unknown profile name rejected', r3.ok, r3.detail);
  }

  // ---- 3. edge validation ---------------------------------------------------
  {
    const repo = makeRepo('edges');
    art(repo, { id: 'root', type: 'root', body: 'R1' });
    art(repo, { id: 'bad-root', type: 'root', body: 'B1', ingredients: ['root'] }); // root allows no ingredients
    const r1 = await expectCode(async () => { await buildRepo(repo); }, 'TW_EDGE_ILLEGAL');
    check('edges: illegal ingredient edge rejected', r1.ok, r1.detail);

    const repo2 = makeRepo('edges-unknown-type');
    rawArt(repo2, 'z.md', '---\ncanonweave: 1\nid: z\ntype: mystery\n---\nbody\n');
    const r2 = await expectCode(async () => { await buildRepo(repo2); }, 'TW_TYPE_UNKNOWN');
    check('edges: unknown artifact type rejected', r2.ok, r2.detail);

    const repo3 = makeRepo('edges-missing-ing');
    art(repo3, { id: 'child', type: 'child', body: 'C1', ingredients: ['root'] }); // root file absent
    const r3 = await expectCode(async () => { await buildRepo(repo3); }, 'TW_EDGE_UNKNOWN_INGREDIENT');
    check('edges: ingredient id with no artifact rejected', r3.ok, r3.detail);
  }

  // ---- 4. duplicate id + multi-root ----------------------------------------
  {
    const repo = makeRepo('multiroot');
    mkdirSync(join(repo, 'docs', 'trace2'), { recursive: true });
    writeFileSync(join(repo, 'canonweave.yml'),
      'roots: [docs/trace, docs/trace2]\nontology: docs/trace/ontology.yml\ngraph: docs/trace/graph.json\ngate: core\ndrafter:\n  backend: template\n', 'utf8');
    art(repo, { id: 'root', type: 'root', body: 'R1' });
    writeFileSync(join(repo, 'docs', 'trace2', 'child.md'),
      serializeFrontmatter({ canonweave: 1, id: 'child', type: 'child', source: { kind: 'inline' }, recipe: { ingredients: ['root'] }, reconciled: { root: fpBody('R1') }, status: 'present' }, bodyText('C1')), 'utf8');
    const { graph } = await buildRepo(repo);
    check('multi-root: artifacts from two roots merge into one graph',
      graph.nodes.length === 2 && graph.edges.length === 1 && graph.suspects.length === 0,
      `nodes=${graph.nodes.length} edges=${graph.edges.length} suspects=${graph.suspects.length}`);

    writeFileSync(join(repo, 'docs', 'trace2', 'root-dupe.md'),
      serializeFrontmatter({ canonweave: 1, id: 'root', type: 'root', source: { kind: 'inline' }, recipe: { ingredients: [] }, status: 'present' }, bodyText('R-DUPE')), 'utf8');
    const r = await expectCode(async () => { await buildRepo(repo); }, 'TW_DUPLICATE_ID');
    check('multi-root: duplicate artifact id across roots rejected', r.ok, r.detail);
  }

  // ---- 5. fingerprint contract (v1) -----------------------------------------
  {
    check('fingerprint: CRLF and LF content fingerprint identically',
      fingerprint('a\r\nb\r\nc') === fingerprint('a\nb\nc'));
    check('fingerprint: lone CR is NOT normalized in v1 (exact contract)',
      fingerprint('a\rb') !== fingerprint('a\nb'));
    check('fingerprint: format is sha256:<64 hex>',
      /^sha256:[0-9a-f]{64}$/.test(fingerprint('x')));
  }

  // ---- 6. serializer round-trips (rewrite safety) ---------------------------
  {
    const data = {
      canonweave: 1, id: 'rt', type: 'root', title: 'has: colon, and, commas',
      source: { kind: 'inline' },
      recipe: { ingredients: [], build: 'a build: with colon' },
      reconciled: { dep: 'sha256:abc' },
      status: 'present',
      meta: { nested: { deep: 'kept', n: 3 }, list: ['a,b', 'c'] }, // unknown key passthrough, depth 2
    };
    const text = serializeFrontmatter(data, bodyText('BODY'));
    const back = parseFrontmatter(text);
    const m = back.data.meta || {};
    check('serializer: depth-2 nested maps survive rewrite (no data loss)',
      m.nested && m.nested.deep === 'kept' && m.nested.n === 3,
      JSON.stringify(m.nested));
    check('serializer: comma-bearing list items survive round-trip',
      Array.isArray(m.list) && m.list.length === 2 && m.list[0] === 'a,b' && m.list[1] === 'c',
      JSON.stringify(m.list));
    check('serializer: colon-bearing scalars survive round-trip',
      back.data.title === data.title && back.data.recipe.build === data.recipe.build);
    check('serializer: reconciled sha256 map survives round-trip',
      back.data.reconciled && back.data.reconciled.dep === 'sha256:abc');
    check('serializer: body preserved byte-for-byte', back.body === bodyText('BODY'));
  }

  // ---- 7. fresh -> suspect -> clear cycle -----------------------------------
  const cycleRepo = makeRepo('cycle');
  {
    art(cycleRepo, { id: 'root', type: 'root', body: 'ROOT-v1' });
    art(cycleRepo, { id: 'child', type: 'child', body: 'CHILD-v1', ingredients: ['root'], reconciled: { root: fpBody('ROOT-v1') } });
    let g = (await buildRepo(cycleRepo)).graph;
    check('cycle: all-fresh graph has zero suspects', g.suspects.length === 0, `suspects=${g.suspects.length}`);
    check('cycle: gate core PASSES on fresh graph', g.gates.core.pass, g.gates.core.reasons.join('; '));

    art(cycleRepo, { id: 'root', type: 'root', body: 'ROOT-v2-CHANGED' });
    g = (await buildRepo(cycleRepo)).graph;
    const pair = g.suspects.map((s) => `${s.node}<-${s.ingredient}`);
    check('cycle: mutating upstream makes the dependent link suspect',
      pair.length === 1 && pair[0] === 'child<-root', pair.join(','));
    check('cycle: suspect carries old and new fingerprints',
      g.suspects[0].expected === fpBody('ROOT-v1') && g.suspects[0].actual === fpBody('ROOT-v2-CHANGED'));
    check('cycle: gate core FAILS while suspect', !g.gates.core.pass);

    const r = runCli(['clear', 'child', 'root'], cycleRepo);
    g = (await buildRepo(cycleRepo)).graph;
    check('cycle: CLI clear returns the link to fresh (exit 0)',
      r.status === 0 && g.suspects.length === 0, `status=${r.status} suspects=${g.suspects.length}`);
  }

  // ---- 8. per-profile gate split --------------------------------------------
  {
    const repo = makeRepo('profiles');
    art(repo, { id: 'root', type: 'root', body: 'R1' });
    art(repo, { id: 'child', type: 'child', body: 'C1', ingredients: ['root'], reconciled: { root: fpBody('R1') } });
    const { graph } = await buildRepo(repo);
    check('profiles: core passes while full fails on the same graph',
      graph.gates.core.pass === true && graph.gates.full.pass === false,
      `core=${graph.gates.core.pass} full=${graph.gates.full.pass}`);
    check('profiles: full names the missing required type',
      graph.gates.full.gaps.some((gp) => gp.type === 'extra' && /missing entirely/.test(gp.reason)));
    check('profiles: graph.gaps mirrors the default profile gate',
      JSON.stringify(graph.gaps) === JSON.stringify(graph.gates.core.gaps));
    const v = gateVerdict(graph, 'full');
    check('profiles: gateVerdict(full) reports FAIL with reasons', v.pass === false && v.reasons.length > 0);
  }

  // ---- 9. placeholder gap ----------------------------------------------------
  {
    const repo = makeRepo('placeholder');
    art(repo, { id: 'root', type: 'root', body: 'R1' });
    art(repo, { id: 'child', type: 'child', body: '', ingredients: ['root'], reconciled: { root: fpBody('R1') }, status: 'placeholder' });
    const { graph } = await buildRepo(repo);
    check('gaps: required placeholder artifact reported as coverage gap',
      graph.gates.core.gaps.some((gp) => gp.id === 'child' && /placeholder/.test(gp.reason)) && !graph.gates.core.pass);
  }

  // ---- 10. url resolver: live / cache / no-cache ----------------------------
  {
    const repo = makeRepo('urls');
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('REMOTE-CONTENT-v1'); });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    art(repo, { id: 'root', type: 'root', body: '', source: { kind: 'url', url: `http://127.0.0.1:${port}/doc` } });
    art(repo, { id: 'child', type: 'child', body: 'C1', ingredients: ['root'], reconciled: { root: fingerprint('REMOTE-CONTENT-v1') } });

    let g = (await buildRepo(repo)).graph;
    const rootNode = () => g.nodes.find((n) => n.id === 'root');
    check('url: live fetch resolves and fingerprints the remote content',
      rootNode().source.resolver === 'url' && rootNode().fingerprint === fingerprint('REMOTE-CONTENT-v1') && g.suspects.length === 0,
      `resolver=${rootNode().source.resolver}`);
    const cacheFile = join(repo, '.canonweave', 'cache', 'root.content');
    check('url: fetched content cached to .canonweave/cache/<id>.content',
      existsSync(cacheFile) && readFileSync(cacheFile, 'utf8') === 'REMOTE-CONTENT-v1');

    await new Promise((res) => server.close(res));
    g = (await buildRepo(repo)).graph;
    check('url: offline build falls back to committed cache (url:cache)',
      rootNode().source.resolver === 'url:cache' && rootNode().fingerprint === fingerprint('REMOTE-CONTENT-v1') && !rootNode().unresolved,
      `resolver=${rootNode().source.resolver}`);

    rmSync(join(repo, '.canonweave'), { recursive: true, force: true });
    g = (await buildRepo(repo)).graph;
    check('url: offline with no cache -> node unresolved', rootNode().unresolved === true);
    let threw = null;
    try { assertResolved(g); } catch (e) { threw = e; }
    check('url: assertResolved raises ResolveError naming the node (exit-3 path)',
      threw && threw.name === 'ResolveError' && threw.exitCode === 3 && /root/.test(threw.message),
      threw ? threw.name : 'no throw');

    // exit 3 through the real CLI
    const r = runCli(['gate'], repo);
    check('url: CLI gate exits 3 when a source is unresolvable with no cache', r.status === 3, `status=${r.status} ${r.stderr.slice(0, 80)}`);
  }

  // ---- 11. unknown source kind + plugin resolvers ---------------------------
  {
    const repo = makeRepo('kinds');
    art(repo, { id: 'root', type: 'root', body: '', source: { kind: 'mystery' } });
    const r1 = await expectCode(async () => { await buildRepo(repo); }, 'TW_SOURCE_UNKNOWN_KIND');
    check('resolvers: unknown source.kind is a config error (exit 2)', r1.ok, r1.detail);

    const pluginsDir = join(ROOT, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    const fixturePlugin = join(pluginsDir, 'fixture.mjs');
    writeFileSync(fixturePlugin, [
      'export const resolvers = {',
      "  fixture: (node) => ({ content: `FIXTURE:${node.id}`, resolver: 'fixture', unresolved: false, error: null }),",
      '};', '',
    ].join('\n'), 'utf8');
    const repo2 = makeRepo('plugin', { resolvers: [fixturePlugin.replace(/\\/g, '/')] });
    art(repo2, { id: 'root', type: 'root', body: '', source: { kind: 'fixture' } });
    const { graph: g2 } = await buildRepo(repo2);
    const n = g2.nodes.find((x) => x.id === 'root');
    check('resolvers: plugin kind from canonweave.yml resolves content',
      n.source.resolver === 'fixture' && n.fingerprint === fingerprint('FIXTURE:root') && !n.unresolved,
      `resolver=${n.source.resolver}`);

    const collidePlugin = join(pluginsDir, 'collide.mjs');
    writeFileSync(collidePlugin, "export const resolvers = { inline: () => ({ content: '', resolver: 'x', unresolved: false, error: null }) };\n", 'utf8');
    const r2 = await expectCode(() => loadResolverPlugins([collidePlugin]), 'TW_PLUGIN_COLLISION');
    check('resolvers: plugin overriding a builtin kind is rejected', r2.ok, r2.detail);

    const badPlugin = join(pluginsDir, 'bad.mjs');
    writeFileSync(badPlugin, 'export const notResolvers = 1;\n', 'utf8');
    const r3 = await expectCode(() => loadResolverPlugins([badPlugin]), 'TW_PLUGIN_SHAPE');
    check('resolvers: plugin without a resolvers export is rejected', r3.ok, r3.detail);
  }

  // ---- 12. drafter backends --------------------------------------------------
  {
    const req = {
      downstream: { id: 'child', type: 'child', title: 'Child', build: 'derive from root' },
      upstream: { id: 'root', type: 'root', title: 'Root', fingerprintOld: 'sha256:old', fingerprintNew: fpBody('ROOT-v9'), content: 'ROOT-v9 content' },
      downstreamCurrent: 'old child content',
    };
    const t = await draft(req, { backend: 'template' });
    check('drafter: template backend yields a concrete upstream-specific draft',
      t.ok && t.kind === 'draft' && t.content.includes(req.upstream.fingerprintNew) && t.content.includes('root'));

    const echoScript = join(ROOT, 'echo-drafter.mjs');
    writeFileSync(echoScript, "console.log('# CMD DRAFT\\n\\nCMD-DRAFT-BODY');\n", 'utf8');
    const c = await draft(req, { backend: 'cmd', command: [process.execPath, echoScript] });
    check('drafter: cmd backend runs the configured argv and reads stdout',
      c.ok && c.kind === 'draft' && /CMD-DRAFT-BODY/.test(c.content), c.error || '');

    const cFail = await draft(req, { backend: 'cmd', command: [process.execPath, join(ROOT, 'no-such-script.mjs')] });
    check('drafter: failing cmd falls back to brief mode', !cFail.ok && cFail.kind === 'brief');

    const n = await draft(req, { backend: 'none' });
    check('drafter: none backend always produces a brief', !n.ok && n.kind === 'brief');
  }


  // ---- 12b. WS3 API drafter backends (loopback, hermetic — design section 7)
  {
    const req = {
      downstream: { id: 'child', type: 'child', title: 'Child', build: 'derive from root' },
      upstream: { id: 'root', type: 'root', title: 'Root', fingerprintOld: 'sha256:old', fingerprintNew: fpBody('ROOT-ws3'), content: 'ROOT-ws3 content' },
      downstreamCurrent: 'old child content',
    };
    const hits = [];
    const server = createServer((rq, rs) => {
      let body = '';
      rq.on('data', (c) => { body += c; });
      rq.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* keep null */ }
        hits.push({ path: rq.url, headers: rq.headers, body: parsed });
        if (rq.url === '/v1/messages') {
          if (!rq.headers['x-api-key']) { rs.writeHead(401); rs.end('{"error":"no key"}'); return; }
          rs.writeHead(200, { 'content-type': 'application/json' });
          rs.end(JSON.stringify({ content: [{ type: 'thinking', thinking: 'internal chain' }, { type: 'text', text: '```markdown\nANTHROPIC-DRAFT for ' + parsed.model + '\n```' }] }));
        } else if (rq.url === '/compat/chat/completions') {
          rs.writeHead(200, { 'content-type': 'application/json' });
          rs.end(JSON.stringify({ choices: [{ message: { content: 'OPENAI-DRAFT-BODY' } }] }));
        } else if (rq.url === '/err/chat/completions') {
          rs.writeHead(500); rs.end('boom');
        } else { rs.writeHead(404); rs.end('{}'); }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    process.env.TW_TEST_ANTHROPIC_KEY = 'tw-test-key-a';
    const a = await draft(req, { backend: 'anthropic', model: 'm-test', baseUrl: base, apiKeyEnv: 'TW_TEST_ANTHROPIC_KEY', maxTokens: 777 });
    const acall = hits.find((h) => h.path === '/v1/messages');
    check('drafter(ws3): anthropic posts a pinned single-completion request (no tools)',
      a.ok && a.kind === 'draft' && !!acall
      && acall.body.model === 'm-test' && acall.body.max_tokens === 777
      && Array.isArray(acall.body.messages) && acall.body.messages.length === 1
      && acall.body.messages[0].role === 'user' && !('tools' in acall.body)
      && acall.headers['x-api-key'] === 'tw-test-key-a'
      && acall.headers['anthropic-version'] === '2023-06-01',
      a.error || '');
    check('drafter(ws3): anthropic draft fence-stripped to the bare body',
      a.content === 'ANTHROPIC-DRAFT for m-test');

    process.env.TW_TEST_OPENAI_KEY = 'tw-test-key-o';
    const o = await draft(req, { backend: 'openai', model: 'local-model', baseUrl: `${base}/compat`, apiKeyEnv: 'TW_TEST_OPENAI_KEY', maxTokens: 512 });
    const ocall = hits.find((h) => h.path === '/compat/chat/completions');
    check('drafter(ws3): openai-compatible hits {base_url}/chat/completions with bearer key',
      o.ok && o.content === 'OPENAI-DRAFT-BODY' && !!ocall
      && ocall.headers.authorization === 'Bearer tw-test-key-o'
      && ocall.body.model === 'local-model' && !('tools' in ocall.body),
      o.error || '');

    delete process.env.TW_TEST_MISSING_KEY;
    const mk = await draft(req, { backend: 'anthropic', model: 'm', baseUrl: base, apiKeyEnv: 'TW_TEST_MISSING_KEY', maxTokens: 16 });
    check('drafter(ws3): missing key -> brief naming only the env VAR (key never logged)',
      !mk.ok && mk.kind === 'brief' && mk.error.includes('TW_TEST_MISSING_KEY') && !mk.error.includes('tw-test-key'));

    const he = await draft(req, { backend: 'openai', model: 'm', baseUrl: `${base}/err`, apiKeyEnv: 'TW_TEST_OPENAI_KEY', maxTokens: 16 });
    check('drafter(ws3): API failure -> brief fallback carrying HTTP status, never the key',
      !he.ok && he.kind === 'brief' && /HTTP 500/.test(he.error) && !he.error.includes('tw-test-key'));

    const big = { ...req, upstream: { ...req.upstream, content: 'X'.repeat(40000) } };
    const prompt = buildDraftPrompt(big);
    check('drafter(ws3): input size cap bounds hostile upstream content',
      prompt.length < 40000 && prompt.includes('truncated'));

    await new Promise((r) => server.close(r));
  }

  // ---- 13. reconcile loop: draft -> apply -> fresh (template backend) --------
  {
    const repo = makeRepo('reconcile');
    art(repo, { id: 'root', type: 'root', body: 'ROOT-v1' });
    art(repo, { id: 'child', type: 'child', body: 'CHILD-v1', ingredients: ['root'], reconciled: { root: fpBody('ROOT-v1') } });
    art(repo, { id: 'root', type: 'root', body: 'ROOT-v2' }); // mutate upstream

    const { cfg, onto, ctx, byId } = await buildRepo(repo);
    const d = await reconcileDraft({ cfg, onto, byId, ctx, id: 'child' });
    check('reconcile: draft produced for the suspect downstream',
      d.drafted && d.kind === 'draft' && existsSync(d.proposalPath),
      `kind=${d.kind}`);
    check('reconcile: proposal embeds the NEW upstream fingerprint',
      d.content && d.content.includes(fpBody('ROOT-v2')));

    const a = await reconcileApply({ cfg, onto, ctx, id: 'child', loadArtifacts });
    const stillSuspect = a.graph.suspects.filter((s) => s.node === 'child');
    const childNode = a.graph.nodes.find((n) => n.id === 'child');
    check('reconcile: apply clears the suspect link and rebuilds fresh',
      a.cleared.length === 1 && a.cleared[0].fp === fpBody('ROOT-v2') && stillSuspect.length === 0,
      `cleared=${a.cleared.length} still=${stillSuspect.length}`);
    check('reconcile: applied downstream is present with the drafted body',
      childNode.status === 'present' && readFileSync(join(repo, 'docs', 'trace', 'child.md'), 'utf8').includes(fpBody('ROOT-v2')));

    // brief path: backend none -> apply must refuse with TW_PROPOSAL_IS_BRIEF
    const repoB = makeRepo('reconcile-brief', { drafterBackend: 'none' });
    art(repoB, { id: 'root', type: 'root', body: 'R1' });
    art(repoB, { id: 'child', type: 'child', body: 'C1', ingredients: ['root'], reconciled: { root: 'sha256:stale' } });
    const eB = await buildRepo(repoB);
    const dB = await reconcileDraft({ cfg: eB.cfg, onto: eB.onto, byId: eB.byId, ctx: eB.ctx, id: 'child' });
    check('reconcile: none backend writes a BRIEF proposal', !dB.drafted && dB.kind === 'brief' && existsSync(dB.proposalPath));
    const rB = await expectCode(() => reconcileApply({ cfg: eB.cfg, onto: eB.onto, ctx: eB.ctx, id: 'child', loadArtifacts }), 'TW_PROPOSAL_IS_BRIEF');
    check('reconcile: applying a brief refuses with TW_PROPOSAL_IS_BRIEF', rB.ok, rB.detail);

    const rC = await expectCode(() => reconcileApply({ cfg, onto, ctx, id: 'ghost', loadArtifacts }), 'TW_NO_PROPOSAL');
    check('reconcile: apply without a proposal refuses with TW_NO_PROPOSAL', rC.ok, rC.detail);
  }

  // ---- 14. config validation --------------------------------------------------
  {
    const repo = makeRepo('config-bad');
    writeFileSync(join(repo, 'canonweave.yml'), 'roots: [docs/trace]\nsurprise: 1\n', 'utf8');
    const r1 = await expectCode(() => loadConfig(join(repo, 'canonweave.yml')), 'TW_CONFIG_UNKNOWN_KEY');
    check('config: unknown top-level key rejected', r1.ok, r1.detail);

    writeFileSync(join(repo, 'canonweave.yml'), 'drafter:\n  backend: anthropic\n', 'utf8');
    const cfgA = loadConfig(join(repo, 'canonweave.yml'));
    check('config: anthropic backend accepted with safe defaults (WS3 shipped)',
      cfgA.drafter.backend === 'anthropic' && cfgA.drafter.apiKeyEnv === 'ANTHROPIC_API_KEY'
      && cfgA.drafter.baseUrl === 'https://api.anthropic.com' && cfgA.drafter.maxTokens === 8192
      && typeof cfgA.drafter.model === 'string' && cfgA.drafter.model.length > 0);

    writeFileSync(join(repo, 'canonweave.yml'), 'drafter:\n  backend: openai\n', 'utf8');
    const r2 = await expectCode(() => loadConfig(join(repo, 'canonweave.yml')), 'TW_CONFIG_DRAFTER_MODEL');
    check('config: openai backend without model rejected (TW_CONFIG_DRAFTER_MODEL)', r2.ok, r2.detail);

    writeFileSync(join(repo, 'canonweave.yml'), 'drafter:\n  backend: anthropic\n  api_key_env: "lower case"\n', 'utf8');
    const r2b = await expectCode(() => loadConfig(join(repo, 'canonweave.yml')), 'TW_CONFIG_DRAFTER');
    check('config: api_key_env must be an environment variable NAME, never a key', r2b.ok, r2b.detail);

    const r3 = await expectCode(() => loadConfig(join(repo, 'nope', 'canonweave.yml')), 'TW_CONFIG_NOT_FOUND');
    check('config: missing canonweave.yml is TW_CONFIG_NOT_FOUND', r3.ok, r3.detail);
  }

  // ---- 15. init smoke: generic-software (green) + product-lifecycle (honest fail)
  {
    const gs = join(ROOT, 'init-gs');
    const r = await runInit({ template: 'generic-software', dir: gs });
    check('init: generic-software skeleton builds with zero suspects/gaps',
      r.graph.suspects.length === 0 && r.graph.gaps.length === 0,
      `suspects=${r.graph.suspects.length} gaps=${r.graph.gaps.length}`);
    check('init: generic-software passes BOTH shipped profiles',
      r.graph.gates['ready-to-build'].pass && r.graph.gates['ready-to-ship'].pass);
    const seeded = readFileSync(join(gs, 'docs', 'trace', 'requirements.md'), 'utf8');
    check('init: auto-reconcile filled reconciled fingerprints in seed artifacts',
      /reconciled:\n  product-brief: "?sha256:/.test(seeded));
    check('init: graph.json committed-ready (written, deterministic shape)',
      existsSync(join(gs, 'docs', 'trace', 'graph.json')) && JSON.parse(readFileSync(join(gs, 'docs', 'trace', 'graph.json'), 'utf8')).generatedAt === null);

    const again = await expectCode(() => runInit({ template: 'generic-software', dir: gs }), 'TW_INIT_EXISTS');
    check('init: refuses to overwrite an initialized repo', again.ok, again.detail);
    const ghost = await expectCode(() => runInit({ template: 'no-such-template', dir: join(ROOT, 'init-ghost') }), 'TW_INIT_NO_TEMPLATE');
    check('init: unknown template rejected with the available list', ghost.ok, ghost.detail);

    const pl = join(ROOT, 'init-pl');
    const rp = await runInit({ template: 'product-lifecycle', dir: pl });
    check('init: product-lifecycle builds clean but gate FAILS honestly (placeholder seed)',
      rp.graph.suspects.length === 0 && rp.graph.gates['ready-to-build'].pass === false && rp.graph.gates['ready-to-build'].gaps.length > 0,
      `gaps=${rp.graph.gates['ready-to-build'].gaps.length}`);
    check('init: product-lifecycle gap list names the missing required types',
      rp.graph.gates['ready-to-build'].gaps.some((g) => g.type === 'c4') &&
      rp.graph.gates['ready-to-build'].gaps.some((g) => g.id === 'pr-faq' && /placeholder/.test(g.reason)));
  }

  // ---- 16. CRLF determinism: byte-identical graphs --------------------------
  {
    const lf = makeRepo('crlf-lf');
    art(lf, { id: 'root', type: 'root', body: 'line1\nline2' });
    art(lf, { id: 'child', type: 'child', body: 'C1', ingredients: ['root'], reconciled: { root: fpBody('line1\nline2') } });
    const gLf = (await buildRepo(lf)).graph;

    const crlf = makeRepo('crlf-win');
    for (const f of ['root.md', 'child.md']) {
      const t = readFileSync(join(lf, 'docs', 'trace', f), 'utf8').replace(/\n/g, '\r\n');
      writeFileSync(join(crlf, 'docs', 'trace', f), t, 'utf8');
    }
    const gCrlf = (await buildRepo(crlf)).graph;
    check('determinism: CRLF checkout produces a byte-identical graph (section 4.5)',
      JSON.stringify(gLf) === JSON.stringify(gCrlf));

    const gAgain = (await buildRepo(lf)).graph;
    check('determinism: building twice is byte-identical (no clocks, no randomness)',
      JSON.stringify(gLf) === JSON.stringify(gAgain) && gLf.generatedAt === null);
  }

  // ---- 17. CLI subprocess exit-code taxonomy ---------------------------------
  {
    const gs = join(ROOT, 'init-gs'); // exit 0: green skeleton from test 15
    const r0 = runCli(['gate'], gs);
    check('CLI exit 0: gate passes on the green skeleton', r0.status === 0, `status=${r0.status}`);

    const r0b = runCli(['build'], gs);
    check('CLI exit 0: build succeeds and reports counts', r0b.status === 0 && /build ok/.test(r0b.stdout), `status=${r0b.status}`);

    // exit 1: suspect link (mutate an upstream in a copy)
    const sus = makeRepo('cli-suspect');
    art(sus, { id: 'root', type: 'root', body: 'R1' });
    art(sus, { id: 'child', type: 'child', body: 'C1', ingredients: ['root'], reconciled: { root: 'sha256:stale' } });
    const r1 = runCli(['gate'], sus);
    check('CLI exit 1: gate fails on suspect/gap findings', r1.status === 1, `status=${r1.status}`);
    const rCheck = runCli(['check'], sus);
    check('CLI exit 0: check reports content findings without failing', rCheck.status === 0 && /SUSPECT/.test(rCheck.stdout), `status=${rCheck.status}`);

    // exit 2: config error
    const bad = join(ROOT, 'cli-badconfig');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'canonweave.yml'), 'surprise: 1\n', 'utf8');
    const r2 = runCli(['build'], bad);
    check('CLI exit 2: config error', r2.status === 2 && /TW_CONFIG_UNKNOWN_KEY/.test(r2.stderr), `status=${r2.status}`);
    const rVerb = runCli(['no-such-verb'], gs);
    check('CLI exit 2: unknown verb', rVerb.status === 2, `status=${rVerb.status}`);
    const rWs = runCli(['sync-issues'], gs);
    check('CLI exit 2: sync-issues refuses when sync.issues is false', rWs.status === 2 && /TW_SYNC_DISABLED/.test(rWs.stderr), `status=${rWs.status}`);
    const rServe = runCli(['serve'], gs);
    check('CLI exit 2: serve is the explicit WS6 stub', rServe.status === 2 && /WS6/.test(rServe.stderr), `status=${rServe.status}`);
    // exit 3 covered in test 10 via the url repo.
  }


  // ===========================================================================
  // 12. sync-issues (WS4) — one-way projection against a stateful fake GitHub
  // ===========================================================================
  {
    // ---- fake GitHub: REST issues + sub-issues, GraphQL Projects v2 ----------
    let ghLog = [];
    let issueSeq = 0;
    let issues = [];                 // {number,id,node_id,state,title,body,labels:[{name}],type:{name}|null}
    const childParent = new Map();   // child issue number -> parent issue number
    const project = { created: false, id: 'P_1', number: 7, title: null, field: null, items: [], itemSeq: 0 };

    const findIssue = (n) => issues.find((i) => i.number === Number(n));
    const gqlHandlers = {
      CwOwner: (v, auth) => auth === 'Bearer no-projects-token'
        ? { errors: [{ message: 'Resource not accessible by integration' }] }
        : { data: { repositoryOwner: { __typename: 'Organization', id: 'ORG_1' } } },
      CwFindProject: (v) => ({ data: { repositoryOwner: { projectsV2: { nodes: project.created ? [{ id: project.id, title: project.title, number: project.number }] : [] } } } }),
      CwCreateProject: (v) => { project.created = true; project.title = v.title; return { data: { createProjectV2: { projectV2: { id: project.id, number: project.number } } } }; },
      CwFields: () => ({ data: { node: { fields: { nodes: project.field ? [project.field] : [] } } } }),
      CwCreateField: (v) => {
        project.field = { id: 'F_1', name: v.name, options: v.opts.map((o, i) => ({ id: `O_${i}`, name: o.name })) };
        return { data: { createProjectV2Field: { projectV2Field: project.field } } };
      },
      CwItems: () => ({ data: { node: { items: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: project.items.map((it) => ({
          id: it.id,
          fieldValueByName: it.status ? { name: it.status } : null,
          content: { number: it.issueNumber },
        })),
      } } } }),
      CwAddItem: (v) => {
        const issue = issues.find((i) => i.node_id === v.contentId);
        const item = { id: `I_${++project.itemSeq}`, issueNumber: issue.number, status: null };
        project.items.push(item);
        return { data: { addProjectV2ItemById: { item: { id: item.id } } } };
      },
      CwSetStatus: (v) => {
        const item = project.items.find((i) => i.id === v.itemId);
        item.status = project.field.options.find((o) => o.id === v.optionId).name;
        return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } };
      },
    };

    const gh = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        ghLog.push({ method: req.method, url: req.url, body });
        res.setHeader('content-type', 'application/json');
        const path = new URL(req.url, 'http://x').pathname;
        const send = (code, obj) => { res.writeHead(code); res.end(JSON.stringify(obj)); };
        let m;

        if (path === '/graphql' && req.method === 'POST') {
          const b = JSON.parse(body);
          const name = (b.query.match(/(?:query|mutation)\s+(\w+)/) || [])[1];
          const h = gqlHandlers[name];
          if (!h) return send(200, { errors: [{ message: `fake: unhandled operation ${name}` }] });
          return send(200, h(b.variables || {}, req.headers.authorization));
        }
        if (req.method === 'POST' && /\/issues$/.test(path)) {
          const b = JSON.parse(body);
          if (b.type === 'child') return send(422, { message: 'fake org has no issue type "child"' }); // exercises the fallback
          const n = ++issueSeq;
          const issue = { number: n, id: 1000 + n, node_id: `NID_${n}`, state: 'open', title: b.title, body: b.body, labels: (b.labels || []).map((x) => ({ name: x })), type: b.type ? { name: b.type } : null };
          issues.push(issue);
          return send(201, issue);
        }
        if ((m = path.match(/\/issues\/(\d+)\/sub_issues$/))) {
          const parent = findIssue(m[1]);
          if (!parent) return send(404, {});
          if (req.method === 'GET') {
            const kids = [...childParent.entries()].filter(([, p]) => p === parent.number).map(([c]) => findIssue(c)).filter(Boolean);
            return send(200, kids);
          }
          const b = JSON.parse(body);
          const child = issues.find((i) => i.id === b.sub_issue_id);
          if (!child) return send(404, {});
          if (childParent.has(child.number)) return send(422, { message: 'already has a parent' });
          childParent.set(child.number, parent.number);
          return send(201, {});
        }
        if ((m = path.match(/\/issues\/(\d+)$/))) {
          const issue = findIssue(m[1]);
          if (!issue) return send(404, {});
          if (req.method === 'GET') return send(200, issue);
          if (req.method === 'PATCH') {
            const b = JSON.parse(body);
            if (b.type === 'child') return send(422, { message: 'fake org has no issue type "child"' });
            if (b.title !== undefined) issue.title = b.title;
            if (b.body !== undefined) issue.body = b.body;
            if (b.state !== undefined) issue.state = b.state;
            if (b.labels !== undefined) issue.labels = b.labels.map((x) => ({ name: x }));
            if (b.type !== undefined) issue.type = { name: b.type };
            return send(200, issue);
          }
        }
        send(404, { message: `fake: unhandled ${req.method} ${path}` });
      });
    });
    await new Promise((r) => gh.listen(0, '127.0.0.1', r));
    const GH = `http://127.0.0.1:${gh.address().port}`;
    const syncEnv = {
      GITHUB_TOKEN: 'fake-token', GITHUB_REPOSITORY: 'octo/proj',
      GITHUB_API_URL: GH, GITHUB_GRAPHQL_URL: `${GH}/graphql`,
      GITHUB_SERVER_URL: 'http://ghs.example', GITHUB_REF_NAME: 'main',
      CANONWEAVE_BACKOFF_MS: '1',
    };
    // GitHub WRITES only: REST POST/PATCH, plus GraphQL mutations (GraphQL reads
    // are POSTs to /graphql too — they must not count against idempotency).
    const writes = () => ghLog.filter((l) =>
      (l.method === 'PATCH') ||
      (l.method === 'POST' && !l.url.endsWith('/graphql')) ||
      (l.method === 'POST' && l.url.endsWith('/graphql') && /"query":"mutation/.test(l.body))
    ).length;

    const sy = makeRepo('cli-sync', { syncIssues: true });
    art(sy, { id: 'root', type: 'root', body: 'R1' });
    art(sy, { id: 'child', type: 'child', body: 'C1', ingredients: ['root'], reconciled: { root: fpBody('R1') } });
    art(sy, { id: 'extra', type: 'extra', body: 'E1', ingredients: ['root', 'child'], reconciled: { root: fpBody('R1'), child: fpBody('C1') } });

    // missing token
    const rNoTok = await runCliAsync(['sync-issues'], sy, { ...syncEnv, GITHUB_TOKEN: '' });
    check('sync: refuses without GITHUB_TOKEN', rNoTok.status === 2 && /TW_SYNC_TOKEN/.test(rNoTok.stderr), `status=${rNoTok.status}`);

    // first sync: creates, anchors, board
    const r1 = await runCliAsync(['sync-issues'], sy, syncEnv);
    check('sync: first run exits 0 and creates one issue per artifact', r1.status === 0 && issues.length === 3, `status=${r1.status} issues=${issues.length}`);
    const childFm = parseFrontmatter(readFileSync(join(sy, 'docs', 'trace', 'child.md'), 'utf8'));
    check('sync: binding anchor provenance.issue written into frontmatter', childFm.data.provenance && typeof childFm.data.provenance.issue === 'number', JSON.stringify(childFm.data.provenance));
    const childIssue = issues.find((i) => /\[child\]$/.test(i.title));
    check('sync: issue body carries the marker, file link, and managed-by notice',
      childIssue && childIssue.body.includes('<!-- canonweave-sync:child -->') && childIssue.body.includes('http://ghs.example/octo/proj/blob/main/docs/trace/child.md') && /one-way projection/.test(childIssue.body), '');
    check('sync: native issue type set where the org defines it, label fallback where not',
      issues.find((i) => /\[root\]$/.test(i.title)).type?.name === 'root' && childIssue.type == null && childIssue.labels.some((l) => l.name === 'canonweave:type:child'),
      JSON.stringify(childIssue && childIssue.labels));
    check('sync: type-fallback note printed', /native issue types unavailable for: child/.test(r1.stdout), '');
    check('sync: board created with status field, all items fresh',
      project.created && project.field && project.field.name === 'canonweave-status' && project.items.length === 3 && project.items.every((i) => i.status === 'fresh'),
      JSON.stringify(project.items));
    // sub-issues: sorted order child,extra,root -> child claims root; extra claims child, root goes body-only
    check('sync: derivation edges as sub-issues with deterministic single-parent rule',
      childParent.get(issues.find((i) => /\[root\]$/.test(i.title)).number) === childIssue.number &&
      childParent.get(childIssue.number) === issues.find((i) => /\[extra\]$/.test(i.title)).number &&
      /sub-issues \+2 \(1 body-only\)/.test(r1.stdout), r1.stdout.split('\n').filter((l) => /sub-issues/.test(l)).join(''));

    // idempotent re-run: ZERO GitHub writes
    ghLog = [];
    const r2 = await runCliAsync(['sync-issues'], sy, syncEnv);
    const writeEntries = () => ghLog.filter((l) =>
      (l.method === 'PATCH') ||
      (l.method === 'POST' && !l.url.endsWith('/graphql')) ||
      (l.method === 'POST' && l.url.endsWith('/graphql') && /"query":"mutation/.test(l.body))
    );
    check('sync: idempotent re-run performs zero GitHub writes', r2.status === 0 && writes() === 0 && /unchanged 3/.test(r2.stdout),
      `writes=${writes()} ${JSON.stringify(writeEntries().map((w) => ({ m: w.method, u: w.url, b: (w.body || '').slice(0, 120) })))}`);

    // one-way: issue edits are overwritten, files untouched
    childIssue.body = 'HUMAN EDIT that must not survive';
    childIssue.labels.push({ name: 'keepme' });
    const fileBefore = readFileSync(join(sy, 'docs', 'trace', 'child.md'), 'utf8');
    const r3 = await runCliAsync(['sync-issues'], sy, syncEnv);
    check('sync: issue edits never mutate files; next sync restores the projection',
      r3.status === 0 && /one-way projection/.test(findIssue(childIssue.number).body) && readFileSync(join(sy, 'docs', 'trace', 'child.md'), 'utf8') === fileBefore, '');
    check('sync: human-added labels survive the managed-label merge',
      findIssue(childIssue.number).labels.some((l) => l.name === 'keepme'), JSON.stringify(findIssue(childIssue.number).labels));

    // issue deletion -> projection restored, anchor rebound, artifact untouched
    const oldNumber = childIssue.number;
    issues = issues.filter((i) => i.number !== oldNumber);
    const r4 = await runCliAsync(['sync-issues'], sy, syncEnv);
    const reFm = parseFrontmatter(readFileSync(join(sy, 'docs', 'trace', 'child.md'), 'utf8'));
    const reIssue = issues.find((i) => /\[child\]$/.test(i.title));
    check('sync: deleted issue is re-created on the next run (files untouched)',
      r4.status === 0 && reIssue && reIssue.number !== oldNumber && /rebound/.test(r4.stdout), `status=${r4.status} new=#${reIssue && reIssue.number}`);
    check('sync: anchor re-bound to the new issue number', reFm.data.provenance.issue === (reIssue && reIssue.number), `anchor=${reFm.data.provenance.issue}`);

    // drift: upstream body changes -> child suspect -> label + board status converge
    art(sy, { id: 'root', type: 'root', body: 'R2', extra: { provenance: { issue: issues.find((i) => /\[root\]$/.test(i.title)).number } } });
    const r5 = await runCliAsync(['sync-issues'], sy, syncEnv);
    const childAfter = issues.find((i) => /\[child\]$/.test(i.title));
    const childItem = project.items.find((i) => i.issueNumber === childAfter.number);
    check('sync: suspect drift converges labels and board status',
      r5.status === 0 && childAfter.labels.some((l) => l.name === 'status:suspect') && childItem.status === 'suspect',
      `labels=${JSON.stringify(childAfter.labels.map((l) => l.name))} board=${childItem && childItem.status}`);

    // Projects phase degrades gracefully without a project-scoped token
    ghLog = [];
    const r6 = await runCliAsync(['sync-issues'], sy, { ...syncEnv, CANONWEAVE_PROJECTS_TOKEN: 'no-projects-token' });
    check('sync: board phase skips cleanly without Projects v2 access (issues still sync)',
      r6.status === 0 && /board skipped: no Projects v2 access/.test(r6.stdout), r6.stdout.split('\n').filter((l) => /board/.test(l)).join(''));

    gh.close();
  }

  // ---- verdict ---------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const allPass = passed === results.length;
  console.log('');
  console.log(`selftest: ${passed}/${results.length} checks passed — ${allPass ? 'PASS' : 'FAIL'}`);
  if (allPass) {
    rmSync(ROOT, { recursive: true, force: true });
  } else {
    console.log(`  (fixtures kept for inspection: ${ROOT})`);
  }
  return allPass;
}
