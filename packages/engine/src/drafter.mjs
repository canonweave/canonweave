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
// anthropic / openai (direct zero-dep API backends) are designed in section 7
// and ship in WS3 (AIW-232); config.mjs rejects them today with a clear error.
//
// Request: { downstream:{id,type,title,build},
//            upstream:{id,type,title,fingerprintOld,fingerprintNew,content},
//            downstreamCurrent }
// Result:  { ok, kind: 'draft'|'brief', backend, content, error }
import { execFileSync } from 'node:child_process';

export function buildDraftPrompt(req) {
  const { downstream, upstream, downstreamCurrent } = req;
  const cur = (downstreamCurrent || '').trim();
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
    String(upstream.content == null ? '' : upstream.content).trim(),
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
export function draft(req, { backend = 'template', command = null } = {}) {
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
  return { ok: false, kind: 'brief', backend: String(backend), content: null, error: `unknown drafter backend "${backend}"` };
}
