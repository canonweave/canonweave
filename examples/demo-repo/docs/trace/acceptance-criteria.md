---
traceweave: 1
id: acceptance-criteria
type: acceptance-criteria
title: Acceptance Criteria (Given/When/Then)
source:
  kind: inline
recipe:
  ingredients: [requirements]
  build: One Given/When/Then per requirement.
reconciled:
  requirements: "sha256:a73aa5b82f0e71f9e93dc9a61bcbea9e50ff833f59ab16a9c6bc705b847adcc6"
owner: product
status: present
provenance:
  issue: null
---

# Acceptance Criteria

- **Given** an artifact whose upstream ingredient changed, **when** the graph is
  rebuilt, **then** the artifact's link to that ingredient is reported suspect.
- **Given** all required artifacts present, fresh, and resolved, **when** the
  gate runs, **then** it passes with exit code 0.
- **Given** a suspect link, **when** it is reconciled, **then** the next build
  reports it fresh.
