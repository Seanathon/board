import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { initDb } from './index.js';
import { boards, items, assets, type Item } from './schema.js';
import { writeItem } from './queue.js';
import { patchItemFields } from './item-actions.js';
import { applyMigration, canonicalJson, openMigrationDb, planMigration, undoMigration, verifyMigration, type MigrationBundle } from './board-migration.js';
import { runMigrationCli } from './board-migration-cli.js';

const oldDescriptor = { fields: [
  { key: 'quantity', label: 'Quantity', type: 'number', enrichable: true },
  { key: 'annotation', label: 'Annotation', type: 'text', enrichable: false },
  { key: 'earlier', label: 'Earlier', type: 'text', enrichable: true },
], enrichment_prompt: '', view: 'grid', ingest_mode: 'manual-upload' };
const nextDescriptor = { ...oldDescriptor, fields: [...oldDescriptor.fields,
  { key: 'abstract', label: 'Abstract', type: 'text', enrichable: true },
  { key: 'labels', label: 'Labels', type: 'tags', enrichable: true },
  { key: 'choice', label: 'Choice', type: 'enum', values: ['x', 'y'], enrichable: true },
] };
const ack = { offlineAcknowledged: true, backupAcknowledged: true };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'board-migration-'));
  const data = join(root, 'data'); mkdirSync(data);
  const dbPath = join(data, 'store.sqlite'), backup = join(root, 'before.json');
  const handle = initDb(dbPath);
  handle.db.insert(boards).values([
    { id: 'board-a', name: 'A', descriptor: oldDescriptor, view: 'grid', createdAt: 10, updatedAt: 20 },
    { id: 'board-z', name: 'Z', descriptor: oldDescriptor, view: 'grid' },
  ]).run();
  writeFileSync(join(data, 'asset.bin'), 'synthetic asset');
  for (const id of ['a', 'b', 'z']) await writeItem(handle, {
    id, boardId: id === 'z' ? 'board-z' : 'board-a', source: `source-${id}`, title: `Title ${id}`,
    notes: 'Original notes', favorite: 1, status: 'done', errorReason: null,
    analysisProvider: null, analysisModel: null, createdAt: 30, updatedAt: 40,
    fields: { quantity: 1, earlier: 'earlierneedle', annotation: 'User value', opaque: { kept: true } },
  }, id === 'a' ? [{ id: 'asset-a', itemId: 'a', kind: 'image', path: 'asset.bin', hash: 'metadata-hash', capturedAt: 50 }] : undefined);
  const input: MigrationBundle = { version: 1, operationId: 'op-a', boardId: 'board-a', expectedDescriptor: structuredClone(oldDescriptor), expectedView: 'grid', descriptor: structuredClone(nextDescriptor), expectedItemIds: ['a', 'b'], patches: [
    { id: 'a', expected: { source: 'source-a', title: 'Title a', fields: { quantity: { present: true, value: 1 }, abstract: { present: false } } }, set: { quantity: 2, abstract: 'currentneedle' }, unset: [] },
  ], evidence: { opaque: ['synthetic'] } };
  const plan = () => planMigration(handle, input, data);
  const apply = () => applyMigration(handle, input, data, { ...ack, digest: plan().digest, backupPath: backup });
  const row = (id = 'a') => handle.db.select().from(items).where(eq(items.id, id)).get()!;
  const raw = () => handle.sqlite.prepare('SELECT * FROM item ORDER BY id').all() as Record<string, unknown>[];
  const journalExists = () => !!handle.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name='board_migration_journal'").get();
  const cleanup = () => { handle.sqlite.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, data, dbPath, backup, handle, input, plan, apply, row, raw, journalExists, cleanup };
}
const withoutSearch = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'search_blob'));

test('dry-run opens readonly, does not bootstrap, writes no DB bytes or journal', async () => {
  const f = await fixture();
  try {
    f.handle.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const before = readFileSync(f.dbPath), h = openMigrationDb(f.dbPath);
    try { assert.equal(planMigration(h, f.input, f.data).digest, f.plan().digest); assert.throws(() => h.sqlite.exec('CREATE TABLE forbidden(x)')); }
    finally { h.sqlite.close(); }
    assert.deepEqual(readFileSync(f.dbPath), before); assert.equal(f.journalExists(), false);
    const blank = join(f.data, 'blank.sqlite'); writeFileSync(blank, '');
    const empty = openMigrationDb(blank);
    try { assert.throws(() => planMigration(empty, f.input, f.data)); assert.deepEqual(empty.sqlite.prepare('SELECT name FROM sqlite_schema').all(), []); }
    finally { empty.sqlite.close(); }
  } finally { f.cleanup(); }
});

