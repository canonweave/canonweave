// resolve.mjs — source resolvers. Contract (kept verbatim from the prototype,
// generalized to allow async): resolve(node, ctx) -> { content, resolver,
// unresolved, error }. This is the plugin seam (design section 5).
//
// Builtin kinds:
//   inline  -> the markdown body of the recipe file IS the content (default).
//   repo    -> read the file at source.path relative to the repo root.
//   url     -> HTTP(S) GET source.url; cache to .canonweave/cache/<id>.content;
//              cache fallback when offline. Cache files are COMMITTED by design
//              so remote-sourced builds stay deterministic and offline-safe in CI.
// Plugin kinds:
//   loaded from canonweave.yml `resolvers:` — each module exports
//   `resolvers = { <kind>: (node, ctx) => result | Promise<result> }`.
//   Internal-only kinds (e.g. Feishu) live in private adapter packages, not here.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from './errors.mjs';

export function cachePath(cacheDir, id) {
  return join(cacheDir, `${id}.content`);
}

export function readCache(cacheDir, id) {
  const p = cachePath(cacheDir, id);
  if (existsSync(p)) return readFileSync(p, 'utf8');
  return null;
}

export function writeCache(cacheDir, id, content) {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath(cacheDir, id), content, 'utf8');
}

const BUILTIN_KINDS = ['inline', 'repo', 'url'];

// Load resolver plugin modules named in canonweave.yml. Returns a Map of
// kind -> resolver function. Collisions with builtins or other plugins error.
export async function loadResolverPlugins(resolverModules = []) {
  const kinds = new Map();
  for (const modPath of resolverModules) {
    let mod;
    try {
      mod = await import(pathToFileURL(modPath).href);
    } catch (e) {
      throw new ConfigError('TW_PLUGIN_LOAD', `resolver plugin ${modPath}: import failed: ${e.message}`);
    }
    const table = mod.resolvers;
    if (table === null || typeof table !== 'object' || Array.isArray(table)) {
      throw new ConfigError('TW_PLUGIN_SHAPE',
        `resolver plugin ${modPath}: must export "resolvers" — a map of kind -> function`);
    }
    for (const [kind, fn] of Object.entries(table)) {
      if (typeof fn !== 'function') {
        throw new ConfigError('TW_PLUGIN_SHAPE', `resolver plugin ${modPath}: resolver "${kind}" is not a function`);
      }
      if (BUILTIN_KINDS.includes(kind)) {
        throw new ConfigError('TW_PLUGIN_COLLISION',
          `resolver plugin ${modPath}: kind "${kind}" would override a builtin resolver`);
      }
      if (kinds.has(kind)) {
        throw new ConfigError('TW_PLUGIN_COLLISION',
          `resolver plugin ${modPath}: kind "${kind}" already registered by another plugin`);
      }
      kinds.set(kind, fn);
    }
  }
  return kinds;
}

async function resolveUrl(node, ctx) {
  const source = node.source || {};
  if (!source.url || typeof source.url !== 'string') {
    return { content: '', resolver: 'url', unresolved: true, error: 'url source missing source.url' };
  }
  const doFetch = ctx.fetchImpl || globalThis.fetch;
  const timeoutMs = ctx.urlTimeoutMs || 30000;
  try {
    const res = await doFetch(source.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'canonweave' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = await res.text();
    writeCache(ctx.cacheDir, node.id, content);
    return { content, resolver: 'url', unresolved: false, error: null };
  } catch (e) {
    const cached = readCache(ctx.cacheDir, node.id);
    if (cached != null) {
      return { content: cached, resolver: 'url:cache', unresolved: false, error: `live fetch failed, used cache: ${e.message}` };
    }
    return { content: '', resolver: 'url', unresolved: true, error: `url fetch failed and no cache: ${e.message}` };
  }
}

// node: { id, source, body }    ctx: { repoRoot, cacheDir, plugins?, fetchImpl?, urlTimeoutMs? }
export async function resolveSource(node, ctx) {
  const source = node.source || { kind: 'inline' };
  const kind = source.kind || 'inline';

  if (kind === 'inline') {
    return { content: node.body == null ? '' : node.body, resolver: 'inline', unresolved: false, error: null };
  }

  if (kind === 'repo') {
    if (!source.path) {
      return { content: '', resolver: 'repo', unresolved: true, error: 'repo source missing source.path' };
    }
    const abs = isAbsolute(source.path) ? source.path : pathResolve(ctx.repoRoot, source.path);
    try {
      const content = readFileSync(abs, 'utf8');
      return { content, resolver: 'repo', unresolved: false, error: null };
    } catch (e) {
      return { content: '', resolver: 'repo', unresolved: true, error: `repo read failed: ${e.message}` };
    }
  }

  if (kind === 'url') {
    return resolveUrl(node, ctx);
  }

  const plugin = ctx.plugins && ctx.plugins.get(kind);
  if (plugin) {
    const r = await plugin(node, ctx);
    if (r === null || typeof r !== 'object' || typeof r.content !== 'string') {
      return { content: '', resolver: kind, unresolved: true, error: `plugin resolver "${kind}" returned a malformed result` };
    }
    return { content: r.content, resolver: r.resolver || kind, unresolved: !!r.unresolved, error: r.error || null };
  }

  throw new ConfigError('TW_SOURCE_UNKNOWN_KIND',
    `node "${node.id}": unknown source.kind "${kind}" (builtins: ${BUILTIN_KINDS.join(', ')}; ` +
    `plugin kinds come from "resolvers:" in canonweave.yml)`);
}
