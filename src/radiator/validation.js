import assert from 'node:assert/strict';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export function validateIntelResponse(result, job, e, baselineIds, schema) {
  const AI_KEYS = schema.fields.filter(f => f.enrichable).map(f => f.key);
  assert(object(result) && Object.keys(result).sort().join(',') === 'fields,itemId,source', 'Only declarative response fields permitted');
  assert(result.itemId === job.id && result.source === job.source && object(result.fields), 'Response identity mismatch');
  const normalizedFields = Object.create(null);
  for (const [key, value] of Object.entries(result.fields)) {
    const target = AI_KEYS.includes(key) ? key : (AI_KEYS.includes(`intel_v1.${key}`) ? `intel_v1.${key}` : key);
    assert(!own(normalizedFields, target), 'Conflicting canonical/short analysis keys');
    normalizedFields[target] = value;
  }
  assert(Object.keys(normalizedFields).sort().join(',') === [...AI_KEYS].sort().join(','), 'Missing/extra analysis fields');
  assert(Array.isArray(baselineIds), 'Pinned baseline source IDs required');
  const ids = new Set([...e.sources.map(s => s.id), ...baselineIds]);
  const urls = new Set([job.source, ...e.sources.map(s => s.url)]);
  for (const f of schema.fields.filter(f => f.enrichable)) {
    const v = normalizedFields[f.key]; assert(typeof v === 'string' && v.trim(), 'Empty/nonstring analysis value');
    if (f.type === 'enum') assert(f.values.includes(v), 'Invalid relation');
    if (/^(Unknown|Not applicable):/i.test(v)) assert(v.length >= 24, 'Unknown/not-applicable needs a reason');
    for (const id of v.match(/\b[TR]\d+[A-Z]*\b/g) ?? []) assert(ids.has(id), 'Invented source ID');
    for (const u of v.match(/https?:\/\/[^\s<>"\]]+/g) ?? []) assert([...urls].some(allowed => u === allowed || u.startsWith(allowed) && /^[.,;)]+$/.test(u.slice(allowed.length))), 'Unsupplied URL');
  }
  for (const k of ['job', 'workflow', 'boundary', 'control', 'operations', 'comparison']) {
    const v = normalizedFields['intel_v1.' + k];
    assert(/\[\s*T\d+(?:\s*,\s*[TR]\d+[A-Z]*)*\s*\]/.test(v) || /^(Unknown|Not applicable):/i.test(v), 'Claims need supplied citations or an explicit unknown');
  }
  assert(/analyst inference/i.test(normalizedFields['intel_v1.implication']), 'Implication must be labeled inference');
  return normalizedFields;
}
