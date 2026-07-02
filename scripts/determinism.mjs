// determinism.mjs — the determinism snapshot (design sections 1.3, 4.5, 11).
//
// Proves, for every shipped template and for the committed demo repo:
//   1. build twice -> byte-identical graph.json
//   2. a CRLF copy of the artifact tree -> byte-identical graph.json
//   3. examples/demo-repo: a fresh build matches the COMMITTED graph.json
//      (catches engine/demo drift before it ships)
// Exit 0 on success, 1 on any mismatch. Run in CI on ubuntu+windows+macos.
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, cpSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const BIN = join(REPO, 'packages', 'cli', 'bin', 'traceweave.mjs');
const SCRATCH = join(tmpdir(), 'traceweave-determinism');

let failures = 0;
function report(name, ok, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

function run(args, cwd) {
  execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
}

function graphBytes(dir) {
  return readFileSync(join(dir, 'docs', 'trace', 'graph.json'), 'utf8');
}

// Recursively rewrite every text file to CRLF line endings.
function crlfTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { crlfTree(p); continue; }
    if (!/\.(md|yml|yaml|json)$/.test(entry.name)) continue;
    const t = readFileSync(p, 'utf8');
    writeFileSync(p, t.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
  }
}

function checkTemplate(template) {
  const a = join(SCRATCH, `${template}-a`);
  run(['init', '--template', template, '--dir', a], SCRATCH);
  const g1 = graphBytes(a);
  run(['build'], a);
  const g2 = graphBytes(a);
  report(`${template}: build twice -> byte-identical graph.json`, g1 === g2);

  // CRLF copy of the whole initialized tree (as a Windows checkout would look)
  const b = join(SCRATCH, `${template}-b`);
  cpSync(a, b, { recursive: true });
  crlfTree(join(b, 'docs'));
  writeFileSync(join(b, 'traceweave.yml'), readFileSync(join(b, 'traceweave.yml'), 'utf8').replace(/\n/g, '\r\n'), 'utf8');
  run(['build'], b);
  const g3 = graphBytes(b);
  report(`${template}: CRLF checkout -> byte-identical graph.json (section 4.5)`, g1 === g3);
}

function checkDemoRepo() {
  const demo = join(REPO, 'examples', 'demo-repo');
  if (!existsSync(join(demo, 'traceweave.yml'))) {
    report('examples/demo-repo exists', false, 'missing — generate it with init and commit it');
    return;
  }
  const committed = graphBytes(demo);
  const copy = join(SCRATCH, 'demo-copy');
  cpSync(demo, copy, { recursive: true });
  run(['build'], copy);
  const rebuilt = graphBytes(copy);
  report('demo-repo: fresh build matches the COMMITTED graph.json', committed === rebuilt,
    committed === rebuilt ? '' : 'engine output drifted from the committed demo state');
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
console.log('determinism snapshot:');
checkTemplate('generic-software');
checkTemplate('product-lifecycle');
checkDemoRepo();
rmSync(SCRATCH, { recursive: true, force: true });
console.log(failures === 0 ? 'determinism: PASS' : `determinism: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
