import { z } from 'zod';
import { parseJsonFromTextWithRepairs, extractAnalysisPayload } from '../add.js';
import type { JsonRepair } from '../json-repair.js';
import type { BoardDescriptor } from '../descriptor/types.js';
import { buildEnrichmentSchema } from './worker.js';

// Offline replay of a model output through the same parse -> repair -> schema path the
// CLI provider uses for enrichment. Pure: no database, no model, no writes. Use it on a
// saved raw output (failures/<item>-<time>.raw.txt) to see exactly which rule rejected
// it, or to check a descriptor change against known-bad outputs.

export interface ReplayVerdict {
  ok: boolean;
  /** Deletion-only repairs applied before parsing (key names only). */
  repairs: JsonRepair[];
  /** What would be written: the schema-valid, model-emittable fields (and a refined title). */
  accepted: Record<string, unknown>;
  /** Keys the model returned that the board does not accept (dropped silently by the schema). */
  ignoredKeys: string[];
  /** Why it was rejected, one entry per problem; empty when ok. */
  issues: string[];
}

export function replayEnrichment(descriptor: BoardDescriptor, raw: string): ReplayVerdict {
  const schema = buildEnrichmentSchema(descriptor).extend({ title: z.string().optional() });
  const verdict: ReplayVerdict = { ok: false, repairs: [], accepted: {}, ignoredKeys: [], issues: [] };

  let payload: unknown;
  try {
    const parsed = parseJsonFromTextWithRepairs(raw);
    verdict.repairs = parsed.repairs;
    payload = extractAnalysisPayload(parsed.value);
  } catch (err) {
    verdict.issues.push(`not parseable as JSON: ${(err as Error).message}`);
    return verdict;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    verdict.issues.push('top-level value is not a JSON object');
    return verdict;
  }
  verdict.ignoredKeys = Object.keys(payload).filter((k) => !(k in schema.shape));
  const result = schema.safeParse(payload);
  if (!result.success) {
    verdict.issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return verdict;
  }
  verdict.accepted = result.data as Record<string, unknown>;
  verdict.ok = true;
  return verdict;
}
