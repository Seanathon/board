import assert from 'node:assert/strict';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '../db/index.js';
import { assets, boards, items, settings, type Item, type Board } from '../db/schema.js';
import { enqueueTransaction, writeItemDirect } from '../db/queue.js';
import { activateRadiatorProfileDirect, boardGuard, digest, PROFILE_KEY } from './profile.js';
import { RADIATOR_MODEL_ID } from './contract.js';
import { currentMigrationRecord, migrationAssetFileSha256, migrationAssetShape, migrationRecordSha256, type MigrationAsset, type PreparedMigration } from './migration-contract.js';
import { assertPreparedMigration } from './migration-input.js';

type Fields = Record<string, unknown>;
type Setting = typeof settings.$inferSelect;
interface Snapshot { board: Board | null; items: Item[]; assets: MigrationAsset[]; profile: Setting | null }
export interface MigrationConflict { code: string; id?: string; assetId?: string; keys?: string[] }
export interface MigrationPlan {
  runId: string; inputSha256: string; dataDir: string; database: string; planDigest: string;
  approvedEligible: number; eligible: number; retained: number; conflictedSelected: number;
  added: number; deleted: number; moved: number; executableChanges: number;
  retentionReasons: { blockedEvidence: number; invalidOutput: number; unspecified: number }; conflicts: MigrationConflict[];
}
interface Run {
  version: 1; runId: string; inputSha256: string; planDigest: string; dataDir: string;
  state: 'applied' | 'undone'; backupPath: string; backupSha256: string;
  prepared: PreparedMigration; before: Snapshot; after: Snapshot;
}
const TABLE = 'radiator_migration_run';
const sorted = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const fieldBag = (item: Item): Fields => (item.fields as Fields | null) ?? {};
const equal = (a: unknown, b: unknown) => digest(a ?? null) === digest(b ?? null);
const changedKeys = (a: Fields, b: Fields) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !equal(a[k], b[k]) || Object.hasOwn(a, k) !== Object.hasOwn(b, k)).sort();
function validateInput(prepared: PreparedMigration): void {
  assertPreparedMigration(prepared);
  assert(prepared.items.length === 119 && prepared.items.filter(i => i.disposition === 'eligible').length === 114 && prepared.items.filter(i => i.disposition === 'retained').length === 5, 'Exact approved119/114/5 accounting required');
}
const generated = (key: string) => key.startsWith('intel_v1.') || key === 'radiator_meta' || key.startsWith('radiator_meta.');
function directory(value: string): string {
  assert(typeof value === 'string' && path.isAbsolute(value), 'An explicit absolute directory is required');
  assert(lstatSync(value).isDirectory() && !lstatSync(value).isSymbolicLink(), 'Directory must not be a symlink');
  return realpathSync(value);
}
function snapshot(handle: DbHandle, prepared: PreparedMigration, dataDir: string, conflicts: MigrationConflict[]): Snapshot {
  const board = handle.db.select().from(boards).where(eq(boards.id, prepared.boardId)).get() ?? null;
  // Include moved selected rows as well as all current members (added-item guard).
  const selected = new Set(prepared.items.map(i => i.id));
  const rows = sorted(handle.db.select().from(items).all().filter(i => i.boardId === prepared.boardId || selected.has(i.id)));
  for (const row of rows) if (selected.has(row.id) && ['pending', 'processing'].includes(row.status)) conflicts.push({ code: 'item-in-flight', id: row.id });
  const rowIds = new Set(rows.map(i => i.id));
  const shots = sorted(handle.db.select().from(assets).all().filter(a => rowIds.has(a.itemId))).map(a => {
    let fileSha256 = '';
    try { fileSha256 = migrationAssetFileSha256(dataDir, a.path); }
    catch { conflicts.push({ code: 'asset-file-missing-or-unsafe', id: a.itemId, assetId: a.id }); }
    return { ...migrationAssetShape(a), fileSha256 };
  });
  return { board, items: rows, assets: shots, profile: handle.db.select().from(settings).where(eq(settings.key, PROFILE_KEY)).get() ?? null };
}
function inspectPlan(handle: DbHandle, prepared: PreparedMigration, dataDir: string): { plan: MigrationPlan; before: Snapshot } {
  validateInput(prepared);
  const conflicts: MigrationConflict[] = [];
  const before = snapshot(handle, prepared, dataDir, conflicts);
  if (!before.board || boardGuard(before.board) !== prepared.expectedBoardSha256) conflicts.push({ code: 'board-changed' });
  if (before.profile) conflicts.push({ code: 'profile-already-present' });
  const expected = new Set(prepared.items.map(i => i.id));
  for (const row of before.items) if (!expected.has(row.id)) conflicts.push({ code: 'item-added', id: row.id });
  const currentAssets = handle.db.select().from(assets).all();
  for (const entry of prepared.items) {
    const row = before.items.find(i => i.id === entry.id);
    if (!row) { conflicts.push({ code: 'item-deleted', id: entry.id }); continue; }
    if (row.boardId !== prepared.boardId) conflicts.push({ code: 'item-moved', id: entry.id });
    const shots = before.assets.filter(a => a.itemId === entry.id);
    const record = currentMigrationRecord(row, currentAssets.filter(a => a.itemId === entry.id));
    if (migrationRecordSha256(record) !== entry.expectedRecordSha256) conflicts.push({ code: 'item-edited', id: entry.id, keys: changedKeys(entry.expectedRecord, record) });
    if (!equal(shots, sorted([...entry.expectedAssets]))) conflicts.push({ code: 'assets-changed', id: entry.id });
    if (Object.keys(fieldBag(row)).some(generated)) conflicts.push({ code: 'existing-intelligence', id: entry.id });
  }
  const approved = prepared.items.filter(i => i.disposition === 'eligible');
  const retained = prepared.items.filter(i => i.disposition === 'retained');
  const globalConflict = conflicts.some(c => c.code === 'board-changed' || c.code === 'profile-already-present');
  const conflictedIds = new Set(conflicts.flatMap(c => c.id && expected.has(c.id) ? [c.id] : []));
  const eligible = globalConflict ? 0 : approved.filter(i => !conflictedIds.has(i.id)).length;
  const count = (code: string) => new Set(conflicts.filter(c => c.code === code).map(c => c.id)).size;
  const body = { runId: prepared.runId, inputSha256: prepared.inputSha256, dataDir, database: handle.sqlite.name === ':memory:' ? ':memory:' : realpathSync(handle.sqlite.name),
    approvedEligible: approved.length, eligible, retained: retained.length,
    conflictedSelected: globalConflict ? prepared.items.length : conflictedIds.size,
    added: count('item-added'), deleted: count('item-deleted'), moved: count('item-moved'), executableChanges: conflicts.length ? 0 : eligible,
    retentionReasons: { blockedEvidence: retained.filter(i => i.retentionReason === 'blocked-evidence').length, invalidOutput: retained.filter(i => i.retentionReason === 'invalid-output').length, unspecified: retained.filter(i => !i.retentionReason).length }, conflicts };
  return { plan: { ...body, planDigest: digest({ ...body, prepared, before }) }, before };
}
/** SELECT-only; even the ledger table is not created until explicit apply. */
export function dryRunMigration(handle: DbHandle, prepared: PreparedMigration, options: { dataDir: string }): MigrationPlan {
  const dataDir = directory(options.dataDir);
  return handle.sqlite.transaction(() => inspectPlan(handle, prepared, dataDir).plan)();
}
function loadRun(handle: DbHandle, runId: string): Run | undefined {
  if (!handle.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)) return undefined;
  const row = handle.sqlite.prepare(`SELECT payload FROM ${TABLE} WHERE run_id=?`).get(runId) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as Run : undefined;
}
function durableBackup(backupDir: string, prepared: PreparedMigration, before: Snapshot, planDigest: string) {
  assert(/^[a-zA-Z0-9_-]{1,160}$/.test(prepared.runId), 'Unsafe migration run ID');
  const body = { version: 1, prepared, before, planDigest };
  const backupSha256 = digest(body);
  const backupPath = path.join(backupDir, `${prepared.runId}-${backupSha256}.json`);
  if (existsSync(backupPath)) {
    assert(lstatSync(backupPath).isFile() && !lstatSync(backupPath).isSymbolicLink(), 'Unsafe before-image');
    assert(digest(JSON.parse(readFileSync(backupPath, 'utf8'))) === backupSha256, 'Before-image collision');
  } else {
    const temporary = path.join(backupDir, `.migration-${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(fd, JSON.stringify(body)); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temporary, backupPath); }
    catch (error) { unlinkSync(temporary); throw error; }
  }
  // Sync even an existing file: a previous attempt may have stopped before fsync.
  const file = openSync(backupPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(file); } finally { closeSync(file); }
  const dir = openSync(backupDir, constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
  const parent = openSync(path.dirname(backupDir), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return { backupPath, backupSha256 };
}
function ensureClean(conflicts: MigrationConflict[]): void {
  assert(conflicts.length === 0, `Migration conflicts: ${JSON.stringify(conflicts)}`);
}
/** All fresh guards, ledger DDL, profile and typed writes share one SQLite transaction. */
export async function applyMigration(handle: DbHandle, prepared: PreparedMigration, options: { dataDir: string; backupDir: string; planDigest: string }) {
  validateInput(prepared);
  const planDigest = options.planDigest;
  assert(/^[a-f0-9]{64}$/.test(planDigest), 'Explicit dry-run plan digest required');
  const dataDir = directory(options.dataDir); const backupDir = directory(options.backupDir);
  assert(backupDir !== dataDir && !backupDir.startsWith(dataDir + path.sep), 'Backup directory must be outside the data directory');
  // Clone before queueing so a caller cannot change validated values across the await.
  const input = structuredClone(prepared);
  return enqueueTransaction(handle, () => {
    validateInput(input);
    const previous = loadRun(handle, input.runId);
    if (previous) {
      assert(previous.inputSha256 === input.inputSha256 && equal(previous.prepared, input) && previous.planDigest === planDigest && previous.dataDir === dataDir, 'Run identity mismatch');
      assert(previous.state === 'applied', 'Run was undone; cannot silently reapply');
      ensureClean(inspectRun(handle, previous, dataDir));
      return { runId: previous.runId, state: previous.state, alreadyApplied: true, eligible: input.items.filter(i => i.disposition === 'eligible').length, retained: input.items.filter(i => i.disposition === 'retained').length };
    }
    const { plan, before } = inspectPlan(handle, input, dataDir);
    ensureClean(plan.conflicts);
    assert(plan.planDigest === planDigest, 'Stale dry-run plan digest');
    const backup = durableBackup(backupDir, input, before, plan.planDigest);
    handle.sqlite.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (run_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)`);
    activateRadiatorProfileDirect(handle, { boardId: input.boardId, expectedBoardSha256: input.expectedBoardSha256 });
    for (const entry of input.items) {
      if (entry.disposition === 'retained') continue;
      const row = before.items.find(i => i.id === entry.id)!;
      const fields = { ...fieldBag(row) };
      for (const key of entry.deleteKeys) delete fields[key];
      Object.assign(fields, entry.setFields);
      writeItemDirect(handle, { ...row, fields, analysisProvider: 'claude-cli-subscription', analysisModel: RADIATOR_MODEL_ID });
    }
    const conflicts: MigrationConflict[] = [];
    const after = snapshot(handle, input, dataDir, conflicts);
    ensureClean(conflicts);
    assert(equal(before.assets, after.assets), 'Assets changed during apply');
    const run: Run = { version: 1, runId: input.runId, inputSha256: input.inputSha256, planDigest: plan.planDigest, dataDir, state: 'applied', ...backup, prepared: input, before, after };
    handle.sqlite.prepare(`INSERT INTO ${TABLE}(run_id,payload) VALUES (?,?)`).run(run.runId, JSON.stringify(run));
    ensureClean(inspectRun(handle, run, dataDir));
    return { runId: run.runId, state: run.state, alreadyApplied: false, eligible: plan.eligible, retained: plan.retained };
  });
}
// Descriptor activation owns only these two properties, not archive/auto-enrich/UI flags.
const descriptorOwned = (board: Board) => {
  const d = board.descriptor as Fields;
  return { fields: d?.fields, enrichment_prompt: d?.enrichment_prompt };
};
function watchedKeys(run: Run, id: string): string[] {
  const entry = run.prepared.items.find(i => i.id === id)!;
  const beforeDescriptor = run.before.board!.descriptor as { fields: { key: string; enrichable?: boolean; type: string }[] };
  return [...new Set([...entry.deleteKeys, ...Object.keys(entry.setFields), ...beforeDescriptor.fields.filter(f => f.enrichable && !['tags', 'image', 'url'].includes(f.type) && !['my_notes', 'text', 'source_url', 'captured_on'].includes(f.key)).map(f => f.key)])];
}
function ownedItem(item: Item, keys: string[]) {
  const fields = fieldBag(item);
  const allKeys = [...new Set([...keys, ...Object.keys(fields).filter(generated)])].sort();
  return { boardId: item.boardId, source: item.source, analysisProvider: item.analysisProvider, analysisModel: item.analysisModel,
    fields: allKeys.map(k => [k, Object.hasOwn(fields, k), fields[k] ?? null]) };
}
function inspectRun(handle: DbHandle, run: Run, dataDir: string): MigrationConflict[] {
  assert(run.version === 1 && run.dataDir === dataDir, 'Migration data directory mismatch');
  const conflicts: MigrationConflict[] = [];
  const current = snapshot(handle, run.prepared, dataDir, conflicts);
  const expected = run.state === 'applied' ? run.after : run.before;
  if (!current.board || current.board.name !== expected.board!.name || current.board.view !== expected.board!.view || !equal(descriptorOwned(current.board), descriptorOwned(expected.board!))) conflicts.push({ code: 'owned-descriptor-changed' });
  if (!equal(current.profile?.value, expected.profile?.value)) conflicts.push({ code: 'profile-changed' });
  if (!equal(current.items.map(i => i.id), expected.items.map(i => i.id))) conflicts.push({ code: 'membership-changed' });
  if (!equal(current.assets, expected.assets)) conflicts.push({ code: 'assets-changed' });
  for (const row of current.items) {
    const original = expected.items.find(i => i.id === row.id);
    if (!original || !run.prepared.items.some(i => i.id === row.id)) continue;
    const keys = watchedKeys(run, row.id);
    if (!equal(ownedItem(row, keys), ownedItem(original, keys))) conflicts.push({ code: 'owned-item-changed', id: row.id });
  }
  try {
    assert(lstatSync(run.backupPath).isFile() && !lstatSync(run.backupPath).isSymbolicLink());
    assert(digest({ version: 1, prepared: run.prepared, before: run.before, planDigest: run.planDigest }) === run.backupSha256);
    assert(digest(JSON.parse(readFileSync(run.backupPath, 'utf8'))) === run.backupSha256);
  } catch { conflicts.push({ code: 'before-image-missing-or-changed' }); }
  return conflicts;
}
export function verifyMigration(handle: DbHandle, options: { runId: string; dataDir: string }) {
  const dataDir = directory(options.dataDir);
  return handle.sqlite.transaction(() => {
    const run = loadRun(handle, options.runId); assert(run, 'Migration run not found');
    const conflicts = inspectRun(handle, run, dataDir);
    return { runId: run.runId, state: run.state, ok: conflicts.length === 0, eligible: run.prepared.items.filter(i => i.disposition === 'eligible').length, retained: run.prepared.items.filter(i => i.disposition === 'retained').length, conflicts };
  })();
}
/** Restores only owned values; later notes/tags/favorite/opaque fields survive. */
export async function undoMigration(handle: DbHandle, options: { runId: string; dataDir: string }) {
  const dataDir = directory(options.dataDir);
  return enqueueTransaction(handle, () => {
    const run = loadRun(handle, options.runId); assert(run, 'Migration run not found');
    ensureClean(inspectRun(handle, run, dataDir));
    if (run.state === 'undone') return { runId: run.runId, state: run.state, alreadyUndone: true };
    const board = handle.db.select().from(boards).where(eq(boards.id, run.prepared.boardId)).get()!;
    handle.db.update(boards).set({ descriptor: { ...(board.descriptor as Fields), ...descriptorOwned(run.before.board!) } }).where(eq(boards.id, board.id)).run();
    if (run.before.profile) handle.db.insert(settings).values(run.before.profile).onConflictDoUpdate({ target: settings.key, set: run.before.profile }).run();
    else handle.db.delete(settings).where(eq(settings.key, PROFILE_KEY)).run();
    for (const entry of run.prepared.items) {
      if (entry.disposition === 'retained') continue;
      const current = handle.db.select().from(items).where(eq(items.id, entry.id)).get()!;
      const before = run.before.items.find(i => i.id === entry.id)!;
      const fields = { ...fieldBag(current) };
      for (const key of new Set([...entry.deleteKeys, ...Object.keys(entry.setFields)])) {
        if (Object.hasOwn(fieldBag(before), key)) fields[key] = fieldBag(before)[key];
        else delete fields[key];
      }
      writeItemDirect(handle, { ...current, fields, analysisProvider: before.analysisProvider, analysisModel: before.analysisModel });
    }
    run.state = 'undone';
    ensureClean(inspectRun(handle, run, dataDir));
    handle.sqlite.prepare(`UPDATE ${TABLE} SET payload=? WHERE run_id=?`).run(JSON.stringify(run), run.runId);
    return { runId: run.runId, state: run.state, alreadyUndone: false };
  });
}
