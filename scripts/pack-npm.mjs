// pack-npm.mjs — assemble the publishable npm package (design §2: ONE package
// `traceweave` = engine + CLI + templates) into dist-npm/.
//
// The monorepo runs on cross-package RELATIVE imports (zero npm install).
// Publishing packages/cli alone would break them, so the pack preserves the
// exact packages/ tree shape inside the artifact — zero import rewrites,
// still zero runtime dependencies. The GitHub Action is deliberately NOT in
// the npm artifact (consumed via the action ref, design §2).
//
// Verify locally:  node scripts/pack-npm.mjs && node dist-npm/packages/cli/bin/traceweave.mjs selftest
import { rmSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const DIST = join(REPO, 'dist-npm');

const cliPkg = JSON.parse(readFileSync(join(REPO, 'packages', 'cli', 'package.json'), 'utf8'));

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

cpSync(join(REPO, 'packages', 'engine', 'src'), join(DIST, 'packages', 'engine', 'src'), { recursive: true });
cpSync(join(REPO, 'packages', 'cli', 'bin'), join(DIST, 'packages', 'cli', 'bin'), { recursive: true });
cpSync(join(REPO, 'packages', 'cli', 'src'), join(DIST, 'packages', 'cli', 'src'), { recursive: true });
cpSync(join(REPO, 'templates'), join(DIST, 'templates'), { recursive: true });
cpSync(join(REPO, 'docs'), join(DIST, 'docs'), { recursive: true });
for (const f of ['README.md', 'LICENSE', 'NOTICE', 'SECURITY.md']) {
  cpSync(join(REPO, f), join(DIST, f));
}

const pkg = {
  name: 'traceweave',
  version: cliPkg.version,
  description: 'GitHub-native artifact traceability: files as the system of record, deterministic derivation graph, suspect links, AI reconcile behind a human PR gate. Zero runtime dependencies.',
  license: 'Apache-2.0',
  type: 'module',
  bin: { traceweave: 'packages/cli/bin/traceweave.mjs' },
  exports: { '.': './packages/engine/src/index.mjs' },
  files: ['packages', 'templates', 'docs', 'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md'],
  repository: { type: 'git', url: 'git+https://github.com/traceweavehq/traceweave.git' },
  homepage: 'https://github.com/traceweavehq/traceweave#readme',
  bugs: { url: 'https://github.com/traceweavehq/traceweave/issues' },
  keywords: ['traceability', 'requirements', 'alm', 'documentation', 'ci', 'github-actions', 'deterministic'],
  engines: { node: '>=20' },
};
writeFileSync(join(DIST, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`packed traceweave@${pkg.version} -> dist-npm/ (engine + cli + templates + docs)`);
