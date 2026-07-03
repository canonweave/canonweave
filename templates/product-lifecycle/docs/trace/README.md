# Canonweave artifact root — product-lifecycle

This template ships the full product-lifecycle ontology (21 artifact types,
5 tiers: discovery -> ux -> requirements -> architecture -> delivery) and ONE
seed artifact (`pr-faq`, the root of the derivation graph, as a placeholder).

A fresh init therefore builds cleanly but the `ready-to-build` gate FAILS with
the honest gap list — you have not produced the artifacts yet. Author each
artifact as a `*.md` file here with `canonweave: 1` frontmatter; wire its
`recipe.ingredients` per the ontology; `canonweave check` shows what is left.
