// Explicit synthetic unit data only; the CLI loader separately pins the real approved artifacts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { INTEL_DESCRIPTOR, digest } from './profile.js';
import { sealPreparedMigration, assertPreparedMigration, loadApprovedMigration } from './migration-input.js';
import { migrationRecordSha256, migrationAssetFileSha256, type PreparedMigration } from './migration-contract.js';

function fixture(): PreparedMigration {
  const record = { id: 'synthetic-one', url: 'https://example.invalid/unit', title: 'Synthetic unit fixture', notes: null, favorite: false, old: 'Old synthetic read' };
  const board = { id: 'radiator-9k51', name: 'Radiator', view: 'grid', descriptor: { fields: [{ key: 'old', label: 'Old', type: 'text', enrichable: true }], enrichment_prompt: 'Fixture', view: 'grid', ingest_mode: 'url-readable' } };
  const fingerprints = { selection: 'a'.repeat(64), bundle: 'b'.repeat(64), archive: 'c'.repeat(64), baseline: 'd'.repeat(64), schema: digest(INTEL_DESCRIPTOR) };
  const fields: Record<string, unknown> = Object.fromEntries(INTEL_DESCRIPTOR.fields.filter(f => f.enrichable).map(f => [f.key, f.key === 'intel_v1.relevance' ? 'reference' : f.key === 'intel_v1.implication' ? 'Analyst inference: evaluate this synthetic fixture.' : 'Unknown: this synthetic fixture does not provide that evidence.']));
  Object.assign(fields, { 'intel_v1.primary_source': record.url, 'intel_v1.schema_version': 'radiator-intel/1', 'intel_v1.prompt_version': 'radiator-intel/1.1', 'intel_v1.reviewed_on': '2026-11-13', 'intel_v1.baseline': fingerprints.baseline });
  const text = 'Synthetic source material for unit validation'; const hash = createHash('sha256').update(text).digest('hex');
  fields['radiator_meta.receipt'] = { version: 1, kind: 'approved-local-migration', validationProfile: 'radiator-approved-local-run/1', itemId: record.id, boardId: board.id, source: record.url,
    modelId: 'claude-sonnet-5-5', sessionId: '12345678-1234-4234-8234-123456789abc', schemaVersion: 'radiator-intel/1', promptVersion: 'radiator-intel/1.1', baselineSha256: fingerprints.baseline, reviewedOn: '2026-11-13',
    sources: [{ id: 'T1', url: record.url, title: 'Synthetic source', text, rawSha256: hash, excerptSha256: hash }], responseSha256: 'e'.repeat(64), promptSha256: 'f'.repeat(64), approvedBundleSha256: fingerprints.bundle, approvedSelectionSha256: fingerprints.selection, originalReceiptSha256: '1'.repeat(64), usage: { input_tokens: 1, output_tokens: 1 }, optionalNotRetained: undefined };
  return sealPreparedMigration({ format: 'board-radiator-prepared-migration/1', boardId: 'radiator-9k51', expectedBoard: board, expectedBoardSha256: digest(board), fingerprints,
    items: [{ id: record.id, source: record.url, disposition: 'eligible', expectedRecord: record, expectedRecordSha256: migrationRecordSha256(record), expectedAssets: [], deleteKeys: ['old'], setFields: fields }] });
}
test('migration input seals exactly JSON-retained data and freezes nested provenance', () => {
  const input = fixture(); assertPreparedMigration(input); assertPreparedMigration(JSON.parse(JSON.stringify(input)));
  assert.equal(Object.hasOwn(input.items[0].setFields['radiator_meta.receipt'] as object, 'optionalNotRetained'), false);
  assert.ok(Object.isFrozen(input) && Object.isFrozen(input.items[0].setFields['radiator_meta.receipt']));
});
test('historical missing prompt hash is explicit and cannot erase model/session/response trust', () => {
  const input = structuredClone(fixture()); const receipt = input.items[0].setFields['radiator_meta.receipt'] as Record<string, unknown>;
  receipt.promptSha256 = null; receipt.promptHashRetained = false; receipt.provenanceLimitations = ['effective-prompt-hash-not-retained'];
  const { inputSha256: _input, runId: _run, ...body } = input; const honest = sealPreparedMigration(body); assertPreparedMigration(honest);
  for (const key of ['originalReceiptSha256', 'sessionId', 'responseSha256']) {
    const broken = structuredClone(body); delete (broken.items[0].setFields['radiator_meta.receipt'] as Record<string, unknown>)[key];
    assert.throws(() => assertPreparedMigration(sealPreparedMigration(broken)));
  }
  const silent = structuredClone(body); delete (silent.items[0].setFields['radiator_meta.receipt'] as Record<string, unknown>).provenanceLimitations;
  assert.throws(() => assertPreparedMigration(sealPreparedMigration(silent)));
});
test('actual artifact loader rejects unapproved fingerprints before opening input files', () => {
  assert.throws(() => loadApprovedMigration({ selectionPath: '/never-opened/selection.json', bundlePath: '/never-opened/bundle.json', baselinePath: '/never-opened/baseline.json', sourceDataDir: '/never-opened', expectedSelectionSha256: '0'.repeat(64), expectedBundleSha256: '0'.repeat(64), expectedArchiveSha256: '0'.repeat(64), expectedAssetManifestSha256: '0'.repeat(64) }), /Unapproved/);
});
test('migration asset guards reject escaping and symlinked inputs', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'board-migration-asset-unit-')); const root = path.join(parent, 'input'); mkdirSync(root);
  const outside = path.join(parent, 'outside.png'); writeFileSync(outside, 'synthetic image bytes'); symlinkSync(outside, path.join(root, 'linked.png'));
  try { assert.throws(() => migrationAssetFileSha256(root, '../outside.png')); assert.throws(() => migrationAssetFileSha256(root, 'linked.png')); }
  finally { rmSync(parent, { recursive: true, force: true }); }
});