test('apply persists private backup, preserves raw metadata/assets/other board and reindexes unpatched rows', async () => {
  const f = await fixture();
  try {
    const raw = f.raw(), assetRows = f.handle.db.select().from(assets).all();
    assert.equal((await f.apply()).repeated, false);
    assert.equal(statSync(f.backup).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(f.backup, 'utf8'));
    assert.equal(saved.plan.before.rows[0].fields.quantity, 1);
    assert.equal(f.row().fields && (f.row().fields as Record<string, unknown>).quantity, 2);
    const after = f.raw();
    assert.deepEqual(withoutSearch(after[1]), withoutSearch(raw[1]));
    assert.deepEqual(after[2], raw[2]);
    const expectedPatched = { ...raw[0], fields: after[0].fields, search_blob: after[0].search_blob };
    assert.deepEqual(after[0], expectedPatched);
    assert.deepEqual(f.handle.db.select().from(assets).all(), assetRows);
    assert.equal(readFileSync(join(f.data, 'asset.bin'), 'utf8'), 'synthetic asset');
    assert.equal(f.journalExists(), true);
    const h = openMigrationDb(f.dbPath);
    try { assert.equal(verifyMigration(h, 'op-a', f.data).state, 'applied'); } finally { h.sqlite.close(); }
  } finally { f.cleanup(); }
});

test('later curation keeps legacy and current FTS; guarded undo preserves later metadata and opaque fields', async () => {
  const f = await fixture();
  try {
    await f.apply();
    await patchItemFields(f.handle, 'a', { notes: 'laterneedle', favorite: false, annotation: 'Later curation' });
    await patchItemFields(f.handle, 'b', { notes: 'otherneedle' });
    const matches = (word: string) => f.handle.sqlite.prepare('SELECT item_id FROM item_fts WHERE item_fts MATCH ? ORDER BY item_id').all(word);
    assert.deepEqual(matches('earlierneedle'), [{ item_id: 'a' }, { item_id: 'b' }, { item_id: 'z' }]);
    assert.deepEqual(matches('currentneedle'), [{ item_id: 'a' }]); assert.deepEqual(matches('laterneedle'), [{ item_id: 'a' }]);
    const updatedAt = f.row().updatedAt;
    assert.equal((await undoMigration(f.handle, 'op-a', f.data, ack)).repeated, false);
    assert.equal(f.row().notes, 'laterneedle'); assert.equal(f.row().favorite, 0); assert.equal(f.row().updatedAt, updatedAt);
    assert.equal((f.row().fields as Record<string, unknown>).annotation, 'Later curation');
    assert.deepEqual((f.row().fields as Record<string, unknown>).opaque, { kept: true });
    assert.equal((f.row().fields as Record<string, unknown>).quantity, 1);
    assert.equal(Object.hasOwn(f.row().fields as object, 'abstract'), false);
    assert.deepEqual(matches('currentneedle'), []); assert.deepEqual(matches('laterneedle'), [{ item_id: 'a' }]);
    assert.equal((await undoMigration(f.handle, 'op-a', f.data, ack)).repeated, true);
  } finally { f.cleanup(); }
});

