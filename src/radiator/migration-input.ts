import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { validateInput, validateResponse } from '../../scripts/radiator-intel.mjs';
import { digest, INTEL_DESCRIPTOR, PINNED_BASELINE, PROTECTED_KEYS } from './profile.js';
import { comparableMigrationRecord, migrationRecordSha256, migrationAssetShape, migrationAssetFileSha256, type PreparedMigration, type PreparedMigrationItem } from './migration-contract.js';
import { RADIATOR_BOARD_ID, RADIATOR_MODEL_ID, RADIATOR_ANALYSIS_KEYS, RADIATOR_STAMP_KEYS, RADIATOR_RECEIPT_KEY } from './contract.js';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const APPROVED_SELECTION_SHA256 = '82912ef03a2a59cc55bf7b620dbf3ac447e2beca7591e610292002db865dbe4c';
export const APPROVED_BUNDLE_SHA256 = 'c31bfb1bdfa85b92de42b7fcc7d5936edac5fed490639f803611143668f7cb10';
export const APPROVED_ARCHIVE_SHA256 = 'c77809fb152b47cef8e06f417a93fa4c488fdcd1b0afac2513d887a7825b6813';
export interface ApprovedMigrationPaths {
  selectionPath: string; bundlePath: string; baselinePath: string; sourceDataDir: string;
  expectedSelectionSha256: string; expectedBundleSha256: string; expectedArchiveSha256: string; expectedAssetManifestSha256: string;
}
function readJson(file: string, expected?: string): any {
  assert(path.isAbsolute(file), 'Explicit absolute migration input path required');
  const stat = lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024, 'Unsafe/oversized migration input');
  const bytes = readFileSync(file); if (expected) assert(SHA.test(expected) && createHash('sha256').update(bytes).digest('hex') === expected, 'Migration input fingerprint mismatch');
  return JSON.parse(bytes.toString('utf8'));
}
function url(value: unknown): asserts value is string { assert(typeof value === 'string'); const u = new URL(value); assert(['https:', 'http:'].includes(u.protocol) && !u.username && !u.password, 'Invalid analysis source URL'); }
function frozen<T>(v: T): T { if (v !== null && typeof v === 'object') { for (const child of Object.values(v)) frozen(child); Object.freeze(v); } return v; }
export function sealPreparedMigration(body: Omit<PreparedMigration, 'inputSha256' | 'runId'>): PreparedMigration {
  // Bind exactly the serializable data that the durable ledger/backup will retain.
  const serializable = JSON.parse(JSON.stringify(body));
  const inputSha256 = digest(serializable); return frozen({ ...serializable, inputSha256, runId: 'radiator-' + inputSha256 });
}
/** Programmatic shape/integrity gate; actual CLI input additionally passes the pinned artifact loader below. */
export function assertPreparedMigration(input: PreparedMigration): void {
  assert(input.format === 'board-radiator-prepared-migration/1' && input.boardId === RADIATOR_BOARD_ID && input.expectedBoard.id === RADIATOR_BOARD_ID && input.expectedBoard.name === 'Radiator', 'Invalid migration target');
  const { inputSha256, runId, ...body } = input;
  assert(SHA.test(inputSha256) && digest(body) === inputSha256 && runId === 'radiator-' + inputSha256 && digest(input.expectedBoard) === input.expectedBoardSha256, 'Prepared migration integrity mismatch');
  assert(Object.values(input.fingerprints).every(v => SHA.test(v)) && Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 200, 'Invalid migration fingerprints/count');
  const ids = new Set<string>(); let eligible = 0;
  const allowedDelete = new Set((input.expectedBoard.descriptor as any).fields.filter((f: any) => f.enrichable === true && !['tags', 'url', 'image'].includes(f.type) && ![...PROTECTED_KEYS, 'text', 'source_url', 'captured_on'].includes(f.key)).map((f: any) => f.key));
  for (const item of input.items) {
    assert(item.id && !ids.has(item.id) && item.id === item.expectedRecord.id && item.source === item.expectedRecord.url && migrationRecordSha256(item.expectedRecord) === item.expectedRecordSha256, 'Invalid migration item guard'); ids.add(item.id); url(item.source);
    assert(item.expectedAssets.every(a => a.itemId === item.id && SHA.test(a.fileSha256)), 'Invalid asset provenance');
    if (item.disposition === 'retained') { assert(item.retentionReason === undefined || ['blocked-evidence', 'invalid-output'].includes(item.retentionReason), 'Invalid retained outcome'); assert(item.deleteKeys.length === 0 && Object.keys(item.setFields).length === 0, 'Retained items cannot contain a replacement'); continue; }
    assert(item.disposition === 'eligible' && ++eligible <= 114 && new Set(item.deleteKeys).size === item.deleteKeys.length && item.deleteKeys.every(k => allowedDelete.has(k)), 'Invalid retirement keys/eligible count');
    const fields = item.setFields; const r = fields[RADIATOR_RECEIPT_KEY] as any;
    assert(Object.keys(fields).sort().join(',') === [...RADIATOR_ANALYSIS_KEYS, ...RADIATOR_STAMP_KEYS, RADIATOR_RECEIPT_KEY].sort().join(','), 'Unexpected migration replacement keys');
    assert(r?.version === 1 && r.kind === 'approved-local-migration' && r.validationProfile === 'radiator-approved-local-run/1' && r.previewOnly !== true && r.itemId === item.id && r.boardId === input.boardId && r.source === item.source && r.modelId === RADIATOR_MODEL_ID && UUID.test(r.sessionId), 'Invalid trusted historical receipt');
    assert(r.schemaVersion === 'radiator-intel/1' && r.promptVersion === 'radiator-intel/1.1' && r.baselineSha256 === input.fingerprints.baseline && r.reviewedOn === fields['intel_v1.reviewed_on'] && /^\d{4}-\d{2}-\d{2}$/.test(r.reviewedOn), 'Invalid historical analysis stamps');
    assert(fields['intel_v1.schema_version'] === r.schemaVersion && fields['intel_v1.prompt_version'] === r.promptVersion && fields['intel_v1.baseline'] === r.baselineSha256, 'Runner stamps disagree');
    assert(Array.isArray(r.sources) && r.sources.length > 0 && r.sources.length <= 6 && r.sources.every((s: any) => { url(s.url); return /^T[1-9]\d*$/.test(s.id) && typeof s.text === 'string' && s.text.length <= 50000 && SHA.test(s.rawSha256) && SHA.test(s.excerptSha256); }), 'Missing inspected source records');
    assert(SHA.test(r.responseSha256) && (SHA.test(r.promptSha256) || r.promptSha256 === null && r.promptHashRetained === false && SHA.test(r.originalReceiptSha256) && r.provenanceLimitations?.includes('effective-prompt-hash-not-retained')) && r.approvedBundleSha256 === input.fingerprints.bundle && r.approvedSelectionSha256 === input.fingerprints.selection, 'Receipt artifact binding missing');
    assert(Number.isSafeInteger(r.usage?.input_tokens) && r.usage.input_tokens >= 0 && r.usage.input_tokens <= 40000 && Number.isSafeInteger(r.usage?.output_tokens) && r.usage.output_tokens > 0 && r.usage.output_tokens <= 8000, 'Invalid actual usage metadata');
    validateResponse({ itemId: item.id, source: item.source, fields: Object.fromEntries(RADIATOR_ANALYSIS_KEYS.map(k => [k, fields[k]])) }, { id: item.id, source: item.source }, { sources: r.sources }, ['R1', 'R1G', 'R1J', 'R2']);
    const primary = fields['intel_v1.primary_source']; assert(primary === item.source || r.sources.some((s: any) => s.url === primary), 'Uninspected primary source stamp');
  }
}
/** Only this pinned loader converts actual retained worker provenance into trusted migration receipts. No model execution. */
export function loadApprovedMigration(args: ApprovedMigrationPaths): PreparedMigration {
  assert(args.expectedSelectionSha256 === APPROVED_SELECTION_SHA256 && args.expectedBundleSha256 === APPROVED_BUNDLE_SHA256 && args.expectedArchiveSha256 === APPROVED_ARCHIVE_SHA256, 'Unapproved migration artifact fingerprint');
  const selected = validateInput(readJson(args.selectionPath, args.expectedSelectionSha256));
  const bundle = readJson(args.bundlePath, args.expectedBundleSha256); const baseline = readJson(args.baselinePath);
  assert(bundle.format === 'board-radiator-replacement-bundle/1' && bundle.executable === false && bundle.appliesToProduction === false && bundle.boardId === RADIATOR_BOARD_ID && selected.board.id === RADIATOR_BOARD_ID && selected.items.length === 119 && bundle.entries.length === 119, 'Approved selection/bundle mismatch');
  assert(bundle.source.archiveSha256 === args.expectedArchiveSha256 && selected.provenance.archiveSha256 === args.expectedArchiveSha256 && digest(bundle.schema) === bundle.schemaSha256 && digest(INTEL_DESCRIPTOR) === bundle.schemaSha256 && digest(baseline) === bundle.baselineSha256, 'Schema/baseline/archive binding mismatch');
  const content = (b: any) => ({ ...b, sources: b.sources.map(({ path: _path, ...s }: any) => s) });
  assert(digest(content(baseline)) === digest(content(PINNED_BASELINE)), 'Approved canon content differs from runtime canon');
  const manifest = readJson(path.join(args.sourceDataDir, 'asset-manifest.json'), args.expectedAssetManifestSha256);
  assert(manifest.format === 'board-radiator-assets/1' && manifest.archiveSha256 === args.expectedArchiveSha256, 'Original archive asset manifest required');
  const assetFiles = new Map<string, any>(manifest.files.map((f: any) => [f.path, f]));
  assert(assetFiles.size === manifest.files.length && assetFiles.size === selected.assets.length, 'Incomplete/duplicate asset manifest');
  const entries = new Map<string, any>(bundle.entries.map((e: any) => [e.id, e])); assert(entries.size === 119, 'Duplicate bundle IDs');
  const items: PreparedMigrationItem[] = selected.items.map((record: any) => {
    const e = entries.get(record.id); assert(e && e.source === record.url, 'Bundle identity mismatch');
    const originalAssets = selected.assets.filter((a: any) => a.itemId === record.id);
    const expectedAssets = originalAssets.map((a: any) => { const original = assetFiles.get(a.path); assert(original && migrationAssetFileSha256(args.sourceDataDir, a.path) === original.sha256, 'Original asset bytes changed'); return { ...migrationAssetShape(a), fileSha256: original.sha256 }; });
    const common = { id: record.id, source: record.url, expectedRecord: comparableMigrationRecord(record), expectedRecordSha256: migrationRecordSha256(record), expectedAssets };
    if (e.status !== 'validated-awaiting-human-review') { assert(['blocked-evidence', 'invalid-output'].includes(e.status), 'Unrecognized retained outcome'); return { ...common, disposition: 'retained', retentionReason: e.status, setFields: {}, deleteKeys: [] }; }
    const r = e.controllerReceipt;
    assert(e.guards.expectedExportRecordSha256 === digest(record) && e.guards.expectedAssetRowsSha256 === digest(originalAssets) && e.guards.expectedBoardSha256 === digest(selected.board), 'Approved before-image mismatch');
    assert(r.controllerVerified === true && r.itemId === record.id && r.source === record.url && r.modelId === RADIATOR_MODEL_ID && r.configuredModelId === RADIATOR_MODEL_ID && r.noApiFallback === true && r.responseSha256 === e.outputSha256 && r.evidenceSha256 === digest(e.evidence) && r.effectiveModelsAsReported?.length === 1 && r.effectiveModelsAsReported[0] === RADIATOR_MODEL_ID, 'Retained worker attestation mismatch');
    const fields = e.setAnalysisFields;
    const receipt = { version: 1, kind: 'approved-local-migration', validationProfile: 'radiator-approved-local-run/1', itemId: record.id, boardId: RADIATOR_BOARD_ID, source: record.url,
      modelId: r.modelId, sessionId: r.sessionId, schemaVersion: fields['intel_v1.schema_version'], promptVersion: fields['intel_v1.prompt_version'], baselineSha256: bundle.baselineSha256,
      reviewedOn: fields['intel_v1.reviewed_on'], sources: e.evidence.sources.map((s: any) => ({ id: s.id, url: s.url, title: s.title, retrievedOn: s.retrievedOn, text: s.text, fullTextChars: s.fullTextChars, truncated: s.truncated, rawSha256: s.rawSha256, excerptSha256: s.excerptSha256 })),
      responseSha256: r.responseSha256, promptSha256: r.effectivePromptSha256 ?? null, promptHashRetained: SHA.test(r.effectivePromptSha256 ?? ''), provenanceLimitations: r.effectivePromptSha256 ? [] : ['effective-prompt-hash-not-retained'], executorSha256: r.executorSha256 ?? null, usage: r.usageAsReported, elapsedMs: r.elapsedSeconds * 1000,
      approvedBundleSha256: args.expectedBundleSha256, approvedSelectionSha256: args.expectedSelectionSha256, originalReceiptSha256: digest(r), originalEvidenceSha256: r.evidenceSha256,
      accountAuth: 'owner-confirmed-subscription-route', noApiFallback: true, canonContentEquivalentToRuntime: true, runtimeCanonSha256: digest(PINNED_BASELINE) };
    return { ...common, disposition: 'eligible', deleteKeys: e.deleteGeneratedKeys, setFields: { ...fields, [RADIATOR_RECEIPT_KEY]: receipt } };
  });
  assert(items.filter(i => i.disposition === 'eligible').length === 114, 'Approved114/5 accounting mismatch');
  const prepared = sealPreparedMigration({ format: 'board-radiator-prepared-migration/1', boardId: RADIATOR_BOARD_ID, expectedBoard: selected.board, expectedBoardSha256: digest(selected.board), items,
    fingerprints: { selection: args.expectedSelectionSha256, bundle: args.expectedBundleSha256, archive: args.expectedArchiveSha256, baseline: bundle.baselineSha256, schema: bundle.schemaSha256, assetManifest: args.expectedAssetManifestSha256 } });
  assertPreparedMigration(prepared); return prepared;
}
