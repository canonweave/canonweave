// recipe.mjs — artifact recipe files: frontmatter schema v1 parse/validate/serialize.
//
// Schema v1 (design section 4.1; `canonweave: 1` is the version key):
//   canonweave: 1                      REQUIRED — schema version
//   id: <slug>                         REQUIRED — stable identity, NOT the filename
//   type: <slug>                       REQUIRED — must exist in the ontology
//   title: <string>                    optional
//   source: { kind, path?, url?, token?, ... }   optional (default kind: inline)
//   recipe: { ingredients: [ids], build: <string> }  optional
//   reconciled: { <ingredient-id>: "sha256:..." }    optional
//   owner: <string>                    optional (maps to CODEOWNERS in practice)
//   status: present | placeholder      optional (default placeholder)
//   provenance: { issue: <int|null> }  optional — explicit GitHub issue binding
// Unknown top-level keys are tolerated and preserved on rewrite (forward-compat).
// Validation errors are versioned ConfigErrors with stable TW_SCHEMA_* codes.
import { readFileSync } from 'node:fs';
import { parseYaml, YamlError } from './yaml.mjs';
import { ConfigError, SCHEMA_VERSION } from './errors.mjs';

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

// Split a file into { data, body, raw }. data === null when there is no
// parseable frontmatter block (callers decide whether that is an error).
export function parseFrontmatter(text) {
  const s = String(text);
  if (!s.startsWith('---')) return { data: null, body: s, raw: s };
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { data: null, body: s, raw: s };
  let data;
  try {
    data = parseYaml(m[1]);
  } catch (e) {
    if (e instanceof YamlError) {
      throw new ConfigError('TW_SCHEMA_YAML', `frontmatter: ${e.message}`);
    }
    throw e;
  }
  return { data, body: s.slice(m[0].length), raw: s };
}

// Validate parsed frontmatter against schema v1. `file` is for error messages.
// Returns the (lightly normalized) data object.
export function validateRecipeData(data, file) {
  const at = file || '(inline)';
  const fail = (code, msg) => { throw new ConfigError(code, `[schema v${SCHEMA_VERSION}] ${at}: ${msg}`); };

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail('TW_SCHEMA_NO_FRONTMATTER', 'artifact file has no YAML frontmatter block');
  }
  if (data.canonweave === undefined) {
    fail('TW_SCHEMA_MISSING_VERSION', `missing "canonweave: ${SCHEMA_VERSION}" schema version key`);
  }
  if (data.canonweave !== SCHEMA_VERSION) {
    fail('TW_SCHEMA_UNSUPPORTED_VERSION',
      `unsupported schema version ${JSON.stringify(data.canonweave)} (this engine reads schema v${SCHEMA_VERSION})`);
  }
  if (typeof data.id !== 'string' || data.id === '') {
    fail('TW_SCHEMA_MISSING_ID', 'missing required "id"');
  }
  if (!ID_RE.test(data.id)) {
    fail('TW_SCHEMA_BAD_ID', `id "${data.id}" must match ${ID_RE} (lowercase slug)`);
  }
  if (typeof data.type !== 'string' || data.type === '') {
    fail('TW_SCHEMA_MISSING_TYPE', 'missing required "type"');
  }
  if (data.source !== undefined) {
    if (data.source === null || typeof data.source !== 'object' || Array.isArray(data.source)) {
      fail('TW_SCHEMA_BAD_SOURCE', '"source" must be a map');
    }
    if (data.source.kind !== undefined && typeof data.source.kind !== 'string') {
      fail('TW_SCHEMA_BAD_SOURCE', '"source.kind" must be a string');
    }
  }
  if (data.recipe !== undefined) {
    if (data.recipe === null || typeof data.recipe !== 'object' || Array.isArray(data.recipe)) {
      fail('TW_SCHEMA_BAD_RECIPE', '"recipe" must be a map');
    }
    const ing = data.recipe.ingredients;
    if (ing !== undefined) {
      if (!Array.isArray(ing) || !ing.every((x) => typeof x === 'string' && ID_RE.test(x))) {
        fail('TW_SCHEMA_BAD_INGREDIENTS', '"recipe.ingredients" must be a list of artifact ids');
      }
    }
    if (data.recipe.build !== undefined && typeof data.recipe.build !== 'string') {
      fail('TW_SCHEMA_BAD_BUILD', '"recipe.build" must be a string');
    }
  }
  if (data.reconciled !== undefined) {
    if (data.reconciled === null || typeof data.reconciled !== 'object' || Array.isArray(data.reconciled)) {
      fail('TW_SCHEMA_BAD_RECONCILED', '"reconciled" must be a map of ingredient-id -> fingerprint');
    }
    for (const [k, v] of Object.entries(data.reconciled)) {
      if (typeof v !== 'string') {
        fail('TW_SCHEMA_BAD_RECONCILED', `"reconciled.${k}" must be a fingerprint string`);
      }
    }
  }
  if (data.status !== undefined && data.status !== 'present' && data.status !== 'placeholder') {
    fail('TW_SCHEMA_BAD_STATUS', `"status" must be "present" or "placeholder" (got ${JSON.stringify(data.status)})`);
  }
  if (data.provenance !== undefined) {
    if (data.provenance === null || typeof data.provenance !== 'object' || Array.isArray(data.provenance)) {
      fail('TW_SCHEMA_BAD_PROVENANCE', '"provenance" must be a map');
    }
    const issue = data.provenance.issue;
    if (issue !== undefined && issue !== null && !Number.isInteger(issue)) {
      fail('TW_SCHEMA_BAD_PROVENANCE', '"provenance.issue" must be an integer GitHub issue number (or null)');
    }
  }
  return data;
}