test('atomic failure rolls back journal DDL, descriptor, items and FTS; durable before-image remains', async () => {
  const f = await fixture();
  try {
    const before = f.raw(), descriptor = f.handle.db.select().from(boards).all(), fts = f.handle.sqlite.prepare('SELECT * FROM item_fts ORDER BY item_id').all();
    f.handle.sqlite.exec("CREATE TRIGGER abort_reindex BEFORE UPDATE ON item WHEN new.id='b' BEGIN SELECT RAISE(ABORT, 'synthetic abort'); END");
    await assert.rejects(f.apply(), /synthetic abort/);
    assert.deepEqual(f.raw(), before); assert.deepEqual(f.handle.db.select().from(boards).all(), descriptor);
    assert.deepEqual(f.handle.sqlite.prepare('SELECT * FROM item_fts ORDER BY item_id').all(), fts);
    assert.equal(f.journalExists(), false); assert.equal(statSync(f.backup).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('idempotent repeat is durable and does not revert later curation; payload reuse/undo terminality conflict', async () => {
  const f = await fixture();
  try {
    const digest = f.plan().digest;
    await f.apply(); await patchItemFields(f.handle, 'a', { notes: 'Later' });
    const h = openMigrationDb(f.dbPath, false);
    try { assert.equal((await applyMigration(h, f.input, f.data, { ...ack, digest, backupPath: f.backup })).repeated, true); } finally { h.sqlite.close(); }
    assert.equal(f.row().notes, 'Later');
    await assert.rejects(applyMigration(f.handle, { ...f.input, evidence: 'changed' }, f.data, { ...ack, digest, backupPath: f.backup }), /payload conflict/);
    await undoMigration(f.handle, 'op-a', f.data, ack);
    await assert.rejects(applyMigration(f.handle, f.input, f.data, { ...ack, digest, backupPath: f.backup }), /terminal/);
  } finally { f.cleanup(); }
});

test('missing and null slots are distinct and undo restores explicit null', async () => {
  const f = await fixture();
  try {
    const row = f.row(); await writeItem(f.handle, { ...row, fields: { ...(row.fields as object), quantity: null } });
    assert.throws(f.plan, /field guard/);
    f.input.patches[0].expected.fields.quantity = { present: true, value: null };
    await f.apply(); await undoMigration(f.handle, 'op-a', f.data, ack);
    assert.equal((f.row().fields as Record<string, unknown>).quantity, null);
  } finally { f.cleanup(); }
});

for (const kind of ['membership', 'source', 'title', 'asset-row', 'asset-file', 'curation', 'opaque'] as const) {
  test(`fresh plan digest rejects intervening ${kind} change without mutation`, async () => {
    const f = await fixture();
    try {
      const digest = f.plan().digest;
      if (kind === 'membership') f.handle.db.update(items).set({ boardId: 'board-z' }).where(eq(items.id, 'b')).run();
      if (kind === 'source') f.handle.db.update(items).set({ source: 'changed' }).where(eq(items.id, 'a')).run();
      if (kind === 'title') f.handle.db.update(items).set({ title: 'changed' }).where(eq(items.id, 'a')).run();
      if (kind === 'asset-row') f.handle.db.update(assets).set({ width: 99 }).run();
      if (kind === 'asset-file') writeFileSync(join(f.data, 'asset.bin'), 'changed');
      if (kind === 'curation') await patchItemFields(f.handle, 'b', { notes: 'changed' });
      if (kind === 'opaque') await writeItem(f.handle, { ...f.row('b'), fields: { ...(f.row('b').fields as object), opaque: 'changed' } });
      const before = f.raw();
      await assert.rejects(applyMigration(f.handle, f.input, f.data, { ...ack, digest, backupPath: f.backup }));
      assert.deepEqual(f.raw(), before); assert.equal(f.journalExists(), false);
    } finally { f.cleanup(); }
  });
}

for (const kind of ['touched', 'descriptor', 'membership', 'asset-file', 'asset-row', 'backup'] as const) {
  test(`verify and undo fail closed on ${kind} drift`, async () => {
    const f = await fixture();
    try {
      await f.apply();
      if (kind === 'touched') await writeItem(f.handle, { ...f.row(), fields: { ...(f.row().fields as object), quantity: 3 } });
      if (kind === 'descriptor') f.handle.db.update(boards).set({ view: 'list' }).where(eq(boards.id, 'board-a')).run();
      if (kind === 'membership') f.handle.db.update(items).set({ boardId: 'board-z' }).where(eq(items.id, 'b')).run();
      if (kind === 'asset-file') writeFileSync(join(f.data, 'asset.bin'), 'changed');
      if (kind === 'asset-row') f.handle.db.update(assets).set({ hash: 'changed' }).run();
      if (kind === 'backup') chmodSync(f.backup, 0o644);
      const before = f.raw(); assert.throws(() => verifyMigration(f.handle, 'op-a', f.data));
      await assert.rejects(undoMigration(f.handle, 'op-a', f.data, ack)); assert.deepEqual(f.raw(), before);
    } finally { f.cleanup(); }
  });
}

for (const [key, value] of [['quantity', 'not-number'], ['labels', 'not-array'], ['choice', 'invalid'], ['abstract', {}]] as const) {
  test(`strict partial patch rejects invalid ${key} value`, async () => {
    const f = await fixture();
    try { f.input.patches[0].set = { [key]: value }; f.input.patches[0].expected.fields[key] = { present: false }; assert.throws(f.plan, /typed patch/); }
    finally { f.cleanup(); }
  });
}

test('partial patches do not require all enrichable fields', async () => {
  const f = await fixture(); try { await f.apply(); assert.equal(Object.hasOwn(f.row().fields as object, 'choice'), false); } finally { f.cleanup(); }
});

test('protected declarations, opaque values, URL/image and hostile/system keys rejected', async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.input);
    for (const key of ['annotation', 'opaque', 'notes', 'id', 'meta.__proto__', 'constructor', 'url', 'screenshot']) {
      const value = structuredClone(original); value.patches[0].set = { [key]: 'changed' }; value.patches[0].expected.fields[key] = { present: false };
      assert.throws(() => planMigration(f.handle, value, f.data));
    }
    for (const type of ['url', 'image']) {
      const value = structuredClone(original); (value.descriptor as typeof nextDescriptor).fields.push({ key: 'asset_reference', label: 'Reference', type, enrichable: true });
      value.patches[0].set = { asset_reference: 'value' }; value.patches[0].expected.fields.asset_reference = { present: false };
      assert.throws(() => planMigration(f.handle, value, f.data), /protected/);
    }
    const claimed = structuredClone(original); (claimed.descriptor as typeof nextDescriptor).fields.push({ key: 'opaque', label: 'Opaque', type: 'text', enrichable: true });
    claimed.patches[0].set = { opaque: 'changed' }; claimed.patches[0].expected.fields.opaque = { present: true, value: { kept: true } };
    assert.throws(() => planMigration(f.handle, claimed, f.data), /opaque/);
    const removed = structuredClone(original); (removed.descriptor as typeof nextDescriptor).fields = (removed.descriptor as typeof nextDescriptor).fields.filter(f => f.key !== 'annotation');
    assert.throws(() => planMigration(f.handle, removed, f.data), /protected/);
    assert.throws(() => canonicalJson(JSON.parse('{"__proto__":{}}')), /hostile/);
  } finally { f.cleanup(); }
});

test('offline/backup gates, outside-data-dir backup and no overwrite', async () => {
  const f = await fixture();
  try {
    const digest = f.plan().digest;
    await assert.rejects(applyMigration(f.handle, f.input, f.data, { ...ack, offlineAcknowledged: false, digest, backupPath: f.backup }), /acknowledgments/);
    await assert.rejects(applyMigration(f.handle, f.input, f.data, { ...ack, digest, backupPath: join(f.data, 'backup.json') }), /outside/);
    writeFileSync(f.backup, 'existing');
    await assert.rejects(applyMigration(f.handle, f.input, f.data, { ...ack, digest, backupPath: f.backup }));
    assert.equal(readFileSync(f.backup, 'utf8'), 'existing'); assert.equal(f.journalExists(), false);
  } finally { f.cleanup(); }
});

test('unsupported/duplicate CLI flags rejected before opening any database', async () => {
  await assert.rejects(runMigrationCli(['dry-run', '--force']), /unsupported/);
  await assert.rejects(runMigrationCli(['verify', '--bundle', '/not-used']), /unsupported/);
  await assert.rejects(runMigrationCli(['dry-run', '--db', '/not-used', '--db', '/not-used']), /duplicate/);
  await assert.rejects(runMigrationCli(['apply', '--db', 'relative']), /absolute/);
  const child = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'board-migration-cli.ts'), 'dry-run', '--force'], { encoding: 'utf8' });
  assert.equal(child.status, 1); assert.match(child.stderr, /Migration refused/); assert.doesNotMatch(child.stderr, /not-used|stack|node_modules/);
});

