// ontology.mjs — load + query the artifact-type ontology (ontology.yml).
//
// v1 shape (design section 4.2):
//   version: 1
//   tiers: [discovery, ...]
//   types:
//     <type>:
//       tier: <tier>
//       ingredients: [<type>, ...]     # legal upstream types for this type
//   profiles:                          # named gate profiles (generalized Gate-A)
//     <profile>:
//       required: [<type>, ...]
// Pass rule per profile: every required type present + resolved, zero suspects,
// zero gaps (computed against that profile's required set).
import { readFileSync, existsSync } from 'node:fs';
import { parseYaml, YamlError } from './yaml.mjs';
import { ConfigError, ONTOLOGY_VERSION } from './errors.mjs';

export function loadOntology(ontologyPath) {
  if (!existsSync(ontologyPath)) {
    throw new ConfigError('TW_ONTOLOGY_NOT_FOUND', `ontology file not found: ${ontologyPath}`);
  }
  let o;
  try {
    o = parseYaml(readFileSync(ontologyPath, 'utf8'));
  } catch (e) {
    if (e instanceof YamlError) throw new ConfigError('TW_ONTOLOGY_YAML', `${ontologyPath}: ${e.message}`);
    throw e;
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    throw new ConfigError('TW_ONTOLOGY_SHAPE', `${ontologyPath}: ontology must be a YAML map`);
  }
  if (o.version !== ONTOLOGY_VERSION) {
    throw new ConfigError('TW_ONTOLOGY_VERSION',
      `${ontologyPath}: unsupported ontology version ${JSON.stringify(o.version)} (this engine reads version ${ONTOLOGY_VERSION})`);
  }
  if (!Array.isArray(o.tiers) || o.tiers.length === 0 || !o.tiers.every((t) => typeof t === 'string')) {
    throw new ConfigError('TW_ONTOLOGY_TIERS', `${ontologyPath}: "tiers" must be a non-empty list of tier names`);
  }
  if (o.types === null || typeof o.types !== 'object' || Array.isArray(o.types) || Object.keys(o.types).length === 0) {
    throw new ConfigError('TW_ONTOLOGY_TYPES', `${ontologyPath}: "types" must be a non-empty map`);
  }
  for (const [t, def] of Object.entries(o.types)) {
    if (def === null || typeof def !== 'object' || Array.isArray(def)) {
      throw new ConfigError('TW_ONTOLOGY_TYPE_SHAPE', `${ontologyPath}: type "${t}" must be a map`);
    }
    if (!o.tiers.includes(def.tier)) {
      throw new ConfigError('TW_ONTOLOGY_TYPE_TIER',
        `${ontologyPath}: type "${t}" has tier "${def.tier}" which is not in tiers [${o.tiers.join(', ')}]`);
    }
    const ing = def.ingredients === undefined ? [] : def.ingredients;
    if (!Array.isArray(ing)) {
      throw new ConfigError('TW_ONTOLOGY_TYPE_INGREDIENTS', `${ontologyPath}: type "${t}": "ingredients" must be a list`);
    }
    for (const p of ing) {
      if (!Object.prototype.hasOwnProperty.call(o.types, p)) {
        throw new ConfigError('TW_ONTOLOGY_TYPE_INGREDIENTS',
          `${ontologyPath}: type "${t}" lists unknown ingredient type "${p}"`);
      }
    }
    def.ingredients = ing;
    if (def.requiredForGate !== undefined) {
      throw new ConfigError('TW_ONTOLOGY_LEGACY_REQUIRED',
        `${ontologyPath}: type "${t}" uses legacy "requiredForGate" — ontology v1 uses named gate profiles ` +
        `(profiles.<name>.required). See docs/gate-profiles.md for the migration.`);
    }
  }
  if (o.profiles === null || typeof o.profiles !== 'object' || Array.isArray(o.profiles)
      || o.profiles === undefined || Object.keys(o.profiles).length === 0) {
    throw new ConfigError('TW_ONTOLOGY_NO_PROFILES',
      `${ontologyPath}: at least one gate profile is required (profiles.<name>.required: [types])`);
  }
  for (const [name, def] of Object.entries(o.profiles)) {
    if (def === null || typeof def !== 'object' || Array.isArray(def) || !Array.isArray(def.required)) {
      throw new ConfigError('TW_ONTOLOGY_PROFILE_SHAPE',
        `${ontologyPath}: profile "${name}" must be a map with a "required" list`);
    }
    for (const t of def.required) {
      if (!Object.prototype.hasOwnProperty.call(o.types, t)) {
        throw new ConfigError('TW_ONTOLOGY_PROFILE_TYPE',
          `${ontologyPath}: profile "${name}" requires unknown type "${t}"`);
      }
    }
  }
  return o;
}

export function knownType(onto, type) {
  return Object.prototype.hasOwnProperty.call(onto.types, type);
}

export function tierOf(onto, type) {
  return knownType(onto, type) ? onto.types[type].tier : null;
}

export function allowedIngredients(onto, type) {
  return knownType(onto, type) ? (onto.types[type].ingredients || []) : [];
}

// An ingredient edge child<-parent (child derives from parent) is legal only if
// the child's type lists the parent's type as an allowed ingredient.
export function isLegalEdge(onto, childType, parentType) {
  return allowedIngredients(onto, childType).includes(parentType);
}

export function profileNames(onto) {
  return Object.keys(onto.profiles).sort();
}

export function requiredTypes(onto, profileName) {
  if (!Object.prototype.hasOwnProperty.call(onto.profiles, profileName)) {
    throw new ConfigError('TW_ONTOLOGY_UNKNOWN_PROFILE',
      `unknown gate profile "${profileName}" (profiles: ${profileNames(onto).join(', ')})`);
  }
  return onto.profiles[profileName].required;
}
