// yaml.mjs — minimal YAML-subset parser for Canonweave files (zero-dep).
//
// The subset (documented in docs/file-format.md; anything outside it errors):
//   - maps:        `key: value` or `key:` followed by a deeper-indented block
//   - block lists: `- scalar` (scalars only — lists of maps are NOT supported)
//   - inline lists `[a, b, c]` (items are scalars; no nested brackets)
//   - scalars:     null | ~ | true | false | integers/floats | "quoted" | 'quoted' | raw
//   - comments (# at line start or preceded by whitespace), blank lines
//   - spaces for indentation (tabs are an error); sibling keys share one indent
// NOT supported by design: anchors, aliases, multi-document, block scalars (| >),
// quoted keys, flow maps. Zero-runtime-dependency discipline over YAML coverage.

export class YamlError extends Error {
  constructor(message, line) {
    super(line != null ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

// Remove a trailing comment, quote-aware. '#' only counts when at line start or
// preceded by whitespace (so values like "sha256:#..." survive).
function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) {
      if (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t') {
        return line.slice(0, i).replace(/\s+$/, '');
      }
    }
  }
  return line;
}

// Unescape the inside of a double-quoted scalar: \" \\ \n \t.
function unquoteDouble(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && i + 1 < inner.length) {
      const n = inner[i + 1];
      if (n === '"') { out += '"'; i++; continue; }
      if (n === '\\') { out += '\\'; i++; continue; }
      if (n === 'n') { out += '\n'; i++; continue; }
      if (n === 't') { out += '\t'; i++; continue; }
    }
    out += c;
  }
  return out;
}

function parseScalar(raw) {
  const v = String(raw).trim();
  if (v === '') return '';
  if (v === '{}') return {};   // empty flow map — the serializer's empty-map form
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return unquoteDouble(v.slice(1, -1));
  }
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(v)) return Number(v);
  return v;
}

// Split inline-list items on commas, quote-aware (so "a,b" stays one item).
function splitInlineItems(inner, line) {
  const parts = [];
  let cur = '', inS = false, inD = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inD && c === '\\' && i + 1 < inner.length) { cur += c + inner[i + 1]; i++; continue; }
    if (c === "'" && !inD) { inS = !inS; cur += c; continue; }
    if (c === '"' && !inS) { inD = !inD; cur += c; continue; }
    if (c === ',' && !inS && !inD) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (inS || inD) throw new YamlError('unterminated quote in inline list', line);
  parts.push(cur);
  return parts;
}

function parseInlineList(raw, line) {
  const v = raw.trim();
  if (!v.startsWith('[') || !v.endsWith(']')) {
    throw new YamlError(`malformed inline list: ${v}`, line);
  }
  const inner = v.slice(1, -1).trim();
  if (inner === '') return [];
  return splitInlineItems(inner, line).map((s) => parseScalar(s));
}

function tokenize(text) {
  const out = [];
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    if (/^ *\t/.test(raw)) throw new YamlError('tabs are not allowed for indentation', i + 1);
    const noComment = stripComment(raw);
    if (noComment.trim() === '') continue;
    const indent = noComment.match(/^ */)[0].length;
    out.push({ indent, text: noComment.trim(), line: i + 1 });
  }
  return out;
}

function isListItem(t) { return t.text === '-' || t.text.startsWith('- '); }

function parseList(toks, i, indent) {
  const arr = [];
  while (i < toks.length && toks[i].indent === indent && isListItem(toks[i])) {
    const t = toks[i];
    const item = t.text === '-' ? '' : t.text.slice(2).trim();
    if (/^[^"'\s][^:]*:(\s|$)/.test(item)) {
      throw new YamlError('lists of maps are not supported in the Canonweave YAML subset', t.line);
    }
    arr.push(parseScalar(item));
    i++;
    if (i < toks.length && toks[i].indent > indent) {
      throw new YamlError('nested blocks under a list item are not supported', toks[i].line);
    }
  }
  return { value: arr, next: i };
}

function parseMap(toks, i, indent) {
  const obj = {};
  while (i < toks.length && toks[i].indent === indent) {
    const t = toks[i];
    if (isListItem(t)) throw new YamlError('unexpected list item in map context', t.line);
    const colon = t.text.indexOf(':');
    if (colon === -1) throw new YamlError(`expected "key: value", got: ${t.text}`, t.line);
    const key = t.text.slice(0, colon).trim();
    if (key === '') throw new YamlError('empty map key', t.line);
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new YamlError(`duplicate key "${key}"`, t.line);
    }
    const rest = t.text.slice(colon + 1).trim();
    if (rest !== '') {
      obj[key] = rest.startsWith('[') ? parseInlineList(rest, t.line) : parseScalar(rest);
      i++;
    } else if (i + 1 < toks.length && toks[i + 1].indent > indent) {
      const child = parseBlock(toks, i + 1, toks[i + 1].indent);
      obj[key] = child.value;
      i = child.next;
    } else {
      obj[key] = {};
      i++;
    }
  }
  return { value: obj, next: i };
}

function parseBlock(toks, i, indent) {
  return isListItem(toks[i]) ? parseList(toks, i, indent) : parseMap(toks, i, indent);
}

// Parse a YAML-subset document into a plain object/array.
export function parseYaml(text) {
  const toks = tokenize(text);
  if (toks.length === 0) return {};
  if (toks[0].indent !== 0) throw new YamlError('top level must not be indented', toks[0].line);
  const { value, next } = parseBlock(toks, 0, 0);
  if (next < toks.length) throw new YamlError('inconsistent indentation', toks[next].line);
  return value;
}
