// @traceweave/engine — public API. Zero runtime dependencies (Node builtins only).
export { EXIT, SCHEMA_VERSION, ONTOLOGY_VERSION, FINGERPRINT_VERSION, ConfigError, ResolveError } from './errors.mjs';
export { parseYaml, YamlError } from './yaml.mjs';
export { fingerprint, normalize } from './fingerprint.mjs';
export { CONFIG_FILENAME, findConfigPath, loadConfig } from './config.mjs';
export { loadOntology, knownType, tierOf, allowedIngredients, isLegalEdge, profileNames, requiredTypes } from './ontology.mjs';
export { parseFrontmatter, validateRecipeData, serializeFrontmatter, readRecipeFile } from './recipe.mjs';
export { resolveSource, loadResolverPlugins, readCache, writeCache, cachePath } from './resolve.mjs';
export { loadArtifacts, validateEdges, buildGraph, gateVerdict, assertResolved, GRAPH_FORMAT_VERSION } from './graph.mjs';
export { renderCheck, renderGate } from './report.mjs';
export { draft, buildDraftPrompt, stripPreamble } from './drafter.mjs';
export { reconcileDraft, reconcileApply, readProposal, proposalPath, proposalsDir } from './reconcile.mjs';