test('descriptor removal reindexes every target row without changing any unpatched raw metadata', async () => {
  const f = await fixture();
  try {
    (f.input.descriptor as typeof nextDescriptor).fields = (f.input.descriptor as typeof nextDescriptor).fields.filter(field => field.key !== 'earlier');
    const before = f.raw(); await f.apply();
    assert.deepEqual(withoutSearch(f.raw()[1]), withoutSearch(before[1]));
    const matches = () => f.handle.sqlite.prepare("SELECT item_id FROM item_fts WHERE item_fts MATCH 'earlierneedle' ORDER BY item_id").all();
    assert.deepEqual(matches(), [{ item_id: 'z' }]);
    await patchItemFields(f.handle, 'b', { notes: 'Later' }); assert.deepEqual(matches(), [{ item_id: 'z' }]);
    await undoMigration(f.handle, 'op-a', f.data, ack);
    assert.deepEqual(matches(), [{ item_id: 'a' }, { item_id: 'b' }, { item_id: 'z' }]);
    assert.equal((f.row('b').fields as Record<string, unknown>).earlier, 'earlierneedle');
    assert.equal(f.row('b').notes, 'Later');
  } finally { f.cleanup(); }
});

test('unset is guarded and undo restores its before-slot; later unrelated enrichment is retained', async () => {
  const f = await fixture();
  try {
    f.input.patches[0].set = { abstract: 'currentneedle' };
    f.input.patches[0].unset = ['quantity'];
    await f.apply(); assert.equal(Object.hasOwn(f.row().fields as object, 'quantity'), false);
    await writeItem(f.handle, { ...f.row(), title: 'Later title', fields: { ...(f.row().fields as object), earlier: 'Later read' } });
    await undoMigration(f.handle, 'op-a', f.data, ack);
    assert.equal((f.row().fields as Record<string, unknown>).quantity, 1);
    assert.equal((f.row().fields as Record<string, unknown>).earlier, 'Later read'); assert.equal(f.row().title, 'Later title');
    await writeItem(f.handle, { ...f.row(), fields: { ...(f.row().fields as object), quantity: 99 } });
    assert.equal((await undoMigration(f.handle, 'op-a', f.data, ack)).repeated, true);
    assert.equal((f.row().fields as Record<string, unknown>).quantity, 99);
  } finally { f.cleanup(); }
});

