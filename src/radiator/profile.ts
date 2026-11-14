import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '../db/index.js';
import { boards, items } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import { enqueueTransaction } from '../db/queue.js';
import { validateDescriptor, type BoardDescriptor } from '../descriptor/types.js';
import { validateDescriptorProposal } from '../descriptor/guardrails.js';
import { RADIATOR_BOARD_ID, RADIATOR_MODEL_ID, RADIATOR_PROFILE_KEY, isRadiatorMetadataKey } from './contract.js';

export const PROFILE_KEY = RADIATOR_PROFILE_KEY;
export const isRadiatorBoardActive = (handle: DbHandle, boardId: string): boolean => boardId === RADIATOR_BOARD_ID && getSetting(handle, PROFILE_KEY) !== undefined;
export const INTEL_DESCRIPTOR = validateDescriptor(JSON.parse(readFileSync(new URL('../../docs/radiator-intel-schema-v1.json', import.meta.url), 'utf8')));
export const EXECUTION_RULES = JSON.parse(readFileSync(new URL('../../docs/radiator-intel-execution-rules-v1.json', import.meta.url), 'utf8'));
export interface BaselineSource { id: string; path: string; sha256: string; status: string; text: string }
export interface Baseline { format: string; reviewedOn: string; summary: string; sources: BaselineSource[] }
export const PINNED_BASELINE: Baseline = JSON.parse(readFileSync(new URL('../../docs/radiator-baseline-v1.json', import.meta.url), 'utf8'));
export const PROTECTED_KEYS = ['url', 'screenshot', 'aesthetic_tags', 'tone', 'my_notes'];
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const descriptorSignature = (d: BoardDescriptor): string => digest({ fields: d.fields, enrichment_prompt: d.enrichment_prompt, ingest_mode: d.ingest_mode });
export function boardGuard(board: { id: string; name: string; view: string; descriptor: unknown }): string {
  return digest({ id: board.id, name: board.name, view: board.view, descriptor: board.descriptor });
}
export interface RadiatorProfile {
  version: 1; boardId: string; modelId: string; beforeBoardSha256: string;
  legacyDescriptor: BoardDescriptor; descriptorSignature: string; baselineSha256: string;
  legacyGeneratedKeys: string[];
}
export function getRadiatorProfile(handle: DbHandle, boardId: string): RadiatorProfile | undefined {
  if (boardId !== RADIATOR_BOARD_ID) return undefined;
  const raw = getSetting(handle, PROFILE_KEY);
  if (raw === undefined) return undefined;
  assert(Buffer.byteLength(raw) <= 131072, 'Invalid Radiator profile size');
  const p: RadiatorProfile = JSON.parse(raw);
  assert(p.version === 1 && p.boardId === RADIATOR_BOARD_ID && p.modelId === RADIATOR_MODEL_ID && p.baselineSha256 === digest(PINNED_BASELINE), 'Invalid Radiator profile');
  validateDescriptor(p.legacyDescriptor);
  assert(Array.isArray(p.legacyGeneratedKeys) && p.legacyGeneratedKeys.every(k => typeof k === 'string' && !PROTECTED_KEYS.includes(k) && !k.startsWith('radiator_meta.')), 'Invalid recovery field mapping');
  return p;
}
export function assertActiveDescriptor(profile: RadiatorProfile, descriptor: unknown): void {
  assert(descriptorSignature(validateDescriptor(descriptor)) === profile.descriptorSignature, 'Radiator schema changed; reactivate a reviewed profile before analysis');
}
export function proposedRadiatorDescriptor(before: BoardDescriptor): BoardDescriptor {
  const protectedFields = PROTECTED_KEYS.map(key => {
    const field = before.fields.find(f => f.key === key);
    assert(field, `Missing protected Radiator field: ${key}`);
    return { ...field, enrichable: false };
  });
  const fields = [...INTEL_DESCRIPTOR.fields];
  // Rationale precedes subject in generic fallbacks too; the active UI binds both explicitly.
  const rationale = fields.splice(fields.findIndex(f => f.key === 'intel_v1.rationale'), 1)[0];
  fields.splice(1, 0, rationale);
  const proposal = { ...before, fields: [...protectedFields, ...fields], enrichment_prompt: INTEL_DESCRIPTOR.enrichment_prompt + '\n' + JSON.stringify(EXECUTION_RULES) };
  assert(proposal.fields.length === 22 && new Set(proposal.fields.map(f => f.key)).size === 22, 'Expected exactly 22 unique fields');
  assert(validateDescriptorProposal(proposal).ok, 'Invalid Radiator descriptor proposal');
  return validateDescriptor(proposal);
}
/** Explicit local activation seam, not called at startup or exposed as an HTTP write. */
export function activateRadiatorProfile(handle: DbHandle, args: { boardId: string; expectedBoardSha256: string }): Promise<'activated' | 'already-active'> {
  return enqueueTransaction(handle, () => activateRadiatorProfileDirect(handle, args));
}
/** Caller must hold the write lane/transaction; reused by explicit guarded migration. */
export function activateRadiatorProfileDirect(handle: DbHandle, args: { boardId: string; expectedBoardSha256: string }): 'activated' | 'already-active' {
    assert(args.boardId === RADIATOR_BOARD_ID, 'Only the authoritative Radiator board can be activated');
    const board = handle.db.select().from(boards).where(eq(boards.id, args.boardId)).get();
    assert(board && board.name === 'Radiator', 'Exact Radiator target not found');
    const existing = getRadiatorProfile(handle, board.id);
    if (existing) {
      assert(existing.beforeBoardSha256 === args.expectedBoardSha256, 'Activation before-image mismatch');
      assertActiveDescriptor(existing, board.descriptor);
      return 'already-active';
    }
    assert(boardGuard(board) === args.expectedBoardSha256, 'Radiator before-image changed');
    for (const item of handle.db.select().from(items).where(eq(items.boardId, board.id)).all()) assert(!Object.keys((item.fields as Record<string, unknown>) ?? {}).some(isRadiatorMetadataKey), 'Existing reserved metadata requires explicit review before activation');
    const before = validateDescriptor(board.descriptor);
    const descriptor = proposedRadiatorDescriptor(before);
    const profile: RadiatorProfile = { version: 1, boardId: board.id, modelId: RADIATOR_MODEL_ID,
      beforeBoardSha256: args.expectedBoardSha256, legacyDescriptor: before,
      descriptorSignature: descriptorSignature(descriptor), baselineSha256: digest(PINNED_BASELINE),
      legacyGeneratedKeys: before.fields.filter(f => f.enrichable === true && !['tags', 'image', 'url'].includes(f.type) && ![...PROTECTED_KEYS, 'text', 'source_url', 'captured_on'].includes(f.key)).map(f => f.key) };
    setSetting(handle, PROFILE_KEY, JSON.stringify(profile));
    handle.db.update(boards).set({ descriptor }).where(eq(boards.id, board.id)).run();
    return 'activated';
}

/** Bad/stale Radiator configuration must not break unrelated collection discovery. */
export function radiatorPublicConfiguration(handle: DbHandle, boardId: string) {
  if (!isRadiatorBoardActive(handle, boardId)) return undefined;
  try {
    const p = getRadiatorProfile(handle, boardId)!;
    return { version: 1, modelId: RADIATOR_MODEL_ID, legacyDescriptor: p.legacyDescriptor };
  } catch {
    let legacyDescriptor: BoardDescriptor | undefined;
    try { legacyDescriptor = validateDescriptor(JSON.parse(getSetting(handle, PROFILE_KEY)!).legacyDescriptor); } catch {}
    return { version: 1, modelId: RADIATOR_MODEL_ID, legacyDescriptor, configurationError: true };
  }
}