// ---- serialize ----
function serScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '') return '""';
  const looksSpecial =
    /[:,#\[\]{}"'\n\t]/.test(s) ||
    /^\s|\s$/.test(s) ||
    /^[>|*&!%@`?-]/.test(s) ||
    ['null', 'true', 'false', '~'].includes(s) ||
    /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s);
  if (looksSpecial) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
  }
  return s;
}

function serList(arr) {
  if (!arr || arr.length === 0) return '[]';
  return '[' + arr.map((x) => serScalar(x)).join(', ') + ']';
}

function serMapBlock(L, key, obj, order = [], indent = '') {
  const keys = Object.keys(obj);
  if (keys.length === 0) { L.push(`${indent}${key}: {}`); return; }
  L.push(`${indent}${key}:`);
  const ordered = [...order.filter((k) => keys.includes(k)), ...keys.filter((k) => !order.includes(k))];
  for (const k of ordered) {
    const v = obj[k];
    if (Array.isArray(v)) L.push(`${indent}  ${k}: ${serList(v)}`);
    else if (v !== null && typeof v === 'object') serMapBlock(L, k, v, [], indent + '  ');
    else L.push(`${indent}  ${k}: ${serScalar(v)}`);
  }
}

// Serialize frontmatter in canonical order + preserved extras, then the body.
// Always emits LF; the fingerprint path normalizes CRLF anyway (section 4.5).
export function serializeFrontmatter(data, body) {
  const L = [];
  L.push('---');
  L.push(`canonweave: ${SCHEMA_VERSION}`);
  if ('id' in data) L.push(`id: ${serScalar(data.id)}`);
  if ('type' in data) L.push(`type: ${serScalar(data.type)}`);
  if ('title' in data) L.push(`title: ${serScalar(data.title)}`);
  if ('tier' in data) L.push(`tier: ${serScalar(data.tier)}`); // legacy passthrough; ontology owns tiers
  if ('source' in data && data.source && typeof data.source === 'object') {
    serMapBlock(L, 'source', data.source, ['kind', 'path', 'url', 'token', 'resolver']);
  }
  if ('recipe' in data && data.recipe && typeof data.recipe === 'object') {
    L.push('recipe:');
    L.push(`  ingredients: ${serList(data.recipe.ingredients || [])}`);
    if ('build' in data.recipe) L.push(`  build: ${serScalar(data.recipe.build)}`);
  }
  if ('reconciled' in data && data.reconciled && typeof data.reconciled === 'object') {
    serMapBlock(L, 'reconciled', data.reconciled);
  }
  if ('owner' in data) L.push(`owner: ${serScalar(data.owner)}`);
  if ('status' in data) L.push(`status: ${serScalar(data.status)}`);
  if ('provenance' in data && data.provenance && typeof data.provenance === 'object') {
    serMapBlock(L, 'provenance', data.provenance, ['issue']);
  }
  const handled = new Set(['canonweave', 'id', 'type', 'title', 'tier', 'source', 'recipe', 'reconciled', 'owner', 'status', 'provenance']);
  for (const k of Object.keys(data)) {
    if (handled.has(k)) continue;
    const v = data[k];
    if (Array.isArray(v)) L.push(`${k}: ${serList(v)}`);
    else if (v !== null && typeof v === 'object') serMapBlock(L, k, v);
    else L.push(`${k}: ${serScalar(v)}`);
  }
  L.push('---');
  let out = L.join('\n') + '\n';
  if (body && body.length) out += body;
  return out;
}

// Read + parse + validate one artifact file.
export function readRecipeFile(path) {
  const text = readFileSync(path, 'utf8');
  const { data, body } = parseFrontmatter(text);
  if (data === null) {
    throw new ConfigError('TW_SCHEMA_NO_FRONTMATTER',
      `[schema v${SCHEMA_VERSION}] ${path}: artifact file has no YAML frontmatter block`);
  }
  validateRecipeData(data, path);
  return { data, body, path };
}