test('duplicate IDs/keys, unexpected properties, missing/foreign members and ownership flips fail closed', async () => {
  const f = await fixture();
  try {
    for (const alter of [
      (b: MigrationBundle) => { b.expectedItemIds.push('a'); },
      (b: MigrationBundle) => { b.patches.push(structuredClone(b.patches[0])); },
      (b: MigrationBundle) => { b.patches[0].unset = ['quantity']; },
      (b: MigrationBundle) => { b.expectedItemIds.push('missing'); },
      (b: MigrationBundle) => { b.patches[0].id = 'z'; },
      (b: MigrationBundle) => { (b.patches[0] as object as Record<string, unknown>).title = 'forbidden'; },
      (b: MigrationBundle) => { (b.descriptor as typeof nextDescriptor).fields.find(f => f.key === 'quantity')!.enrichable = false; },
    ]) {
      const value = structuredClone(f.input); alter(value); assert.throws(() => planMigration(f.handle, value, f.data));
    }
    assert.equal(f.journalExists(), false);
  } finally { f.cleanup(); }
});

test('new declarations cannot claim opaque values on unpatched retained rows', async () => {
  const f = await fixture();
  try {
    await writeItem(f.handle, { ...f.row('b'), fields: { ...(f.row('b').fields as object), abstract: null } });
    assert.throws(f.plan, /opaque/);
  } finally { f.cleanup(); }
});

test('verify missing operation is readonly and does not create journal', async () => {
  const f = await fixture();
  try {
    const h = openMigrationDb(f.dbPath);
    try { assert.throws(() => verifyMigration(h, 'absent', f.data), /missing/); } finally { h.sqlite.close(); }
    assert.equal(f.journalExists(), false);
  } finally { f.cleanup(); }
});

test('asset path traversal and symlink outside data directory are refused', async () => {
  const f = await fixture();
  try {
    f.handle.db.update(assets).set({ path: '../before.json' }).run(); writeFileSync(f.backup, 'outside');
    assert.throws(f.plan, /outside/);
  } finally { f.cleanup(); }
});

