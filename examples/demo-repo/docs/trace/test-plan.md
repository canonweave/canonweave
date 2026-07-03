---
canonweave: 1
id: test-plan
type: test-plan
title: Test Plan
source:
  kind: inline
recipe:
  ingredients: [acceptance-criteria]
  build: One test per acceptance criterion; hermetic where possible.
reconciled:
  acceptance-criteria: "sha256:04c53df478872e75252bc0e8e929507d9e2c1584aa6ae850a9ce05cf0806608f"
owner: engineering
status: present
provenance:
  issue: null
---

# Test Plan

- Hermetic selftest covering suspect detection, gap detection, and gate verdicts.
- Determinism snapshot: build twice, byte-compare the graph.
- CRLF equivalence: the same content with Windows line endings fingerprints identically.
