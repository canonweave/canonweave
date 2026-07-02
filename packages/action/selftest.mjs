// selftest.mjs — hermetic self-test for the gate action. Fakes the whole
// GitHub environment: event payload, GITHUB_STEP_SUMMARY / GITHUB_OUTPUT
// files, and the REST API (loopback server records every request). Drives the
// action binary end-to-end against copies of examples/demo-repo.
// Scenarios: clean PR pass · suspect PR fail (annotation + sticky update) ·
// fork degradation (no token) · merge-queue event · config error.
import { mkdirSync, rmSync, writeFileSync, readFileSync, cpSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = join(__dirname, 'index.mjs');
const REPO = resolve(__dirname, '..', '..');
const DEMO = join(REPO, 'examples', 'demo-repo');
const ROOT = join(tmpdir(), 'traceweave-action-selftest'); // fixed, NOT random

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
};

// ---- fake GitHub API --------------------------------------------------------
let apiLog = [];
let existingComments = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    apiLog.push({ method: req.method, url: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { res.writeHead(200); res.end(JSON.stringify(existingComments)); return; }
    if (req.method === 'POST') { res.writeHead(201); res.end(JSON.stringify({ id: 1001 })); return; }
    if (req.method === 'PATCH') { res.writeHead(200); res.end(JSON.stringify({ id: 1001 })); return; }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${server.address().port}`;

// ---- helpers ----------------------------------------------------------------
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GITHUB_') || k.startsWith('INPUT_')) delete env[k];
  }
  return env;
}

let scenarioN = 0;
function runAction(workspace, { token = 'fake-token', event = 'pull_request', prNumber = 7, inputs = {} } = {}) {
  const scratch = join(ROOT, `scratch-${++scenarioN}`);
  mkdirSync(scratch, { recursive: true });
  const summaryFile = join(scratch, 'summary.md');
  const outputFile = join(scratch, 'output.txt');
  const eventFile = join(scratch, 'event.json');
  writeFileSync(summaryFile, '', 'utf8');
  writeFileSync(outputFile, '', 'utf8');
  writeFileSync(eventFile, JSON.stringify(prNumber ? { pull_request: { number: prNumber } } : {}), 'utf8');

  const env = cleanEnv();
  env.GITHUB_WORKSPACE = workspace;
  env.GITHUB_EVENT_NAME = event;
  env.GITHUB_EVENT_PATH = eventFile;
  env.GITHUB_REPOSITORY = 'acme/demo';
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

function makeWorkspace(name) {
  const ws = join(ROOT, name);
  rmSync(ws, { recursive: true, force: true });
  cpSync(DEMO, ws, { recursive: true });
  return ws;
}

// ---- scenarios ----------------------------------------------------------------
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// 1. Clean PR: pass, no annotations, sticky comment CREATED.
{
  apiLog = []; existingComments = [];
  const ws = makeWorkspace('clean');
  const r = await runAction(ws);
  check('clean PR: exit 0', r.status === 0, `status=${r.status} ${r.stderr.slice(0, 120)}`);
  check('clean PR: no error annotations', !/::error/.test(r.stdout));
  check('clean PR: job summary reports PASS', /Traceweave gate: ✅ PASS/.test(r.summary));
  check('clean PR: outputs result=pass, exit-code=0', /result=pass/.test(r.output) && /exit-code=0/.test(r.output));
  const post = apiLog.find((x) => x.method === 'POST');
  check('clean PR: sticky comment created via API (marker present)',
    !!post && post.url === '/repos/acme/demo/issues/7/comments' && post.body.includes('traceweave-gate'),
    apiLog.map((x) => `${x.method} ${x.url}`).join(' | '));
}

// 2. Suspect PR: mutate an upstream -> fail, annotation names the link, sticky comment UPDATED in place.
{
  apiLog = []; existingComments = [{ id: 1001, body: '<!-- traceweave-gate -->\nold report' }];
  const ws = makeWorkspace('suspect');
  appendFileSync(join(ws, 'docs', 'trace', 'product-brief.md'), '\nThe outcome promise changed in this PR.\n', 'utf8');
  const r = await runAction(ws);
  check('suspect PR: exit 1', r.status === 1, `status=${r.status}`);
  check('suspect PR: annotation on the downstream file with a line number',
    /::error file=docs\/trace\/requirements\.md,line=\d+/.test(r.stdout), r.stdout.split('\n').find((l) => l.startsWith('::error')) || '(none)');
  check('suspect PR: annotation names the suspect link', /requirements <- product-brief/.test(r.stdout));
  check('suspect PR: summary shows the suspect table with fingerprints', /Suspect ingredient links/.test(r.summary) && /`product-brief`/.test(r.summary));
  check('suspect PR: outputs result=fail, suspects=1', /result=fail/.test(r.output) && /suspects=1/.test(r.output));
  const patch = apiLog.find((x) => x.method === 'PATCH');
  const post = apiLog.find((x) => x.method === 'POST');
  check('suspect PR: sticky comment UPDATED in place (PATCH 1001, no new POST)',
    !!patch && patch.url === '/repos/acme/demo/issues/comments/1001' && !post,
    apiLog.map((x) => `${x.method} ${x.url}`).join(' | '));
}

// 3. Fork degradation: no token -> no API calls, summary + annotations + exit code still work.
{
  apiLog = []; existingComments = [];
  const ws = makeWorkspace('fork');
  appendFileSync(join(ws, 'docs', 'trace', 'product-brief.md'), '\nFork PR change.\n', 'utf8');
  const r = await runAction(ws, { token: null });
  check('fork PR: exit 1 still enforced', r.status === 1, `status=${r.status}`);
  check('fork PR: zero API calls (no token)', apiLog.length === 0, `calls=${apiLog.length}`);
  check('fork PR: job summary still written (fork-safe surface)', /Traceweave gate: ❌ FAIL/.test(r.summary));
  check('fork PR: skip reason surfaced as a notice', /::notice::sticky comment: skipped \(no GITHUB_TOKEN/.test(r.stdout));
}

// 4. Merge-queue event: no PR context -> comment skipped gracefully, gate still runs.
{
  apiLog = []; existingComments = [];
  const ws = makeWorkspace('mq');
  const r = await runAction(ws, { event: 'merge_group', prNumber: null });
  check('merge_group: exit 0 on clean graph', r.status === 0, `status=${r.status}`);
  check('merge_group: comment skipped (no PR context), zero API calls',
    apiLog.length === 0 && /sticky comment: skipped \(event merge_group/.test(r.stdout));
}

// 5. Config error: exit 2 with setup guidance.
{
  apiLog = []; existingComments = [];
  const ws = makeWorkspace('badcfg');
  writeFileSync(join(ws, 'traceweave.yml'), 'surprise: 1\n', 'utf8');
  const r = await runAction(ws);
  check('config error: exit 2', r.status === 2, `status=${r.status}`);
  check('config error: error annotation emitted', /::error .*configuration error/.test(r.stdout));
  check('config error: summary carries setup guidance', /CONFIG ERROR \(exit 2\)/.test(r.summary) && /TW_CONFIG_UNKNOWN_KEY/.test(r.summary));
  check('config error: output exit-code=2', /exit-code=2/.test(r.output));
}

// 6. Profile input: gate a non-default profile through the action input.
{
  apiLog = []; existingComments = [];
  const ws = makeWorkspace('profile');
  const r = await runAction(ws, { inputs: { profile: 'ready-to-ship' } });
  check('profile input: evaluated profile is ready-to-ship and passes',
    r.status === 0 && /profile=ready-to-ship/.test(r.output) && /profile `ready-to-ship`/.test(r.summary),
    `status=${r.status}`);
}

await new Promise((r) => server.close(r));
const passed = results.filter((r) => r.pass).length;
const allPass = passed === results.length;
console.log('');
console.log(`action selftest: ${passed}/${results.length} checks passed — ${allPass ? 'PASS' : 'FAIL'}`);
if (allPass) rmSync(ROOT, { recursive: true, force: true });
else console.log(`  (fixtures kept: ${ROOT})`);
process.exit(allPass ? 0 : 1);
