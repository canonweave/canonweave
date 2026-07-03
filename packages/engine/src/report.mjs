// report.mjs — human-readable rendering of suspects, gaps, gate verdicts.

export function renderCheck(graph) {
  const L = [];
  L.push('Canonweave — coverage & suspect report');
  L.push('='.repeat(54));
  L.push(`nodes: ${graph.nodes.length}   edges: ${graph.edges.length}   suspects: ${graph.suspects.length}   gaps: ${graph.gaps.length}`);
  L.push('');

  L.push('SUSPECT INGREDIENT LINKS (upstream changed since last reconcile):');
  if (graph.suspects.length === 0) {
    L.push('  (none) — all reconciled links are fresh');
  } else {
    for (const s of graph.suspects) {
      L.push(`  - ${s.node} <- ${s.ingredient}`);
      L.push(`      reconciled: ${s.expected || '(unset)'}`);
      L.push(`      current:    ${s.actual}`);
    }
  }
  L.push('');

  L.push(`COVERAGE GAPS (profile: ${graph.defaultProfile}):`);
  if (graph.gaps.length === 0) {
    L.push('  (none) — every required artifact is present and resolved');
  } else {
    for (const g of graph.gaps) {
      const who = g.id ? `${g.type} (${g.id})` : g.type;
      L.push(`  - ${who}: ${g.reason}`);
    }
  }
  L.push('');

  const profiles = Object.keys(graph.gates || {}).sort();
  if (profiles.length > 1) {
    L.push('GATE PROFILES:');
    for (const p of profiles) {
      const g = graph.gates[p];
      L.push(`  - ${p}: ${g.pass ? 'PASS' : `FAIL (${g.reasons.length} reason(s))`}`);
    }
    L.push('');
  }

  const unresolved = graph.nodes.filter((n) => n.unresolved);
  if (unresolved.length) {
    L.push('UNRESOLVED SOURCES:');
    for (const n of unresolved) {
      L.push(`  - ${n.id} (${n.source && n.source.kind}): ${n.resolveError || 'unresolved'}`);
    }
    L.push('');
  }

  return L.join('\n');
}

export function renderGate(verdict) {
  const L = [];
  if (verdict.pass) {
    L.push(`GATE ${verdict.profile}: PASS`);
  } else {
    L.push(`GATE ${verdict.profile}: FAIL`);
    L.push('blocking reasons:');
    for (const r of verdict.reasons) L.push(`  - ${r}`);
  }
  return L.join('\n');
}
