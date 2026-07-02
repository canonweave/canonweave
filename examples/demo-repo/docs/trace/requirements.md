---
traceweave: 1
id: requirements
type: requirements
title: Requirements
source:
  kind: inline
recipe:
  ingredients: [product-brief]
  build: One numbered requirement per capability promised in the product brief.
reconciled:
  product-brief: "sha256:65474e1d5454cbda9da90f60d8f9e2d1b16384c5862f6ff396ed94aec83fd5fd"
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
