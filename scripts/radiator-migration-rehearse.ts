#!/usr/bin/env node
// Explicit disposable rehearsal only. Never opens an existing DB or calls a model.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const inputDir = path.resolve(process.argv[2] ?? '');
const baselinePath = path.resolve(process.argv[3] ?? '');
const outputDir = path.resolve(process.argv[4] ?? '');
assert(process.argv[2] && process.argv[3] && process.argv[4], 'Usage: rehearse NEW_PREPARED_INPUT_DIR BASELINE_JSON EXISTING_EVIDENCE_DIR [--exercise]');
const dbPath = path.join(inputDir, 'rehearsal-board.db');
assert(!existsSync(dbPath), 'Rehearsal refuses an existing database');
const allowedInput = new Set(['selection.json', 'bundle.json', 'preview-input.json', 'asset-manifest.json', 'screenshots']);
assert(readdirSync(inputDir).every(name => allowedInput.has(name)), 'Rehearsal requires a fresh prepared directory, not an owner/preview data directory');
const marker = JSON.parse(readFileSync(path.join(inputDir, 'preview-input.json'), 'utf8'));
assert(marker.format === 'board-radiator-preview-input/1', 'Safely prepared private input required');
process.env.DATA_DIR = inputDir;
const [{ initDb }, { boards, items, assets }, { writeItem, deleteItem }, { eq }, { loadApprovedMigration }, migration, profile, contract, { exportJson }, { buildServer }, { disabledLlm }, ui] = await Promise.all([
  import('../src/db/index.js'), import('../src/db/schema.js'), import('../src/db/queue.js'), import('drizzle-orm'), import('../src/radiator/migration-input.js'), import('../src/radiator/migration.js'), import('../src/radiator/profile.js'), import('../src/radiator/migration-contract.js'), import('../src/db/export.js'), import('../src/server.js'), import('../src/skills/types.js'), import('../src/collections-ui.js'),
]);
const sourcePaths = { selectionPath: path.join(inputDir, 'selection.json'), bundlePath: path.join(inputDir, 'bundle.json'), baselinePath, sourceDataDir: inputDir,
  expectedSelectionSha256: marker.selectionSha256, expectedBundleSha256: marker.bundleSha256, expectedArchiveSha256: marker.archiveSha256, expectedAssetManifestSha256: marker.assetManifestSha256 };
