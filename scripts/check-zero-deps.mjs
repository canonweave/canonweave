// check-zero-deps.mjs — enforce the zero-runtime-dependency invariant
// (design section 1.4: the dependency tree IS the audit).
//
//   1. No package.json under packages/ may declare any dependency field.
//   2. Every static import / export-from / dynamic-import STRING LITERAL in
//      packages/**/*.mjs must be relative ('./', '../') or a node: builtin.
// Exit 0 clean, 1 on violation.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const PKGS = join(REPO, 'packages');

let violations = 0;
function violate(msg) { console.error(`  [VIOLATION] ${msg}`); violations++; }

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies'];
for (const f of walk(PKGS)) {
  if (f.endsWith('package.json')) {
    const pkg = JSON.parse(readFileSync(f, 'utf8'));
    for (const field of DEP_FIELDS) {
      if (pkg[field] && Object.keys(pkg[field]).length > 0) {
        violate(`${f}: declares ${field} (${Object.keys(pkg[field]).join(', ')})`);
      }
    }
  }
  if (f.endsWith('.mjs')) {
    const src = readFileSync(f, 'utf8');
    const specs = [];
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);
    for (const m of src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
    for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
    for (const spec of specs) {
      const ok = spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:');
      if (!ok) violate(`${f}: non-builtin, non-relative import "${spec}"`);
    }
  }
}

console.log(violations === 0
  ? 'zero-deps: PASS — engine/cli/action import only node: builtins and relative modules'
  : `zero-deps: FAIL (${violations} violation(s))`);
process.exit(violations === 0 ? 0 : 1);
