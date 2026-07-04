// serve.mjs — `canonweave serve`: local read-only dashboard (WS6, design §9).
// Serves the LAST BUILT state: graph.json (written by `canonweave build`) plus
// the artifact files on disk. It never rebuilds, never resolves, never writes.
// Read-only by construction: only GET routes exist; every other method is 405.
// Localhost tool, no auth — bound to 127.0.0.1 with a Host-header allowlist
// (a foreign Host means DNS rebinding, not a local browser).
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  loadOntology, loadArtifacts, renderCheck, boardStatus, fingerprint,
} from '../../engine/src/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_HTML_PATH = join(__dirname, 'serve-app.html');
const DEFAULT_PORT = 8791;
const HOST = '127.0.0.1';

function rel(p, root) {
  // display/link paths are browser-side surfaces: POSIX separators always
  return (p.startsWith(root) ? p.slice(root.length + 1) : p).split('\\').join('/');
}

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const h = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}

// One read pass assembling everything the dashboard needs. Called per request
// so a `canonweave build` in another terminal shows up on plain refresh.
export function readState(cfg, onto) {
  if (!existsSync(cfg.graphPath)) {
    throw new ConfigError('TW_SERVE_NO_GRAPH',
      `graph not found at ${cfg.graphPath} — run "canonweave build" first`);
  }
  const graph = JSON.parse(readFileSync(cfg.graphPath, 'utf8'));
  const byId = loadArtifacts(cfg.roots);
  const artifacts = {};
  for (const id of Object.keys(byId).sort()) {
    const r = byId[id];
    artifacts[id] = { path: rel(r.path, cfg.repoRoot), title: r.data.title || id };
  }
  const stale = builtStateDiverged(graph, byId, cfg.repoRoot);
  const status = {};
  for (const n of graph.nodes) status[n.id] = boardStatus(n);
  return {
    repo: basename(cfg.repoRoot),
    config: {
      graph: rel(cfg.graphPath, cfg.repoRoot),
      roots: cfg.roots.map((r) => rel(r, cfg.repoRoot)),
      defaultProfile: graph.defaultProfile,
    },
    tiers: onto.tiers,
    stale,
    graph,
    status,
    report: renderCheck(graph),
    artifacts,
  };
}

// Staleness hint (UI banner only): the dashboard shows the state of the LAST
// BUILD; this detects local edits that graph.json does not reflect yet.
// Content-based, no clocks (git checkouts scramble mtimes): compares the
// artifact set, each node's type/status/ingredients, and the fingerprint of
// locally-readable sources (inline bodies, repo files). url/plugin sources
// would need real resolution, so they are not re-checked here.
function builtStateDiverged(graph, byId, repoRoot) {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const fileIds = Object.keys(byId);
  if (fileIds.length !== nodeIds.size || fileIds.some((id) => !nodeIds.has(id))) return true;
  const sortedJson = (a) => JSON.stringify((a || []).slice().sort());
  for (const n of graph.nodes) {
    const rec = byId[n.id];
    const data = rec.data;
    if (data.type !== n.type) return true;
    if ((data.status || 'present') !== n.status) return true;
    const ingredients = (data.recipe && data.recipe.ingredients) || [];
    if (sortedJson(ingredients) !== sortedJson(n.ingredients)) return true;
    if (n.unresolved) continue; // unresolved at build time: nothing local to compare
    const kind = (data.source && data.source.kind) || 'inline';
    if (kind === 'inline') {
      if (fingerprint(rec.body) !== n.fingerprint) return true;
    } else if (kind === 'repo' && data.source.path) {
      const abs = isAbsolute(data.source.path) ? data.source.path : resolve(repoRoot, data.source.path);
      try {
        if (fingerprint(readFileSync(abs, 'utf8')) !== n.fingerprint) return true;
      } catch {
        return true; // was resolved at build, unreadable now -> diverged
      }
    }
  }
  return false;
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendErr(res, code, twCode, message) {
  send(res, code, JSON.stringify({ error: twCode, message }));
}

export function createDashboardServer(cfg, onto, appHtml) {
  return createServer((req, res) => {
    try {
      if (req.method !== 'GET') {
        return sendErr(res, 405, 'TW_SERVE_READ_ONLY', 'read-only dashboard: GET only');
      }
      if (!hostAllowed(req.headers.host)) {
        return sendErr(res, 403, 'TW_SERVE_BAD_HOST', 'localhost tool: foreign Host header rejected');
      }
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      if (url === '/' || url === '/index.html') {
        return send(res, 200, appHtml, 'text/html; charset=utf-8');
      }
      if (url === '/api/state') {
        return send(res, 200, JSON.stringify(readState(cfg, onto)));
      }
      if (url.startsWith('/api/artifact/')) {
        const id = url.slice('/api/artifact/'.length);
        // ids come from the loaded artifact index — the request never names a
        // filesystem path, so there is no traversal surface to sanitize.
        const byId = loadArtifacts(cfg.roots);
        const rec = byId[id];
        if (!rec) return sendErr(res, 404, 'TW_NO_SUCH_ARTIFACT', `no artifact "${id}"`);
        return send(res, 200, JSON.stringify({
          id,
          path: rel(rec.path, cfg.repoRoot),
          content: readFileSync(rec.path, 'utf8'),
        }));
      }
      return sendErr(res, 404, 'TW_SERVE_NOT_FOUND', `no such route: ${url}`);
    } catch (e) {
      const code = e && e.code && String(e.code).startsWith('TW_') ? e.code : 'TW_SERVE_ERROR';
      return sendErr(res, 500, code, String(e && e.message || e));
    }
  });
}

// Resolves when the server closes (Ctrl-C) — keeps the CLI process alive.
export async function runServe({ cfg, port }) {
  const p = port == null ? DEFAULT_PORT : Number(port);
  if (!Number.isInteger(p) || p < 0 || p > 65535) {
    throw new ConfigError('TW_CLI_USAGE', `serve: --port must be an integer 0..65535 (got "${port}")`);
  }
  const onto = loadOntology(cfg.ontologyPath);
  readState(cfg, onto); // fail fast (exit 2) before binding: no graph -> no server
  const appHtml = readFileSync(APP_HTML_PATH, 'utf8');
  const server = createDashboardServer(cfg, onto, appHtml);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, HOST, resolve);
  }).catch((e) => {
    throw new ConfigError('TW_SERVE_LISTEN', `cannot listen on ${HOST}:${p}: ${e.message}`);
  });
  const actual = server.address().port;
  console.log(`canonweave serve — http://${HOST}:${actual}`);
  console.log(`  repo: ${basename(cfg.repoRoot)} · profile: ${cfg.gateProfile} · read-only (state as of the last build) · Ctrl-C to stop`);
  return new Promise((resolve) => server.on('close', resolve));
}
