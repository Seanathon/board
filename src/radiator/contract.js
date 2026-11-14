// Portable vocabulary shared by the runtime and the existing browser UI.
export const RADIATOR_BOARD_ID = 'radiator-9k51';
export const RADIATOR_PROFILE_KEY = 'radiator.intelligence.profile';
export const RADIATOR_MODEL_ID = 'claude-sonnet-5-5';
export const RADIATOR_SCHEMA_VERSION = 'radiator-intel/1';
export const RADIATOR_PROMPT_VERSION = 'radiator-intel/1.1';
export const RADIATOR_META_PREFIX = 'radiator_meta.';
export const RADIATOR_RECEIPT_KEY = 'radiator_meta.receipt';
export const RADIATOR_STATE_KEY = 'radiator_meta.state';
export const RADIATOR_RECOVERY_KEY = 'radiator_meta.recovery';
export const RADIATOR_STAMP_KEYS = ['intel_v1.primary_source', 'intel_v1.reviewed_on', 'intel_v1.schema_version', 'intel_v1.prompt_version', 'intel_v1.baseline'];
export const RADIATOR_ANALYSIS_KEYS = ['relevance', 'subject', 'rationale', 'job', 'workflow', 'boundary', 'control', 'operations', 'comparison', 'implication', 'evidence', 'unknowns'].map(key => `intel_v1.${key}`);
export function isRadiatorReadOnlyField(key) {
  return isRadiatorMetadataKey(key) || RADIATOR_STAMP_KEYS.includes(key) || key === 'url' || key === 'screenshot';
}

export function generationOf(item) { return item.fields?.['radiator_meta.generation']; }

export function isRadiatorMetadataKey(key) { return key === 'radiator_meta' || key.startsWith(RADIATOR_META_PREFIX); }
