import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, fstatSync, fchmodSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import * as schema from './schema.js';
import { type Board, type Item, type Asset, boards, items, assets } from './schema.js';
import type { DbHandle } from './index.js';
import { enqueueTransaction, writeItemDirect } from './queue.js';
import { updateBoardDescriptor } from './seed.js';
import { validateDescriptorProposal } from '../descriptor/guardrails.js';
import { SYSTEM_COLUMNS, type BoardDescriptor } from '../descriptor/types.js';
import { buildEnrichmentSchema } from '../enrichment/worker.js';

// Offline maintenance only. No provider, capture, HTTP route, or startup bootstrap.
// The operator must stop every writer and complete their service/storage backup gate.
const SlotSchema = z.discriminatedUnion('present', [
  z.object({ present: z.literal(false) }).strict(),
  z.object({ present: z.literal(true), value: z.unknown() }).strict(),
]);
const PatchSchema = z.object({
  id: z.string().min(1),
  expected: z.object({ source: z.string().nullable(), title: z.string().nullable(), fields: z.record(SlotSchema) }).strict(),
  set: z.record(z.unknown()),
  unset: z.array(z.string()).default([]),
}).strict();
const BundleSchema = z.object({
  version: z.literal(1), operationId: z.string().min(1).max(200), boardId: z.string().min(1),
  expectedDescriptor: z.unknown(), expectedView: z.enum(['grid', 'list']), descriptor: z.unknown(),
  expectedItemIds: z.array(z.string().min(1)), patches: z.array(PatchSchema), evidence: z.unknown().optional(),
}).strict();
export type MigrationBundle = z.input<typeof BundleSchema>;
type Bundle = z.output<typeof BundleSchema>;
type Slot = z.infer<typeof SlotSchema>;
interface FileGuard { path: string; sha256: string; dev: number; ino: number; size: number; mtimeMs: number; mode: number }
interface Snapshot { board: Board; rows: Item[]; assets: Asset[]; files: FileGuard[] }
export interface MigrationPlan { version: 1; digest: string; payloadHash: string; bundle: Bundle; before: Snapshot; dataDir: string; database: string }
interface Journal { plan: MigrationPlan; backup: string; backupHash: string }
interface JournalRow { payload_hash: string; state: 'applied' | 'undone'; record: string }
export interface ApplyOptions { digest: string; backupPath: string; offlineAcknowledged: boolean; backupAcknowledged: boolean }
const JOURNAL = 'board_migration_journal';
const fail = (message: string): never => { throw new Error(`Migration refused: ${message}`); };
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** Stable JSON, rejecting non-JSON data and prototype/hydration hazards at the boundary. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(k => {
      if (['__proto__', 'prototype', 'constructor'].includes(k)) fail('hostile JSON key');
      return `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`;
    }).join(',')}}`;
  }
  return fail('only finite JSON values are accepted');
}
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const slot = (fields: Record<string, unknown>, key: string): Slot => own(fields, key) ? { present: true, value: fields[key] } : { present: false };
const fieldsOf = (row: Item): Record<string, unknown> => {
  if (row.fields === null) return {};
  if (!row.fields || typeof row.fields !== 'object' || Array.isArray(row.fields)) return fail('item fields must be a flat object');
  return row.fields as Record<string, unknown>;
};
function safeKey(key: string): void {
  const root = key.split('.')[0];
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)?$/.test(key) || key.split('.').some(p => ['__proto__', 'prototype', 'constructor'].includes(p)) || SYSTEM_COLUMNS.has(root)) fail('unsafe field key');
}
function safeWriteKey(key: string): void {
  safeKey(key);
  // Display declarations may use these aliases; migration patches must never own them.
  if (['url', 'screenshot', 'added', 'queuePosition', 'errorReason'].includes(key.split('.')[0])) fail('unsafe field key');
}
function descriptor(value: unknown): BoardDescriptor {
  const result = validateDescriptorProposal(value);
  if (!result.ok) return fail('invalid descriptor');
  const parsed = result.descriptor!;
  if (!same(value, parsed)) fail('descriptor must be canonical: unknown or normalized properties');
  for (const f of parsed.fields) safeKey(f.key);
  const keys = new Set(parsed.fields.map(f => f.key));
  for (const key of keys) if (key.includes('.') && keys.has(key.split('.')[0])) fail('field grouping collision');
  return parsed;
}
function bundle(value: unknown): Bundle {
  canonicalJson(value);
  const parsed = BundleSchema.safeParse(value);
  if (!parsed.success) return fail('invalid bundle structure');
  const b = parsed.data;
  if (Buffer.byteLength(canonicalJson(b)) > 16 * 1024 * 1024) fail('bundle exceeds size limit');
  const old = descriptor(b.expectedDescriptor), next = descriptor(b.descriptor);
  for (const f of old.fields.filter(f => f.enrichable !== true)) {
    if (!next.fields.some(n => same(n, f))) fail('protected field declaration changed');
  }
  const oldByKey = new Map(old.fields.map(f => [f.key, f]));
  for (const f of next.fields) {
    const before = oldByKey.get(f.key);
    if (before && (before.type !== f.type || before.enrichable !== f.enrichable)) fail('field type or ownership changed');
  }
  if (new Set(b.expectedItemIds).size !== b.expectedItemIds.length || new Set(b.patches.map(p => p.id)).size !== b.patches.length) fail('duplicate item ID');
  const allowed = buildEnrichmentSchema(next).strict();
  for (const p of b.patches) {
    if (!b.expectedItemIds.includes(p.id)) fail('patch outside expected membership');
    const changed = [...Object.keys(p.set), ...p.unset];
    if (!changed.length || new Set(changed).size !== changed.length) fail('empty or duplicate patch keys');
    for (const k of [...Object.keys(p.expected.fields), ...changed]) safeWriteKey(k);
    for (const k of changed) {
      const before = oldByKey.get(k), after = next.fields.find(f => f.key === k);
      const safeBefore = before?.enrichable === true && !['image', 'url'].includes(before.type);
      const safeAfter = after?.enrichable === true && !['image', 'url'].includes(after.type);
      if (own(p.set, k) ? !safeAfter || (before && !safeBefore) : !safeBefore || (after && !safeAfter)) fail('protected patch field');
      if (!own(p.expected.fields, k)) fail('missing changed-slot expectation');
    }
    if (!allowed.safeParse(p.set).success) fail('invalid typed patch');
  }
  return b;
}

/** Open an EXISTING database without schema/bootstrap writes, even for dry-run/verify. */
export function openMigrationDb(path: string, readonly = true): DbHandle {
  const sqlite = new Database(path, { readonly, fileMustExist: true });
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
function databasePath(handle: DbHandle): string {
  const main = (handle.sqlite.pragma('database_list') as Array<{ name: string; file: string }>).find(r => r.name === 'main');
  if (!main?.file) return fail('file-backed database required');
  return realpathSync(main.file);
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function fileHash(fd: number): string {
  const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
  let size: number;
  while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size));
  return digest.digest('hex');
}
function fileGuard(root: string, storedPath: string): FileGuard {
  if (isAbsolute(storedPath)) return fail('absolute asset path');
  const path = resolve(root, storedPath);
  if (!inside(root, path) || !inside(root, realpathSync(path))) return fail('asset outside data directory');
  if (lstatSync(path).isSymbolicLink()) return fail('symlink asset');
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return fail('asset is not a regular file');
    const sha256 = fileHash(fd);
    const after = fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) return fail('asset changed during read');
    return { path: storedPath, sha256, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode };
  } finally { closeSync(fd); }
}
function snapshot(handle: DbHandle, boardId: string, root: string): Snapshot {
  const board = handle.db.select().from(boards).where(eq(boards.id, boardId)).get();
  if (!board) return fail('board missing');
  const rows = handle.db.select().from(items).where(eq(items.boardId, boardId)).all().sort((a, b) => a.id.localeCompare(b.id));
  const selectedAssets = handle.db.select({ asset: assets }).from(assets).innerJoin(items, eq(assets.itemId, items.id))
    .where(eq(items.boardId, boardId)).all().map(r => r.asset).sort((a, b) => a.id.localeCompare(b.id));
  const files = [...new Set(selectedAssets.map(a => a.path))].sort().map(p => fileGuard(root, p));
  return { board, rows, assets: selectedAssets, files };
}
function checkExpected(b: Bundle, state: Snapshot): void {
  if (!same(state.board.descriptor, b.expectedDescriptor) || state.board.view !== b.expectedView) fail('descriptor guard mismatch');
  if (!same(state.rows.map(r => r.id).sort(), [...b.expectedItemIds].sort())) fail('membership guard mismatch');
  const oldKeys = new Set((b.expectedDescriptor as BoardDescriptor).fields.map(f => f.key));
  for (const row of state.rows) {
    const fields = fieldsOf(row);
    for (const f of (b.descriptor as BoardDescriptor).fields) {
      if (!oldKeys.has(f.key) && own(fields, f.key)) fail('opaque field ownership conflict');
      for (const key of Object.keys(fields)) {
        if (key !== f.key && (key.startsWith(`${f.key}.`) || f.key.startsWith(`${key}.`))) fail('field grouping collision');
      }
    }
  }
  for (const p of b.patches) {
    const row = state.rows.find(r => r.id === p.id)!;
    if (row.source !== p.expected.source || row.title !== p.expected.title) fail('source/title guard mismatch');
    for (const [key, expected] of Object.entries(p.expected.fields)) if (!same(slot(fieldsOf(row), key), expected)) fail('field guard mismatch');
  }
}

/** Pure SELECT/file-read plan; digest binds full board membership, rows, assets and bytes. */
export function planMigration(handle: DbHandle, input: unknown, dataDir: string): MigrationPlan {
  const b = bundle(input), root = realpathSync(dataDir), database = databasePath(handle);
  if (!inside(root, database)) return fail('database must be inside explicit data directory');
  const before = snapshot(handle, b.boardId, root);
  checkExpected(b, before);
  const unsigned = { version: 1 as const, payloadHash: hash(b), bundle: b, before, dataDir: root, database };
  return { ...unsigned, digest: hash(unsigned) };
}
function journal(handle: DbHandle, id: string): JournalRow | undefined {
  if (!handle.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?").get(JOURNAL)) return undefined;
  return handle.sqlite.prepare('SELECT payload_hash, state, record FROM board_migration_journal WHERE operation_id=?').get(id) as JournalRow | undefined;
}
function acknowledge(opts: Pick<ApplyOptions, 'offlineAcknowledged' | 'backupAcknowledged'>): void {
  if (opts.offlineAcknowledged !== true || opts.backupAcknowledged !== true) fail('offline maintenance and operator backup acknowledgments required');
}
function durableBackup(path: string, plan: MigrationPlan): { path: string; hash: string } {
  if (!isAbsolute(path)) return fail('absolute backup path required');
  const parent = realpathSync(dirname(path)), target = resolve(parent, basename(path));
  if (inside(plan.dataDir, target)) return fail('backup must be outside data directory');
  const bytes = canonicalJson({ version: 1, plan });
  const fd = openSync(target, 'wx', 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(parent, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return { path: target, hash: createHash('sha256').update(bytes).digest('hex') };
}
function assertBackup(record: Journal): void {
  if (lstatSync(record.backup).isSymbolicLink()) fail('backup symlink');
  const fd = openSync(record.backup, 'r');
  try {
    const stat = fstatSync(fd), bytes = readFileSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || createHash('sha256').update(bytes).digest('hex') !== record.backupHash) fail('backup guard mismatch');
    if (!same(JSON.parse(bytes.toString('utf8')), { version: 1, plan: record.plan })) fail('journal/backup mismatch');
  } finally { closeSync(fd); }
}
function patched(row: Item, p: Bundle['patches'][number]): Item {
  const fields = { ...fieldsOf(row), ...p.set };
  for (const key of p.unset) delete fields[key];
  return { ...row, fields };
}
function reindex(handle: DbHandle, boardId: string): void {
  for (const row of handle.db.select().from(items).where(eq(items.boardId, boardId)).all()) writeItemDirect(handle, row);
}

export async function applyMigration(handle: DbHandle, input: unknown, dataDir: string, opts: ApplyOptions): Promise<{ state: 'applied'; repeated: boolean; digest: string }> {
  acknowledge(opts);
  const b = bundle(input);
  return enqueueTransaction(handle, () => {
    const existing = journal(handle, b.operationId);
    if (existing) {
      if (existing.payload_hash !== hash(b)) fail('operation ID payload conflict');
      if (existing.state === 'undone') fail('operation ID is terminal after undo');
      const record = JSON.parse(existing.record) as Journal;
      if (record.plan.database !== databasePath(handle) || record.plan.dataDir !== realpathSync(dataDir) || opts.digest !== record.plan.digest) fail('operation context/digest conflict');
      assertBackup(record);
      return { state: 'applied', repeated: true, digest: record.plan.digest };
    }
    const plan = planMigration(handle, b, dataDir);
    if (opts.digest !== plan.digest) fail('stale plan digest');
    const backup = durableBackup(opts.backupPath, plan);
    // File writes are outside SQLite. Recheck bytes/identity after fsync, before retiring data.
    if (!same(snapshot(handle, b.boardId, plan.dataDir), plan.before)) fail('state changed while saving backup');
    const record: Journal = { plan, backup: backup.path, backupHash: backup.hash };
    handle.sqlite.exec(`CREATE TABLE IF NOT EXISTS board_migration_journal (
      operation_id TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('applied','undone')), record TEXT NOT NULL
    )`);
    handle.sqlite.prepare('INSERT INTO board_migration_journal VALUES (?, ?, ?, ?)').run(b.operationId, plan.payloadHash, 'applied', canonicalJson(record));
    updateBoardDescriptor(handle.db, b.boardId, b.descriptor as BoardDescriptor);
    for (const p of b.patches) writeItemDirect(handle, patched(plan.before.rows.find(r => r.id === p.id)!, p));
    reindex(handle, b.boardId);
    if (!same(snapshot(handle, b.boardId, plan.dataDir).assets, plan.before.assets) || !same(snapshot(handle, b.boardId, plan.dataDir).files, plan.before.files)) fail('asset post-write guard mismatch');
    return { state: 'applied', repeated: false, digest: plan.digest };
  });
}

function loadJournal(handle: DbHandle, operationId: string, dataDir: string): { row: JournalRow; record: Journal } {
  const row = journal(handle, operationId);
  if (!row) return fail('operation missing');
  const record = JSON.parse(row.record) as Journal;
  const { plan } = record;
  if (plan.database !== databasePath(handle) || plan.dataDir !== realpathSync(dataDir)) fail('operation context mismatch');
  assertBackup(record);
  return { row, record };
}
function checkedJournal(handle: DbHandle, operationId: string, dataDir: string): { row: JournalRow; record: Journal; current: Snapshot } {
  const { row, record } = loadJournal(handle, operationId, dataDir);
  const { plan } = record;
  const current = snapshot(handle, plan.bundle.boardId, plan.dataDir);
  const expectedDescriptor = row.state === 'applied' ? plan.bundle.descriptor : plan.before.board.descriptor;
  const expectedView = row.state === 'applied' ? (plan.bundle.descriptor as BoardDescriptor).view : plan.before.board.view;
  if (!same(current.board.descriptor, expectedDescriptor) || current.board.view !== expectedView) fail('descriptor changed since operation');
  const originalIds = new Set(plan.before.rows.map(r => r.id));
  if (!same(current.rows.map(r => r.id).sort(), [...originalIds].sort())) fail('original membership changed');
  if (!same(current.assets.filter(a => originalIds.has(a.itemId)), plan.before.assets)) fail('asset row guard mismatch');
  for (const f of plan.before.files) if (!same(fileGuard(plan.dataDir, f.path), f)) fail('asset file guard mismatch');
  for (const p of plan.bundle.patches) {
    const before = plan.before.rows.find(r => r.id === p.id)!;
    const expected = row.state === 'applied' ? patched(before, p) : before;
    const actual = current.rows.find(r => r.id === p.id)!;
    if (actual.source !== before.source) fail('source changed since operation');
    for (const key of [...Object.keys(p.set), ...p.unset]) if (!same(slot(fieldsOf(actual), key), slot(fieldsOf(expected), key))) fail('touched field changed since operation');
  }
  return { row, record, current };
}

/** SELECT-only, allows later curation but checks touched values and retained asset identities. */
export function verifyMigration(handle: DbHandle, operationId: string, dataDir: string): { state: 'applied' | 'undone'; digest: string } {
  const { row, record } = checkedJournal(handle, operationId, dataDir);
  return { state: row.state, digest: record.plan.digest };
}
export async function undoMigration(handle: DbHandle, operationId: string, dataDir: string, opts: Pick<ApplyOptions, 'offlineAcknowledged' | 'backupAcknowledged'>): Promise<{ state: 'undone'; repeated: boolean }> {
  acknowledge(opts);
  return enqueueTransaction(handle, () => {
    if (loadJournal(handle, operationId, dataDir).row.state === 'undone') return { state: 'undone', repeated: true };
    const { record, current } = checkedJournal(handle, operationId, dataDir);
    const { plan } = record;
    updateBoardDescriptor(handle.db, plan.bundle.boardId, plan.before.board.descriptor as BoardDescriptor);
    handle.db.update(boards).set({ view: plan.before.board.view }).where(eq(boards.id, plan.bundle.boardId)).run();
    // Restore touched slots onto FRESH rows, never full historical rows or timestamps.
    for (const p of plan.bundle.patches) {
      const fresh = current.rows.find(r => r.id === p.id)!;
      const original = plan.before.rows.find(r => r.id === p.id)!;
      const fields = { ...fieldsOf(fresh) };
      for (const key of [...Object.keys(p.set), ...p.unset]) {
        const saved = slot(fieldsOf(original), key);
        if (saved.present) fields[key] = saved.value; else delete fields[key];
      }
      writeItemDirect(handle, { ...fresh, fields });
    }
    reindex(handle, plan.bundle.boardId);
    if (!same(snapshot(handle, plan.bundle.boardId, plan.dataDir).assets, current.assets) || !same(snapshot(handle, plan.bundle.boardId, plan.dataDir).files, current.files)) fail('asset post-undo guard mismatch');
    handle.sqlite.prepare("UPDATE board_migration_journal SET state='undone' WHERE operation_id=?").run(operationId);
    return { state: 'undone', repeated: false };
  });
}
