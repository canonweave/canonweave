// drafter.mjs — pluggable drafter that produces the CORRECTED downstream
// artifact content for the reconcile loop.
//
// WS1 backends (drafter.backend in traceweave.yml):
//   template  — deterministic stub, NO network. The hermetic selftest backend.
//   cmd       — run a configured CLI (drafter.command: [argv0, arg1, ...]);
//               the assembled prompt is appended as the final argument and the
//               draft is read from stdout. Generalizes the prototype's
//               hardcoded local-agent path.
//   none      — never draft; always emit a reconcile BRIEF (teams that want
//               human-only redrafts).
// WS3 backends (AIW-232, design section 7 — the AI plane):
//   anthropic — direct Messages API call. Zero-dep (global fetch), single
//               completion, NO tools. Key from env (drafter.api_key_env,
//               default ANTHROPIC_API_KEY) — never config, never logged.
//   openai    — OpenAI-compatible chat completions (drafter.base_url) for
//               self-hosted / proxy endpoints. Same key + defense rules.
//
// Injection defense (layered, section 7): single completion, no tool access,
// pinned instruction, input size caps (DRAFTER_INPUT_CAP below), fence and
// preamble stripping, and the human PR gate as the backstop.
//
// Request: { downstream:{id,type,title,build},
//            upstream:{id,type,title,fingerprintOld,fingerprintNew,content},
//            downstreamCurrent }
// Result:  { ok, kind: 'draft'|'brief', backend, content, error }
import { execFileSync } from 'node:child_process';

// Input size cap per content block (injection defense: a hostile artifact
// cannot stuff the context). Characters, not tokens — deterministic.
export const DRAFTER_INPUT_CAP = 32000;

export function capInput(s) {
  const str = String(s == null ? '' : s);
  if (str.length <= DRAFTER_INPUT_CAP) return str;
  const over = str.length - DRAFTER_INPUT_CAP;
  return str.slice(0, DRAFTER_INPUT_CAP) +
    `\n[traceweave: input truncated — ${over} chars over the ${DRAFTER_INPUT_CAP}-char drafter cap]`;
}

export function buildDraftPrompt(req) {
  const { downstream, upstream, downstreamCurrent } = req;
  const cur = capInput((downstreamCurrent || '').trim());
  return [
    `You are reconciling a downstream product artifact after one of its upstream`,
    `ingredients changed. Re-derive the downstream artifact from the NEW upstream.`,
    ``,
    `DOWNSTREAM artifact to produce:`,
    `  id:    ${downstream.id}`,
    `  type:  ${downstream.type}`,
    `  title: ${downstream.title}`,
    `BUILD RULE (how this artifact must be built):`,
    `  ${downstream.build || '(no explicit build rule)'}`,
    ``,
    `CHANGED UPSTREAM ingredient (${upstream.id}, type ${upstream.type}, "${upstream.title}").`,
    `Its CURRENT resolved content is below, between the markers:`,
    `<<<UPSTREAM`,
    capInput(String(upstream.content == null ? '' : upstream.content).trim()),
    `UPSTREAM>>>`,
    ``,
    cur
      ? `The downstream artifact's CURRENT content (now stale — re-derive it):\n<<<DOWNSTREAM_CURRENT\n${cur}\nDOWNSTREAM_CURRENT>>>`
      : `The downstream artifact is currently a PLACEHOLDER (empty); produce it for the first time from the upstream above.`,
    ``,
    `Output ONLY the corrected downstream ${downstream.type} content (markdown), no`,
    `preamble, no explanation, no code fences. Make it specific to the upstream`,
    `content above — do not output a generic template.`,
  ].join('\n');
}