const prepared = loadApprovedMigration(sourcePaths);
const selected = JSON.parse(readFileSync(sourcePaths.selectionPath, 'utf8'));
const handle = initDb(dbPath);
const save = (name: string, value: unknown) => writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const system = new Set(['id', 'url', 'title', 'status', 'error_reason', 'notes', 'favorite', 'added', 'analysis_agent', 'analysis_model', 'screenshot']);
try {
  handle.db.insert(boards).values(selected.board).run();
  // Explicit inverse of the incumbent one-dot export, not the lossy stock import or a reenrich shortcut.
  for (const record of selected.items) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (system.has(key)) continue;
      assert(!['__proto__', 'prototype', 'constructor'].includes(key), 'Unsafe source field');
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
        for (const [leaf, v] of Object.entries(value)) { assert(!leaf.includes('.') && !['__proto__', 'constructor', 'prototype'].includes(leaf)); fields[key + '.' + leaf] = v; }
      } else fields[key] = value;
    }
    const created = Date.parse(record.added);
    await writeItem(handle, { id: record.id, boardId: prepared.boardId, source: record.url, title: record.title ?? null, notes: record.notes ?? null, favorite: record.favorite ? 1 : 0,
      status: record.status ?? 'done', analysisProvider: record.analysis_agent ?? null, analysisModel: record.analysis_model ?? null, createdAt: Number.isFinite(created) ? Math.floor(created / 1000) : 0, fields });
  }
  for (const asset of selected.assets) handle.db.insert(assets).values(asset).run();
  handle.db.insert(boards).values({ id: 'unrelated-rehearsal-control', name: 'Unrelated control fixture', view: 'list', descriptor: { fields: [{ key: 'manual', label: 'Manual', type: 'text', enrichable: false }], enrichment_prompt: '', view: 'list', ingest_mode: 'manual-upload' } }).run();
  await writeItem(handle, { id: 'unrelated-control', boardId: 'unrelated-rehearsal-control', source: 'https://example.invalid/control', title: 'Synthetic unrelated control', notes: 'Preserve this fixture', favorite: 1, fields: { manual: 'untouched' }, status: 'done' });
  const originalExport = exportJson(handle);
  const initialAssets = handle.db.select().from(assets).all().map(a => ({ ...contract.migrationAssetShape(a), fileSha256: contract.migrationAssetFileSha256(inputDir, a.path) }));
  const protectedState = () => {
    const owned = new Set(prepared.items.flatMap(i => [...i.deleteKeys, ...Object.keys(i.setFields)]));
    return handle.db.select().from(items).all().sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ id: row.id, source: row.source, title: row.title, boardId: row.boardId, notes: row.notes, favorite: row.favorite, createdAt: row.createdAt, fields: Object.fromEntries(Object.entries((row.fields as Record<string, unknown>) ?? {}).filter(([k]) => !owned.has(k))) }));
  };
  const protectedBefore = profile.digest(protectedState());
  const unrelatedBefore = profile.digest({ board: originalExport.boards.find(b => b.id === 'unrelated-rehearsal-control'), item: originalExport.items['unrelated-rehearsal-control'] });
  const plan = migration.dryRunMigration(handle, prepared, { dataDir: inputDir });
  save('actual-selected-dry-run.json', { ...plan, node: process.version, nativeAbi: process.versions.modules, diagnosticRuntime: process.versions.node.split('.')[0] !== '22', mappedRecords: selected.items.length, uniqueUrls: new Set(selected.items.map((i: any) => i.url)).size, assetsVerified: initialAssets.length, protectedBefore, noStockImport: true, modelCalls: 0 });
  save('actual-selected-input-paths.json', { ...sourcePaths, dbPath, dataDir: inputDir });
  console.log(JSON.stringify({ milestone: 'actual-selected-dry-run', eligible: plan.eligible, retained: plan.retained, conflicts: plan.conflicts, planDigest: plan.planDigest, dbPath, dataDir: inputDir, diagnosticRuntime: process.versions.node.split('.')[0] !== '22' }));
  assert.equal(plan.conflicts.length, 0, 'Actual selected-data mapping has conflicts');
  if (process.argv.includes('--exercise')) {
    const backupDir = mkdtempSync(path.join(tmpdir(), 'board-radiator-migration-backup-'));
    const eligible = prepared.items.filter(i => i.disposition === 'eligible');
    const testRow = handle.db.select().from(items).where(eq(items.id, eligible[0].id)).get()!;
    await writeItem(handle, { ...testRow, notes: 'Intentional stale-note fixture' });
    const noteConflict = migration.dryRunMigration(handle, prepared, { dataDir: inputDir }); assert.ok(noteConflict.conflicts.some(c => c.code === 'item-edited'));
    await assert.rejects(migration.applyMigration(handle, prepared, { dataDir: inputDir, backupDir, planDigest: plan.planDigest }));
    await writeItem(handle, { ...handle.db.select().from(items).where(eq(items.id, testRow.id)).get()!, notes: testRow.notes });
    const firstAsset = prepared.items[0].expectedAssets[0]; const imagePath = path.join(inputDir, firstAsset.path);
    renameSync(imagePath, imagePath + '.held');
    let missingAssetConflicts;
    try { missingAssetConflicts = migration.dryRunMigration(handle, prepared, { dataDir: inputDir }).conflicts; assert.ok(missingAssetConflicts.some(c => c.code.includes('asset'))); }
    finally { renameSync(imagePath + '.held', imagePath); }
    const finalPlan = migration.dryRunMigration(handle, prepared, { dataDir: inputDir }); assert.equal(finalPlan.conflicts.length, 0);
    // Abort a real selected item's update inside the batch; the test-only DDL never touches another DB.
    handle.sqlite.exec('CREATE TABLE rehearsal_abort_target(id TEXT PRIMARY KEY)');
    handle.sqlite.prepare('INSERT INTO rehearsal_abort_target VALUES (?)').run(eligible[50].id);
    handle.sqlite.exec(`CREATE TRIGGER rehearsal_abort BEFORE UPDATE ON item WHEN NEW.id IN (SELECT id FROM rehearsal_abort_target) BEGIN SELECT RAISE(ABORT, 'rehearsal-interruption'); END;`);
    await assert.rejects(migration.applyMigration(handle, prepared, { dataDir: inputDir, backupDir, planDigest: finalPlan.planDigest }), /rehearsal-interruption/);
    assert.equal(handle.db.select().from(items).all().filter(i => (i.fields as any)?.['radiator_meta.receipt']).length, 0);
    assert.equal(profile.getRadiatorProfile(handle, prepared.boardId), undefined);
    handle.sqlite.exec('DROP TRIGGER rehearsal_abort; DROP TABLE rehearsal_abort_target');
    const applied = await migration.applyMigration(handle, prepared, { dataDir: inputDir, backupDir, planDigest: finalPlan.planDigest });
    const verified = migration.verifyMigration(handle, { runId: prepared.runId, dataDir: inputDir }); assert.equal(verified.ok, true);
    const repeated = await migration.applyMigration(handle, prepared, { dataDir: inputDir, backupDir, planDigest: finalPlan.planDigest }); assert.equal(repeated.alreadyApplied, true);
    assert.equal(profile.digest(protectedState()), protectedBefore);
    const actualAssets = handle.db.select().from(assets).all().map(a => ({ ...contract.migrationAssetShape(a), fileSha256: contract.migrationAssetFileSha256(inputDir, a.path) })); assert.deepEqual(actualAssets, initialAssets);
    const app = await buildServer({ db: handle, llm: disabledLlm, screenshotsDir: path.join(inputDir, 'screenshots') });
    let actualUi;
    try {
      const collections = (await app.inject('/api/collections')).json(); const col = collections.find((b: any) => b.id === prepared.boardId);
      const rows = (await app.inject('/api/collections/' + prepared.boardId + '/items')).json();
      const active = rows.filter((item: any) => ui.radiatorPresentation(item, col).active); const fallback = rows.length - active.length;
      assert.equal(active.length, 114); assert.equal(fallback, 5); assert.ok(active.every((item: any) => ui.cardSummary(item, col.descriptor, { collection: col }).lead?.value));
      actualUi = { items: rows.length, active: active.length, legacyFallback: fallback, fieldCount: col.descriptor.fields.length, actualSqliteNotProjection: true };
    } finally { await app.close(); }
    const afterExport = exportJson(handle); assert.equal(profile.digest({ board: afterExport.boards.find(b => b.id === 'unrelated-rehearsal-control'), item: afterExport.items['unrelated-rehearsal-control'] }), unrelatedBefore);
    const beforeUndoRow = handle.db.select().from(items).where(eq(items.id, testRow.id)).get()!;
    const afterFields = beforeUndoRow.fields as Record<string, unknown>;
    await writeItem(handle, { ...beforeUndoRow, fields: { ...afterFields, 'intel_v1.rationale': 'Intentional owned-value rollback conflict' } });
    await assert.rejects(migration.undoMigration(handle, { runId: prepared.runId, dataDir: inputDir }));
    await writeItem(handle, { ...handle.db.select().from(items).where(eq(items.id, testRow.id)).get()!, fields: afterFields });
    const current = handle.db.select().from(items).where(eq(items.id, testRow.id)).get()!;
    await writeItem(handle, { ...current, notes: 'Later curation survives undo', favorite: current.favorite ? 0 : 1, fields: { ...(current.fields as Record<string, unknown>), tone: ['rehearsal-later-curation'], my_notes: 'Later manual note' } });
    const laterCuration = profile.digest(protectedState());
    const undone = await migration.undoMigration(handle, { runId: prepared.runId, dataDir: inputDir });
    const undoVerified = migration.verifyMigration(handle, { runId: prepared.runId, dataDir: inputDir }); assert.equal(undoVerified.ok, true);
    assert.equal(profile.digest(protectedState()), laterCuration); assert.equal(profile.getRadiatorProfile(handle, prepared.boardId), undefined);
    const repeatedUndo = await migration.undoMigration(handle, { runId: prepared.runId, dataDir: inputDir }); assert.equal(repeatedUndo.alreadyUndone, true);
    const remainingReceipts = handle.db.select().from(items).all().filter(i => (i.fields as any)?.['radiator_meta.receipt']).length; assert.equal(remainingReceipts, 0);
    save('actual-selected-rehearsal.json', { node: process.version, abi: process.versions.modules, diagnosticRuntime: process.versions.node.split('.')[0] !== '22', runId: prepared.runId, inputSha256: prepared.inputSha256, selected: 119, eligible: 114, retained: 5, uniqueUrls: 118, planDigest: finalPlan.planDigest, applied, verified, repeated, actualUi, protectedBefore, protectedAfterApply: protectedBefore, all119AssetRowsAndBytesUnchanged: true, unrelatedFixtureUnchanged: true, staleNoteRejected: true, missingAssetConflicts, midTransactionInterruptionRolledBackToZero: true, ownedRollbackConflictRejected: true, laterCurationPreserved: true, undone, undoVerified, repeatedUndo, remainingReceipts, backupDir, dbPath, dataDir: inputDir, modelCalls: 0, productionTouched: false });
    console.log(JSON.stringify({ milestone: 'actual-selected-apply-verify-undo', actualUi, applied: 114, retained: 5, remainingReceiptsAfterUndo: remainingReceipts, laterCurationPreserved: true, modelCalls: 0, productionTouched: false }));
  }
} finally { handle.sqlite.close(); }
