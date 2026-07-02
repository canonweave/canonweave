---
traceweave: 1
id: architecture-overview
type: architecture-overview
title: Architecture Overview
source:
  kind: inline
recipe:
  ingredients: [requirements, acceptance-criteria]
  build: "Name the components and the one-way dependencies between them."
reconciled: {}
owner: engineering
status: present
provenance:
  issue: null
---

# Architecture Overview

Components: artifact files (system of record) -> engine (resolve, fingerprint,
graph, gates) -> surfaces (CLI, CI check). State lives in git; nothing external
is authoritative.
