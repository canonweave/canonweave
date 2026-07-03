// errors.mjs — Canonweave error taxonomy, mapped to the CLI exit-code contract.
//
// Exit codes (design §6, versioned contract):
//   0  gate pass / verb success
//   1  gate fail (suspects and/or gaps)
//   2  config or ontology error (bad frontmatter, illegal edge, unknown type, bad config)
//   3  resolve error without cache (a node's source is unreachable)
//
// Validation errors are VERSIONED: every ConfigError carries a stable machine
// code (TW_*) and messages name the schema version they were validated against.
// Codes are documented in docs/file-format.md and are part of the public contract.

export const EXIT = Object.freeze({
  PASS: 0,
  GATE_FAIL: 1,
  CONFIG_ERROR: 2,
  RESOLVE_ERROR: 3,
});

// Frontmatter schema version this engine understands (the `canonweave:` key).
export const SCHEMA_VERSION = 1;
// Ontology file format version (the `version:` key in ontology.yml).
export const ONTOLOGY_VERSION = 1;
// Fingerprint format version (normalize() + sha256; changing normalize is a major).
export const FINGERPRINT_VERSION = 1;

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;       // stable TW_* machine code
    this.exitCode = EXIT.CONFIG_ERROR;
  }
}

export class ResolveError extends Error {
  constructor(message, nodes = []) {
    super(message);
    this.name = 'ResolveError';
    this.code = 'TW_RESOLVE';
    this.nodes = nodes;     // [{ id, kind, error }]
    this.exitCode = EXIT.RESOLVE_ERROR;
  }
}
