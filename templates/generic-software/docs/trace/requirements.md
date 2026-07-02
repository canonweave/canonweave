---
traceweave: 1
id: requirements
type: requirements
title: Requirements
source:
  kind: inline
recipe:
  ingredients: [product-brief]
  build: "One numbered requirement per capability promised in the product brief."
reconciled: {}
owner: product
status: present
provenance:
  issue: null
---

# Requirements

1. Artifacts are Markdown files with YAML frontmatter declaring identity, type,
   and derivation (`recipe.ingredients`).
2. A build produces a deterministic derivation graph with per-link freshness.
3. A gate verdict reports whether the required coverage set is present, fresh,
   and resolved.
