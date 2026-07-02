---
traceweave: 1
id: test-plan
type: test-plan
title: Test Plan
source:
  kind: inline
recipe:
  ingredients: [acceptance-criteria]
  build: "One test per acceptance criterion; hermetic where possible."
reconciled: {}
owner: engineering
status: present
provenance:
  issue: null
---

# Test Plan

- Hermetic selftest covering suspect detection, gap detection, and gate verdicts.
- Determinism snapshot: build twice, byte-compare the graph.
- CRLF equivalence: the same content with Windows line endings fingerprints identically.
