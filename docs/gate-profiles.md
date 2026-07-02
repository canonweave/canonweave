# Ontology and gate profiles

`ontology.yml` declares what artifact types exist, which derivation edges are
legal, and which coverage sets gate a phase. It is user-editable and validated
on every build (exit 2 on violations).

## Format (ontology v1)

```yaml
version: 1
tiers: [discovery, requirements, architecture, delivery]   # ordered, informative
types:
  product-brief:
    tier: discovery
    ingredients: []              # legal upstream TYPES for this type
  requirements:
    tier: requirements
    ingredients: [product-brief]
profiles:                        # named gate profiles — at least one required
  ready-to-build:
    required: [product-brief, requirements]
```

- **Edge legality**: an edge `child <- parent` is legal only when the child's
  type lists the parent's type in `ingredients`. Anything else fails the build
  (TW_EDGE_ILLEGAL) — the ontology is enforced, not advisory.
- **Tiers** group types for reporting; they carry no gate semantics of their own.

## Gate profiles

A profile names a coverage set. The pass rule per profile:

1. every `required` type has at least one artifact,
2. every artifact of a required type is `status: present` (not placeholder),
3. every present artifact's source resolved,
4. zero suspect ingredient links anywhere in the graph,
5. zero coverage gaps for that profile.

Different phases use different profiles over the same graph:

```bash
traceweave gate                            # default profile from traceweave.yml
traceweave gate --profile ready-to-ship    # stricter set, same graph
```

`graph.json` records verdicts for ALL profiles on every build (`gates.<name>`),
so CI can gate different branches/checks on different profiles with one build.

## Migration from the prototype (`requiredForGate`)

The prototype marked required types with a per-type boolean:

```yaml
# BEFORE (prototype ontology.json)        # AFTER (ontology v1)
acceptance-criteria:                      profiles:
  requiredForGate: true                     ready-to-build:
                                              required: [acceptance-criteria, ...]
```

Collect every type that had `requiredForGate: true` into one named profile
(the shipped `product-lifecycle` template did exactly this — its 12 required
types became `profiles.ready-to-build.required`). The engine rejects
`requiredForGate` with TW_ONTOLOGY_LEGACY_REQUIRED so half-migrated files
cannot silently change gate meaning.

## Shipped templates

| template | types | profiles |
|---|---|---|
| `generic-software` | 7 (brief -> requirements -> AC -> architecture -> ADR/test-plan/runbook) | `ready-to-build`, `ready-to-ship` |
| `product-lifecycle` | 21 across 5 tiers (the full product-lifecycle ontology) | `ready-to-build` (12 required types) |

`generic-software` seeds five `present` artifacts — a fresh init gates green.
`product-lifecycle` seeds one placeholder (`pr-faq`) — a fresh init builds
clean but gates RED with the honest gap list; you author your way to green.
