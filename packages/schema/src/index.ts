export { flatten, MAX_DEPTH, MAX_FIELDS, type FlattenOptions } from './flatten.ts';
export { describeFields, fingerprint, normalizePath, valueType } from './fingerprint.ts';
export { guessRoles, scoreRole, MIN_CONFIDENCE } from './roles.ts';
export {
  DEFAULT_RESOLVED_VALUES,
  DEFAULT_SEVERITY,
  DEFAULT_SEVERITY_MAP,
  defaultDedupKey,
  normalize,
  normalizeFlat,
  normalizeSeverity,
  normalizeStatus,
  normalizeTimestamp,
  type NormalizeInput,
} from './normalize.ts';
export {
  detectPreset,
  matchPresets,
  presetMapping,
  PRESETS,
  type Preset,
  type PresetMapping,
} from './presets.ts';
