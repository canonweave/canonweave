// config.mjs — canonweave.yml loading + validation (design section 4.3).
//
// The config file lives at the consumer repo root. All relative paths in it are
// resolved against the directory containing canonweave.yml (= repoRoot).
// The resolver cache is FIXED at <repoRoot>/.canonweave/cache and is committed
// by design (deterministic, offline-safe CI builds — design section 5).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { parseYaml, YamlError } from './yaml.mjs';
import { ConfigError } from './errors.mjs';

export const CONFIG_FILENAME = 'canonweave.yml';

// Drafter backends. template/cmd/none shipped in WS1; anthropic/openai are
// the WS3 (AIW-232) zero-dep API backends — design section 7. API keys are
// read from the environment (repo secrets in CI), NEVER from this file.
const BACKENDS_AVAILABLE = ['template', 'cmd', 'none', 'anthropic', 'openai'];
const BACKENDS_API = ['anthropic', 'openai'];
const API_DEFAULTS = {
  anthropic: { baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5' },
  openai:    { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY',    model: null },
};
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

const KNOWN_KEYS = new Set(['roots', 'ontology', 'graph', 'gate', 'drafter', 'sync', 'resolvers']);

function isSlugList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');
}

// Walk up from startDir looking for canonweave.yml. Returns absolute path or null.
export function findConfigPath(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Load + validate canonweave.yml. `configPath` must be the file itself.
export function loadConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new ConfigError('TW_CONFIG_NOT_FOUND',
      `no ${CONFIG_FILENAME} found at ${configPath} — run "canonweave init" or pass --config`);
  }
  let raw;
  try {
    raw = parseYaml(readFileSync(configPath, 'utf8'));
  } catch (e) {
    if (e instanceof YamlError) {
      throw new ConfigError('TW_CONFIG_YAML', `${configPath}: ${e.message}`);
    }
    throw e;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('TW_CONFIG_SHAPE', `${configPath}: config must be a YAML map`);
  }
  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(k)) {
      throw new ConfigError('TW_CONFIG_UNKNOWN_KEY',
        `${configPath}: unknown key "${k}" (known: ${[...KNOWN_KEYS].join(', ')})`);
    }
  }

  const repoRoot = dirname(resolve(configPath));
  const abs = (p) => (isAbsolute(p) ? p : resolve(repoRoot, p));

  // roots — where artifact files live (multi-root for monorepos).
  const rootsRel = raw.roots === undefined ? ['docs/trace'] : raw.roots;
  if (!isSlugList(rootsRel) || rootsRel.length === 0) {
    throw new ConfigError('TW_CONFIG_ROOTS', `${configPath}: "roots" must be a non-empty list of paths`);
  }

  const ontologyRel = raw.ontology === undefined ? join(rootsRel[0], 'ontology.yml') : raw.ontology;
  if (typeof ontologyRel !== 'string' || ontologyRel === '') {
    throw new ConfigError('TW_CONFIG_ONTOLOGY', `${configPath}: "ontology" must be a path string`);
  }
  const graphRel = raw.graph === undefined ? join(rootsRel[0], 'graph.json') : raw.graph;
  if (typeof graphRel !== 'string' || graphRel === '') {
    throw new ConfigError('TW_CONFIG_GRAPH', `${configPath}: "graph" must be a path string`);
  }

  const gateProfile = raw.gate === undefined ? 'ready-to-build' : raw.gate;
  if (typeof gateProfile !== 'string' || gateProfile === '') {
    throw new ConfigError('TW_CONFIG_GATE', `${configPath}: "gate" must be a gate profile name`);
  }

  // drafter
  const drafterRaw = raw.drafter === undefined ? {} : raw.drafter;
  if (drafterRaw === null || typeof drafterRaw !== 'object' || Array.isArray(drafterRaw)) {
    throw new ConfigError('TW_CONFIG_DRAFTER', `${configPath}: "drafter" must be a map`);
  }
  const backend = drafterRaw.backend === undefined ? 'template' : drafterRaw.backend;
  if (!BACKENDS_AVAILABLE.includes(backend)) {
    throw new ConfigError('TW_CONFIG_DRAFTER_BACKEND',
      `${configPath}: unknown drafter backend "${backend}" (available: ${BACKENDS_AVAILABLE.join(' | ')})`);
  }
  const drafter = { backend };
  if (backend === 'cmd') {
    if (!isSlugList(drafterRaw.command) || drafterRaw.command.length === 0) {
      throw new ConfigError('TW_CONFIG_DRAFTER_CMD',
        `${configPath}: drafter backend "cmd" requires "command" — a list [argv0, arg1, ...]; ` +
        `the prompt is appended as the final argument`);
    }
    drafter.command = drafterRaw.command;
  }
  if (BACKENDS_API.includes(backend)) {
    const d = API_DEFAULTS[backend];
    const strField = (key, fallback) => {
      const v = drafterRaw[key];
      if (v === undefined) return fallback;
      if (typeof v !== 'string' || v.trim() === '') {
        throw new ConfigError('TW_CONFIG_DRAFTER', `${configPath}: drafter "${key}" must be a non-empty string`);
      }
      return v.trim();
    };
    drafter.model = strField('model', d.model);
    if (!drafter.model) {
      throw new ConfigError('TW_CONFIG_DRAFTER_MODEL',
        `${configPath}: drafter backend "openai" requires "model" (no universal default exists ` +
        `for OpenAI-compatible endpoints — name the model your endpoint serves)`);
    }
    drafter.baseUrl = strField('base_url', d.baseUrl).replace(/\/+$/, '');
    drafter.apiKeyEnv = strField('api_key_env', d.apiKeyEnv);
    if (!ENV_NAME_RE.test(drafter.apiKeyEnv)) {
      throw new ConfigError('TW_CONFIG_DRAFTER',
        `${configPath}: drafter "api_key_env" must be an environment variable NAME ` +
        `(A-Z, 0-9, _) — the key itself never goes in config`);
    }
    const mt = drafterRaw.max_tokens === undefined ? 8192 : drafterRaw.max_tokens;
    if (!Number.isInteger(mt) || mt <= 0) {
      throw new ConfigError('TW_CONFIG_DRAFTER', `${configPath}: drafter "max_tokens" must be a positive integer`);
    }
    drafter.maxTokens = mt;
  }

  // sync
  const syncRaw = raw.sync === undefined ? {} : raw.sync;
  if (syncRaw === null || typeof syncRaw !== 'object' || Array.isArray(syncRaw)) {
    throw new ConfigError('TW_CONFIG_SYNC', `${configPath}: "sync" must be a map`);
  }
  const sync = { issues: syncRaw.issues === true };

  // resolver plugin modules
  const resolversRel = raw.resolvers === undefined ? [] : raw.resolvers;
  if (!isSlugList(resolversRel) && !(Array.isArray(resolversRel) && resolversRel.length === 0)) {
    throw new ConfigError('TW_CONFIG_RESOLVERS', `${configPath}: "resolvers" must be a list of module paths`);
  }

  return {
    configPath: resolve(configPath),
    repoRoot,
    roots: rootsRel.map(abs),
    rootsRel,
    ontologyPath: abs(ontologyRel),
    graphPath: abs(graphRel),
    gateProfile,
    drafter,
    sync,
    resolverModules: resolversRel.map(abs),
    resolverModulesRel: resolversRel,
    cacheDir: join(repoRoot, '.canonweave', 'cache'),
  };
}
