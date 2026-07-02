---
traceweave: 1
id: architecture-overview
type: architecture-overview
title: Architecture Overview
source:
  kind: inline
recipe:
  ingredients: [requirements, acceptance-criteria]
  build: Name the components and the one-way dependencies between them.
reconciled:
  requirements: "sha256:a73aa5b82f0e71f9e93dc9a61bcbea9e50ff833f59ab16a9c6bc705b847adcc6"
  acceptance-criteria: "sha256:04c53df478872e75252bc0e8e929507d9e2c1584aa6ae850a9ce05cf0806608f"
owner: engineering
status: present
provenance:
  issue: null
---

# Architecture Overview

Components: artifact files (system of record) -> engine (resolve, fingerprint,
graph, gates) -> surfaces (CLI, CI check). State lives in git; nothing external
is authoritative.
