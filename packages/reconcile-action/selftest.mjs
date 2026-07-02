// selftest.mjs — hermetic self-test for the reconcile action. Fakes the whole
// GitHub environment: a STATEFUL loopback REST API (PR store: create, list by
// head, patch, close; comments; labels; ref deletion) and a local BARE git
// remote, so branch pushes and PR mechanics run end-to-end with no network.
// Scenarios: missing token · clean graph no-op · suspect -> branch + PR
// (merge-greens proof: the branch checkout gates green) · idempotent re-run
// (PATCH, no duplicate) · upstream moved again (successor PR + stale closed)
// · brief mode (backend none -> no PR) · deep-chain convergence (waves:
// merge -> next tier suspect -> next PR -> ... -> gate green).
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = join(__dirname, 'index.mjs');
const CLI = resolve(__dirname, '..', 'cli', 'bin', 'traceweave.mjs');
const ROOT = join(tmpdir(), 'traceweave-reconcile-selftest'); // fixed, NOT random

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
};

// ---- stateful fake GitHub API ----------------------------------------------
let apiLog = [];
let prStore = [];   // { number, state, head: { ref }, base, title, body }
let prSeq = 100;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    apiLog.push({ method: req.method, url: req.url, body });
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;

    // GET /repos/o/r/pulls?state=open&head=owner:branch
    let m;
    if (req.method === 'GET' && /\/pulls$/.test(path)) {
      let list = prStore.filter((p) => p.state === (u.searchParams.get('state') || 'open'));
      const head = u.searchParams.get('head');
      if (head) { const ref = head.split(':')[1]; list = list.filter((p) => p.head.ref === ref); }
      res.writeHead(200); res.end(JSON.stringify(list)); return;
    }
    if (req.method === 'POST' && /\/pulls$/.test(path)) {
      const b = JSON.parse(body);
      const pr = { number: ++prSeq, state: 'open', head: { ref: b.head }, base: b.base, title: b.title, body: b.body };
      prStore.push(pr);
      res.writeHead(201); res.end(JSON.stringify(pr)); return;
    }
    if ((m = path.match(/\/pulls\/(\d+)$/)) && req.method === 'PATCH') {
      const pr = prStore.find((p) => p.number === Number(m[1]));
      if (!pr) { res.writeHead(404); res.end('{}'); return; }
      const b = JSON.parse(body);
      if (b.state) pr.state = b.state;
      if (b.title) pr.title = b.title;
      if (b.body) pr.body = b.body;
      res.writeHead(200); res.end(JSON.stringify(pr)); return;
    }
    if (/\/issues\/\d+\/(comments|labels)$/.test(path) && req.method === 'POST') {
      res.writeHead(201); res.end('{"id":1}'); return;
    }
    if (/\/git\/refs\/heads\//.test(path) && req.method === 'DELETE') {
      res.writeHead(204); res.end(); return;
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${server.address().port}`;

// ---- fixture: root/child repo with template drafter, bare origin ------------
const ONTOLOGY = [
  'version: 1', 'tiers: [base, derived]', 'types:',
  '  root:', '    tier: base', '    ingredients: []',
  '  child:', '    tier: derived', '    ingredients: [root]',
  'profiles:', '  core:', '    required: [root, child]', '',
].join('\n');
const CONFIG = [
  'roots: [docs/trace]', 'ontology: docs/trace/ontology.yml',
  'graph: docs/trace/graph.json', 'gate: core',
  'drafter:', '  backend: template', '',
].join('\n');

function art(dir, { id, type, body, ingredients = [], reconciled = {} }) {
  const L = ['---', 'traceweave: 1', `id: ${id}`, `type: ${type}`, `title: ${id}`, 'source:', '  kind: inline'];
  if (ingredients.length) {
    L.push('recipe:', `  ingredients: [${ingredients.join(', ')}]`, `  build: derive ${id} from ${ingredients.join('+')}`);
  }
  const rk = Object.keys(reconciled);
  if (rk.length) { L.push('reconciled:'); for (const k of rk) L.push(`  ${k}: "${reconciled[k]}"`); }
  L.push('status: present', '---', '', body, '');
  writeFileSync(join(dir, 'docs', 'trace', `${id}.md`), L.join('\n'), 'utf8');
}

function sh(cwd, cmd, ...args) { return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim(); }
function g(cwd, ...args) { return sh(cwd, 'git', ...args); }
function cli(cwd, ...args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
    return { status: 0, out };
  } catch (e) { return { status: e.status ?? -1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}
function fpBody(s) {
  return 'sha256:' + execFileSync(process.execPath,
    ['-e', `const{createHash}=require('node:crypto');process.stdout.write('sha256:'===''?'':createHash('sha256').update(process.argv[1].replace(/\\r\\n/g,'\\n')).digest('hex'))`, `\n${s}\n`],
    { encoding: 'utf8' });
}

function makeFixture(name) {
  const work = join(ROOT, name, 'work');
  const origin = join(ROOT, name, 'origin.git');
  mkdirSync(join(work, 'docs', 'trace'), { recursive: true });
  writeFileSync(join(work, 'traceweave.yml'), CONFIG, 'utf8');
  writeFileSync(join(work, 'docs', 'trace', 'ontology.yml'), ONTOLOGY, 'utf8');
  art(work, { id: 'root', type: 'root', body: 'ROOT-v1' });
  const fp1 = fpBody('ROOT-v1');
  art(work, { id: 'child', type: 'child', body: 'CHILD-v1', ingredients: ['root'], reconciled: { root: fp1 } });
  g(work, 'init', '-q', '-b', 'main');
  g(work, 'config', 'user.name', 'fixture');
  g(work, 'config', 'user.email', 'fixture@local');
  const b = cli(work, 'build');
  if (b.status !== 0) throw new Error(`fixture build failed: ${b.out}`);
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'fixture: green baseline');
  execFileSync('git', ['clone', '-q', '--bare', work, origin], { encoding: 'utf8' });
  g(work, 'remote', 'add', 'origin', origin);
  return { work, origin };
}

let scenarioN = 0;
function runAction(workspace, { token = 'fake-token', inputs = {} } = {}) {
  const scratch = join(ROOT, `scratch-${++scenarioN}`);
  mkdirSync(scratch, { recursive: true });
  const summaryFile = join(scratch, 'summary.md');
  const outputFile = join(scratch, 'output.txt');
  writeFileSync(summaryFile, '', 'utf8');
  writeFileSync(outputFile, '', 'utf8');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GITHUB_') || k.startsWith('INPUT_')) delete env[k];
  env.GITHUB_WORKSPACE = workspace;
  env.GITHUB_EVENT_NAME = 'push';
  env.GITHUB_REPOSITORY = 'acme/demo';
  env.GITHUB_REF_NAME = 'main';
  env.GITHUB_API_URL = API;
  env.GITHUB_STEP_SUMMARY = summaryFile;
  env.GITHUB_OUTPUT = outputFile;
  if (token) env.GITHUB_TOKEN = token;
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [INDEX], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolvePromise({
        status: code == null ? -1 : code, stdout, stderr,
        summary: readFileSync(summaryFile, 'utf8'),
        output: readFileSync(outputFile, 'utf8'),
      });
    });
  });
}

const out = (r, k) => (r.output.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];

// ---- run ---------------------------------------------------------------------
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
console.log('reconcile-action selftest:');

const fx = makeFixture('fixA');

// 1. missing token -> exit 2
{
  const r = await runAction(fx.work, { token: null });
  check('no GITHUB_TOKEN -> exit 2 with a clear error', r.status === 2 && /GITHUB_TOKEN/.test(r.stdout));
}

// 2. clean graph -> no-op
{
  const r = await runAction(fx.work);
  check('clean graph -> exit 0, result=clean, zero PRs', r.status === 0 && out(r, 'result') === 'clean' && out(r, 'suspects') === '0');
  const branches = g(fx.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
  check('clean graph -> no reconcile branches pushed', !branches.includes('traceweave/reconcile/'));
}

// 3. suspect -> branch + PR; the branch gates green (merge-is-review proof)
let firstPrNumber = null;
let branchA = null;
{
  art(fx.work, { id: 'root', type: 'root', body: 'ROOT-v2' }); // REAL upstream change
  g(fx.work, 'add', '-A'); g(fx.work, 'commit', '-q', '-m', 'upstream: root v2');
  apiLog = [];
  const r = await runAction(fx.work);
  check('suspect downstream -> exit 0, one PR created', r.status === 0 && out(r, 'prs-created') === '1' && out(r, 'result') === 'ok', `status=${r.status} created=${out(r, 'prs-created')}`);
  const branches = g(fx.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
  branchA = branches.find((b) => b.startsWith('traceweave/reconcile/child--'));
  check('idempotency-key branch pushed: traceweave/reconcile/child--<fp8>', !!branchA, branches.join(','));
  const post = apiLog.find((l) => l.method === 'POST' && /\/pulls$/.test(l.url.split('?')[0]));
  const postBody = post ? JSON.parse(post.body) : {};
  check('PR created against base main with the reconcile head', post && postBody.base === 'main' && postBody.head === branchA);
  check('PR body carries fingerprints + merge-is-review contract',
    /reconciled/.test(postBody.body || '') && /Merging this PR is the review/i.test(postBody.body || ''));
  firstPrNumber = prStore.find((p) => p.head.ref === branchA)?.number ?? null;

  // merge-is-review: the branch state must gate green
  const clone = join(ROOT, 'fixA', 'branch-check');
  execFileSync('git', ['clone', '-q', '-b', branchA, fx.origin, clone], { encoding: 'utf8' });
  const gate = cli(clone, 'gate');
  check('the reconcile branch gates GREEN (merging greens the next run)', gate.status === 0, gate.out.slice(0, 120));
  const childMd = readFileSync(join(clone, 'docs', 'trace', 'child.md'), 'utf8');
  check('branch commit updates the artifact body AND its reconciled fingerprint',
    childMd.includes('Reconciled from upstream') && !childMd.includes('CHILD-v1'));
}

// 4. idempotent re-run -> PATCH, no duplicate
{
  apiLog = [];
  const r = await runAction(fx.work);
  check('re-run updates the open PR instead of duplicating', r.status === 0 && out(r, 'prs-updated') === '1' && out(r, 'prs-created') === '0');
  const posts = apiLog.filter((l) => l.method === 'POST' && /\/pulls$/.test(l.url.split('?')[0]));
  check('re-run performs zero PR-create calls', posts.length === 0);
  const openForChild = prStore.filter((p) => p.state === 'open' && p.head.ref.startsWith('traceweave/reconcile/child--'));
  check('exactly one open reconcile PR for the downstream', openForChild.length === 1);
}

// 5. upstream moves again -> successor PR, stale closed with a link
{
  art(fx.work, { id: 'root', type: 'root', body: 'ROOT-v3' });
  g(fx.work, 'add', '-A'); g(fx.work, 'commit', '-q', '-m', 'upstream: root v3');
  apiLog = [];
  const r = await runAction(fx.work);
  check('new fp8 -> successor PR created', r.status === 0 && out(r, 'prs-created') === '1');
  check('stale PR closed in the same run', out(r, 'prs-closed') === '1');
  const oldPr = prStore.find((p) => p.number === firstPrNumber);
  check('the first PR is now state=closed', oldPr && oldPr.state === 'closed');
  const comment = apiLog.find((l) => l.method === 'POST' && /\/issues\/\d+\/comments$/.test(l.url));
  check('stale PR got a successor-link comment', comment && /Superseded by #\d+/.test(JSON.parse(comment.body).body));
  const del = apiLog.find((l) => l.method === 'DELETE' && /\/git\/refs\/heads\//.test(l.url));
  check('stale branch ref deleted', !!del);
  const openForChild = prStore.filter((p) => p.state === 'open' && p.head.ref.startsWith('traceweave/reconcile/child--'));
  check('succession leaves exactly one open PR', openForChild.length === 1);
}

// 6. brief mode (backend none) -> no PR, surfaced in summary
{
  const fb = makeFixture('fixB');
  writeFileSync(join(fb.work, 'traceweave.yml'), CONFIG.replace('backend: template', 'backend: none'), 'utf8');
  art(fb.work, { id: 'root', type: 'root', body: 'ROOT-vX' });
  g(fb.work, 'add', '-A'); g(fb.work, 'commit', '-q', '-m', 'upstream + brief config');
  const before = prStore.length;
  const r = await runAction(fb.work);
  check('brief mode -> exit 0, briefs=1, zero PRs', r.status === 0 && out(r, 'briefs') === '1' && out(r, 'prs-created') === '0');
  check('brief surfaced in the job summary', /brief/.test(r.summary));
  check('brief mode pushed no branches', !g(fb.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').includes('traceweave/reconcile/'));
  check('brief mode created no PR objects', prStore.length === before);
}

// 7. deep chain: reconcile waves converge to green (the ripple is the point)
{
  const name = 'fixC';
  const work = join(ROOT, name, 'work');
  const origin = join(ROOT, name, 'origin.git');
  mkdirSync(join(work, 'docs', 'trace'), { recursive: true });
  const ONTO3 = [
    'version: 1', 'tiers: [base, mid, leaf]', 'types:',
    '  root:', '    tier: base', '    ingredients: []',
    '  mid:', '    tier: mid', '    ingredients: [root]',
    '  leaf:', '    tier: leaf', '    ingredients: [mid]',
    'profiles:', '  core:', '    required: [root, mid, leaf]', '',
  ].join('\n');
  writeFileSync(join(work, 'traceweave.yml'), CONFIG, 'utf8');
  writeFileSync(join(work, 'docs', 'trace', 'ontology.yml'), ONTO3, 'utf8');
  art(work, { id: 'root', type: 'root', body: 'R1' });
  art(work, { id: 'mid', type: 'mid', body: 'M1', ingredients: ['root'], reconciled: { root: fpBody('R1') } });
  art(work, { id: 'leaf', type: 'leaf', body: 'L1', ingredients: ['mid'], reconciled: { mid: fpBody('M1') } });
  g(work, 'init', '-q', '-b', 'main');
  g(work, 'config', 'user.name', 'fixture'); g(work, 'config', 'user.email', 'fixture@local');
  const b0 = cli(work, 'build');
  if (b0.status !== 0) throw new Error('fixC build failed: ' + b0.out);
  g(work, 'add', '-A'); g(work, 'commit', '-q', '-m', 'green baseline');
  execFileSync('git', ['clone', '-q', '--bare', work, origin], { encoding: 'utf8' });
  g(work, 'remote', 'add', 'origin', origin);

  art(work, { id: 'root', type: 'root', body: 'R2' });
  g(work, 'add', '-A'); g(work, 'commit', '-q', '-m', 'upstream: root v2');

  // wave 1: only the DIRECT dependent (mid) is drafted
  const w1 = await runAction(work);
  check('cascade wave 1: only the direct dependent gets a PR', w1.status === 0 && out(w1, 'downstreams') === '1' && out(w1, 'prs-created') === '1');
  const wave1Branch = g(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').find((x) => x.startsWith('traceweave/reconcile/mid--'));
  check('cascade wave 1: branch is for mid', !!wave1Branch, wave1Branch || '(none)');

  // merge wave 1 (fast-forward the reconcile commit onto main) -> leaf goes suspect
  g(work, 'fetch', '-q', 'origin', wave1Branch);
  g(work, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  const w2 = await runAction(work);
  check('cascade wave 2: merging surfaced the NEXT tier (leaf) and drafted it', w2.status === 0 && out(w2, 'prs-created') === '1');
  const wave2Branch = g(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').find((x) => x.startsWith('traceweave/reconcile/leaf--'));
  check('cascade wave 2: branch is for leaf', !!wave2Branch, wave2Branch || '(none)');

  // merge wave 2 -> the chain is fully re-reviewed, gate green, reconcile no-ops
  g(work, 'fetch', '-q', 'origin', wave2Branch);
  g(work, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  const gate = cli(work, 'gate');
  check('cascade converged: gate is GREEN after the waves', gate.status === 0, gate.out.slice(0, 100));
  const w3 = await runAction(work);
  check('cascade converged: next reconcile run is a clean no-op', w3.status === 0 && out(w3, 'result') === 'clean');
}

server.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\nreconcile-action selftest: ${results.length - failed}/${results.length} checks passed — ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