// Strip the common ways an LLM wraps a "give me only X" response: a leading
// chatty line, and fences around the whole thing.
export function stripPreamble(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/\r\n/g, '\n').trim();
  const fence = s.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  const m = s.match(/^([^\n]{0,120}:)\n\n([#\-*>][\s\S]+)$/);
  if (m && /\b(here|corrected|below|following|updated|output|draft)\b/i.test(m[1])) {
    s = m[2].trim();
  }
  return s;
}

function draftViaCmd(command, prompt) {
  const [argv0, ...args] = command;
  const out = execFileSync(argv0, [...args, prompt], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const draft = stripPreamble(out);
  if (!draft) throw new Error(`cmd drafter (${argv0}) returned an empty draft`);
  return draft;
}

// ---- WS3 zero-dep API backends ---------------------------------------------
// Shared HTTP call: single completion, no tools, bounded time. The API key is
// read from the environment at call time and appears ONLY in the request
// header — never in errors, logs, briefs, or proposals.
async function draftViaApi({ url, headers, payload, extract, label }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new Error(`${label}: request failed (${e.name === 'AbortError' ? 'timeout after 120s' : e.message})`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} — ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${label}: non-JSON response`); }
  const out = extract(json);
  if (typeof out !== 'string' || !out.trim()) throw new Error(`${label}: response had no draft text`);
  const draft = stripPreamble(out);
  if (!draft) throw new Error(`${label}: draft empty after preamble stripping`);
  return draft;
}

function requireKey(apiKeyEnv, label) {
  const key = process.env[apiKeyEnv];
  if (!key || !key.trim()) {
    throw new Error(`${label}: no API key in env ${apiKeyEnv} — set the repo secret / environment variable`);
  }
  return key.trim();
}

// Anthropic Messages API, direct. Single user message, no tools, no system
// escalation surface beyond the pinned prompt.
async function draftViaAnthropic(prompt, d) {
  const key = requireKey(d.apiKeyEnv, 'anthropic drafter');
  return draftViaApi({
    label: 'anthropic drafter',
    url: `${d.baseUrl}/v1/messages`,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: {
      model: d.model,
      max_tokens: d.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    },
    extract: (j) => j && j.content && j.content[0] && j.content[0].text,
  });
}

// OpenAI-compatible chat completions (base_url covers self-hosted endpoints).
async function draftViaOpenAI(prompt, d) {
  const key = requireKey(d.apiKeyEnv, 'openai drafter');
  return draftViaApi({
    label: 'openai drafter',
    url: `${d.baseUrl}/chat/completions`,
    headers: { authorization: `Bearer ${key}` },
    payload: {
      model: d.model,
      max_tokens: d.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    },
    extract: (j) => j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content,
  });
}

// Deterministic, hermetic, NO network. Embeds the upstream fingerprint so the
// selftest can assert the draft is concrete and upstream-specific.
function draftViaTemplate(req) {
  const { downstream, upstream } = req;
  const upHead = String(upstream.content == null ? '' : upstream.content)
    .trim().split('\n').slice(0, 3).map((l) => `> ${l}`).join('\n');
  return [
    `# ${downstream.title}`,
    ``,
    `_Reconciled from upstream **${upstream.id}** (${upstream.type})._`,
    ``,
    `Build rule: ${downstream.build || '(none)'}`,
    ``,
    `Upstream fingerprint: ${upstream.fingerprintNew}`,
    ``,
    `Upstream excerpt:`,
    upHead || '> (empty)',
    ``,
    `<!-- template drafter (deterministic, no network) -->`,
  ].join('\n');
}

// Returns { ok, kind, backend, content, error }. kind 'brief' means the caller
// should write a reconcile BRIEF (concrete context, no auto-draft).
// Async since WS3 (API backends); template/cmd/none resolve synchronously.
// `opts` is the loaded config's drafter block (config.mjs shapes it).
export async function draft(req, opts = {}) {
  const { backend = 'template', command = null } = opts;
  if (backend === 'template') {
    return { ok: true, kind: 'draft', backend: 'template', content: draftViaTemplate(req), error: null };
  }
  if (backend === 'none') {
    return { ok: false, kind: 'brief', backend: 'none', content: null, error: 'drafter backend "none" — brief mode by configuration' };
  }
  if (backend === 'cmd') {
    if (!Array.isArray(command) || command.length === 0) {
      return { ok: false, kind: 'brief', backend: 'cmd', content: null, error: 'cmd drafter has no command configured' };
    }
    try {
      const content = draftViaCmd(command, buildDraftPrompt(req));
      return { ok: true, kind: 'draft', backend: 'cmd', content, error: null };
    } catch (e) {
      return { ok: false, kind: 'brief', backend: 'cmd', content: null, error: `cmd drafter failed: ${e.message}` };
    }
  }
  if (backend === 'anthropic' || backend === 'openai') {
    const via = backend === 'anthropic' ? draftViaAnthropic : draftViaOpenAI;
    try {
      const content = await via(buildDraftPrompt(req), opts);
      return { ok: true, kind: 'draft', backend, content, error: null };
    } catch (e) {
      return { ok: false, kind: 'brief', backend, content: null, error: e.message };
    }
  }
  return { ok: false, kind: 'brief', backend: String(backend), content: null, error: `unknown drafter backend "${backend}"` };
}