test('retired old-owned enrichable text can be unset and restored with descriptor and FTS', async () => {
  const f = await fixture();
  try {
    (f.input.descriptor as typeof nextDescriptor).fields = (f.input.descriptor as typeof nextDescriptor).fields.filter(field => field.key !== 'earlier');
    f.input.patches[0].unset = ['earlier'];
    f.input.patches[0].expected.fields.earlier = { present: true, value: 'earlierneedle' };
    await f.apply();
    assert.equal(Object.hasOwn(f.row().fields as object, 'earlier'), false);
    assert.equal(verifyMigration(f.handle, 'op-a', f.data).state, 'applied');
    await undoMigration(f.handle, 'op-a', f.data, ack);
    assert.equal((f.row().fields as Record<string, unknown>).earlier, 'earlierneedle');
    assert.deepEqual(f.handle.db.select().from(boards).where(eq(boards.id, 'board-a')).get()!.descriptor, oldDescriptor);
    assert.deepEqual(f.handle.sqlite.prepare("SELECT item_id FROM item_fts WHERE item_fts MATCH 'earlierneedle' ORDER BY item_id").all(), [{ item_id: 'a' }, { item_id: 'b' }, { item_id: 'z' }]);
  } finally { f.cleanup(); }
});

test('retirement unset still rejects manual, opaque, URL and image ownership', async () => {
  const f = await fixture();
  try {
    for (const key of ['annotation', 'opaque']) {
      const input = structuredClone(f.input); input.patches[0].unset = [key];
      input.patches[0].expected.fields[key] = { present: true, value: key === 'annotation' ? 'User value' : { kept: true } };
      assert.throws(() => planMigration(f.handle, input, f.data), /protected patch field/);
    }
    for (const type of ['url', 'image']) {
      const input = structuredClone(f.input);
      (input.expectedDescriptor as typeof oldDescriptor).fields.push({ key: 'retired_asset', label: 'Retired asset', type, enrichable: true });
      input.patches[0].unset = ['retired_asset']; input.patches[0].expected.fields.retired_asset = { present: false };
      assert.throws(() => planMigration(f.handle, input, f.data), /protected patch field/);
    }
  } finally { f.cleanup(); }
});

test('new target membership makes verify and undo refuse without changing descriptor or rows', async () => {
  const f = await fixture();
  try {
    await f.apply();
    await writeItem(f.handle, { id: 'new-member', boardId: 'board-a', title: 'Later member', status: 'done' });
    const before = f.raw(), board = f.handle.db.select().from(boards).all();
    assert.throws(() => verifyMigration(f.handle, 'op-a', f.data), /membership/);
    await assert.rejects(undoMigration(f.handle, 'op-a', f.data, ack), /membership/);
    assert.deepEqual(f.raw(), before); assert.deepEqual(f.handle.db.select().from(boards).all(), board);
    assert.deepEqual(f.handle.sqlite.prepare('SELECT state FROM board_migration_journal').all(), [{ state: 'applied' }]);
  } finally { f.cleanup(); }
});

test('omitted CLI command defaults to readonly dry-run', async () => {
  const f = await fixture();
  try {
    const inputPath = join(f.root, 'input.json'); writeFileSync(inputPath, JSON.stringify(f.input));
    const before = f.raw();
    const child = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'board-migration-cli.ts'), '--db', f.dbPath, '--data-dir', f.data, '--bundle', inputPath], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { state: 'planned', digest: f.plan().digest, items: 2, patches: 1 });
    assert.deepEqual(f.raw(), before); assert.equal(f.journalExists(), false);
  } finally { f.cleanup(); }
});

test('undo exactly restores independent board view when it differs from descriptor view', async () => {
  const f = await fixture();
  try {
    f.handle.db.update(boards).set({ view: 'list' }).where(eq(boards.id, 'board-a')).run();
    f.input.expectedView = 'list';
    const before = f.handle.db.select().from(boards).where(eq(boards.id, 'board-a')).get()!;
    await f.apply();
    await undoMigration(f.handle, 'op-a', f.data, ack);
    assert.deepEqual(f.handle.db.select().from(boards).where(eq(boards.id, 'board-a')).get(), before);
    assert.equal(verifyMigration(f.handle, 'op-a', f.data).state, 'undone');
  } finally { f.cleanup(); }
});
