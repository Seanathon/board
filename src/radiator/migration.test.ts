import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { initDb, type DbHandle } from '../db/index.js';
import { boards, items, assets } from '../db/schema.js';
import { writeItemDirect } from '../db/queue.js';
import { seedRadiatorFixture } from './fixture.js';
import { boardGuard, digest, INTEL_DESCRIPTOR, PINNED_BASELINE, EXECUTION_RULES } from './profile.js';
import { RADIATOR_BOARD_ID, RADIATOR_MODEL_ID, RADIATOR_RECEIPT_KEY, RADIATOR_SCHEMA_VERSION, RADIATOR_PROMPT_VERSION } from './contract.js';
import { currentMigrationRecord, migrationRecordSha256, migrationAssetShape, migrationAssetFileSha256, type PreparedMigration } from './migration-contract.js';
import { assertPreparedMigration, sealPreparedMigration } from './migration-input.js';
import { applyMigration, dryRunMigration, verifyMigration, undoMigration } from './migration.js';

const id = (n: number) => `synthetic-${String(n).padStart(3, '0')}`;
const row = (h: DbHandle, n = 0) => h.db.select().from(items).where(eq(items.id, id(n))).get()!;
const board = (h: DbHandle) => h.db.select().from(boards).where(eq(boards.id, RADIATOR_BOARD_ID)).get()!;
const dump = (h: DbHandle) => JSON.stringify({ schema: h.sqlite.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), boards: h.db.select().from(boards).all(), items: h.db.select().from(items).all(), assets: h.db.select().from(assets).all(), settings: h.sqlite.prepare('SELECT * FROM setting').all(), fts: h.sqlite.prepare('SELECT * FROM item_fts ORDER BY item_id').all() });

// Deliberately synthetic test provenance. Never use this fixture as approved evidence.
function syntheticFields(itemId: string, source: string): Record<string, unknown> {
  const fields: Record<string, unknown> = Object.fromEntries(INTEL_DESCRIPTOR.fields.filter(f => f.enrichable).map(f => [f.key,
    f.key === 'intel_v1.relevance' ? 'direct-competitor' : f.key === 'intel_v1.subject' ? 'Synthetic fixture' : f.key === 'intel_v1.implication' ? 'Analyst inference: test atomic migration only [T1].' : 'Synthetic fixture demonstrates engineering review [T1, R1].']));
  return { ...fields,
    'intel_v1.primary_source': source, 'intel_v1.reviewed_on': '2026-11-13', 'intel_v1.schema_version': RADIATOR_SCHEMA_VERSION,
    'intel_v1.prompt_version': RADIATOR_PROMPT_VERSION, 'intel_v1.baseline': digest(PINNED_BASELINE),
    [RADIATOR_RECEIPT_KEY]: { version: 1, kind: 'approved-local-migration', validationProfile: 'radiator-approved-local-run/1', approvedBundleSha256: digest('synthetic-bundle'), approvedSelectionSha256: digest('synthetic-selection'), itemId, boardId: RADIATOR_BOARD_ID, runtimeVersion: 'radiator-runtime/1', source, modelId: RADIATOR_MODEL_ID,
      sessionId: '00000000-0000-4000-8000-000000000000', schemaVersion: RADIATOR_SCHEMA_VERSION, promptVersion: RADIATOR_PROMPT_VERSION,
      baselineSha256: digest(PINNED_BASELINE), schemaSha256: digest(INTEL_DESCRIPTOR), rulesSha256: digest(EXECUTION_RULES),
      promptSha256: digest('synthetic-prompt'), responseSha256: digest('synthetic-response'), reviewedOn: '2026-11-13',
      sources: [{ id: 'T1', url: source, title: 'Synthetic fixture', retrievedOn: '2026-11-13', text: 'Synthetic engineering review fixture. '.repeat(20), rawSha256: digest('synthetic-source'), excerptSha256: digest('synthetic-source'), fullTextChars: 740, truncated: false }],
      usage: { input_tokens: 100, output_tokens: 100 }, elapsedMs: 1, accountAuth: 'owner-confirmed-subscription-route', noApiFallback: true },
  };
}
function seal(input: PreparedMigration): PreparedMigration {
  const { runId: _runId, inputSha256: _hash, ...body } = input;
  return structuredClone(sealPreparedMigration(body));
}
function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'radiator-migration-synthetic-'));
  const dataDir = path.join(root, 'data'); const backupDir = path.join(root, 'backup');
  mkdirSync(dataDir); mkdirSync(backupDir);
  const handle = initDb(path.join(dataDir, 'board.db'));
  t.after(() => { if (handle.sqlite.open) handle.sqlite.close(); rmSync(root, { recursive: true, force: true }); });
  seedRadiatorFixture(handle);
  handle.db.insert(boards).values({ id: 'unrelated-fixture', name: 'Unrelated', view: 'grid', descriptor: board(handle).descriptor }).run();
  handle.sqlite.transaction(() => {
    for (let n = 0; n < 119; n++) writeItemDirect(handle, { id: id(n), boardId: RADIATOR_BOARD_ID, source: `https://synthetic.example/${n === 1 ? 0 : n}`, title: `Synthetic ${n}`, status: 'done', notes: 'Original note', favorite: 1, analysisProvider: 'old-provider', analysisModel: 'old-model', fields: { tier: 'reference', steal_this: 'Old generated analysis', aesthetic_tags: ['original'], tone: ['quiet'], my_notes: 'Manual field', opaque: { keep: true } } });
    writeItemDirect(handle, { id: 'unrelated-item', boardId: 'unrelated-fixture', source: 'https://unrelated.example/', fields: { keep: 'untouched' } });
  })();
  writeFileSync(path.join(dataDir, 'fixture.png'), 'synthetic asset bytes');
  handle.db.insert(assets).values({ id: 'synthetic-asset', itemId: id(0), kind: 'screenshot', path: 'fixture.png' }).run();
  const beforeBoard = board(handle);
  const prepared = seal({ format: 'board-radiator-prepared-migration/1', runId: '', inputSha256: '', boardId: RADIATOR_BOARD_ID,
    expectedBoard: { id: beforeBoard.id, name: beforeBoard.name, view: beforeBoard.view, descriptor: beforeBoard.descriptor }, expectedBoardSha256: boardGuard(beforeBoard),
    fingerprints: { selection: digest('synthetic-selection'), bundle: digest('synthetic-bundle'), baseline: digest(PINNED_BASELINE), schema: digest(INTEL_DESCRIPTOR), archive: digest('synthetic-archive') },
    items: Array.from({ length: 119 }, (_, n) => {
      const current = row(handle, n); const shots = handle.db.select().from(assets).where(eq(assets.itemId, current.id)).all();
      const expectedRecord = currentMigrationRecord(current, shots);
      return { id: current.id, source: current.source!, disposition: n < 114 ? 'eligible' : 'retained', expectedRecord, expectedRecordSha256: migrationRecordSha256(expectedRecord),
        expectedAssets: shots.map(a => ({ ...migrationAssetShape(a), fileSha256: migrationAssetFileSha256(dataDir, a.path) })),
        deleteKeys: n < 114 ? ['tier', 'steal_this'] : [], setFields: n < 114 ? syntheticFields(current.id, current.source!) : {} };
    }),
  });
  assertPreparedMigration(prepared);
  const plan = () => dryRunMigration(handle, prepared, { dataDir });
  const apply = (planDigest = plan().planDigest) => applyMigration(handle, prepared, { dataDir, backupDir, planDigest });
  const verify = () => verifyMigration(handle, { dataDir, runId: prepared.runId });
  const undo = () => undoMigration(handle, { dataDir, runId: prepared.runId });
  return { handle, prepared, dataDir, backupDir, plan, apply, verify, undo };
}

test('synthetic migration: dry-run is read-only, 114/5 apply/verify/undo, duplicate URLs remain distinct', async t => {
  const f = setup(t); const before = dump(f.handle);
  const retained = Array.from({ length: 5 }, (_, n) => row(f.handle, 114 + n));
  const other = f.handle.db.select().from(items).where(eq(items.id, 'unrelated-item')).get();
  const files = readdirSync(f.dataDir); const hashes = files.map(name => digest(readFileSync(path.join(f.dataDir, name)).toString('base64')));
  const plan = f.plan(); assert.deepEqual(plan.conflicts, []); assert.equal(plan.eligible, 114); assert.equal(plan.retained, 5);
  assert.equal(dump(f.handle), before); assert.deepEqual(readdirSync(f.dataDir), files); assert.deepEqual(files.map(name => digest(readFileSync(path.join(f.dataDir, name)).toString('base64'))), hashes); assert.deepEqual(readdirSync(f.backupDir), []);
  await f.apply(plan.planDigest); assert.equal(f.verify().ok, true);
  assert.deepEqual(Array.from({ length: 5 }, (_, n) => row(f.handle, 114 + n)), retained);
  assert.deepEqual(f.handle.db.select().from(items).where(eq(items.id, 'unrelated-item')).get(), other);
  assert.equal(row(f.handle, 0).source, row(f.handle, 1).source); assert.notEqual(row(f.handle, 0).id, row(f.handle, 1).id);
  assert.equal(row(f.handle).analysisModel, RADIATOR_MODEL_ID); assert.equal((row(f.handle).fields as any).tier, undefined);
  assert.equal(readdirSync(f.backupDir).filter(n => n.endsWith('.json')).length, 1);
  const after = dump(f.handle); assert.equal((await f.apply(plan.planDigest)).alreadyApplied, true); assert.equal(dump(f.handle), after);
  await f.undo(); assert.equal(f.verify().state, 'undone'); assert.equal(f.verify().ok, true);
  assert.equal((row(f.handle).fields as any).tier, 'reference'); assert.equal(row(f.handle).analysisModel, 'old-model');
  const undone = dump(f.handle); assert.equal((await f.undo()).alreadyUndone, true); assert.equal(dump(f.handle), undone);
  await assert.rejects(f.apply(plan.planDigest), /undone/);
});

test('synthetic migration: stale item/note/descriptor/membership/assets fail closed', async t => {
  const mutations: [string, (f: ReturnType<typeof setup>) => void][] = [
    ['notes', f => f.handle.db.update(items).set({ notes: 'New note' }).where(eq(items.id, id(0))).run()],
    ['field', f => f.handle.db.update(items).set({ fields: { ...(row(f.handle).fields as any), opaque: 'changed' } }).where(eq(items.id, id(0))).run()],
    ['descriptor', f => f.handle.db.update(boards).set({ descriptor: { ...(board(f.handle).descriptor as any), archive_on_promote: true } }).where(eq(boards.id, RADIATOR_BOARD_ID)).run()],
    ['moved', f => f.handle.db.update(items).set({ boardId: 'unrelated-fixture' }).where(eq(items.id, id(1))).run()],
    ['deleted', f => f.handle.db.delete(items).where(eq(items.id, id(1))).run()],
    ['added', f => writeItemDirect(f.handle, { id: 'added', boardId: RADIATOR_BOARD_ID })],
    ['missing asset', f => rmSync(path.join(f.dataDir, 'fixture.png'))],
    ['changed asset', f => writeFileSync(path.join(f.dataDir, 'fixture.png'), 'changed bytes')],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async t => {
    const f = setup(t); const plan = f.plan(); mutate(f); const before = dump(f.handle);
    assert.ok(f.plan().conflicts.length); await assert.rejects(f.apply(plan.planDigest), /conflicts/); assert.equal(dump(f.handle), before); assert.deepEqual(readdirSync(f.backupDir), []);
  });
  await t.test('lifecycle-only stale exact plan', async t => {
    const f = setup(t); const plan = f.plan(); f.handle.db.update(items).set({ updatedAt: 42 }).where(eq(items.id, id(0))).run();
    assert.equal(f.plan().conflicts.length, 0); await assert.rejects(f.apply(plan.planDigest), /Stale/);
  });
});

test('synthetic migration: injected mid-transaction failure rolls back ledger, config, items and FTS; repeat succeeds', async t => {
  const f = setup(t);
  f.handle.sqlite.exec(`CREATE TRIGGER fail_migration BEFORE UPDATE ON item WHEN NEW.id='synthetic-057' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
  const before = dump(f.handle); const plan = f.plan();
  await assert.rejects(f.apply(plan.planDigest), /injected migration failure/);
  assert.equal(dump(f.handle), before); assert.equal(readdirSync(f.backupDir).filter(n => n.endsWith('.json')).length, 1);
  f.handle.sqlite.exec('DROP TRIGGER fail_migration');
  await f.apply(plan.planDigest); assert.equal(f.verify().ok, true);
});

test('synthetic migration: undo preserves later curation and unowned descriptor flags', async t => {
  const f = setup(t); await f.apply();
  const current = row(f.handle);
  writeItemDirect(f.handle, { ...current, notes: 'Later note', title: 'Later title', favorite: 0, fields: { ...(current.fields as any), aesthetic_tags: ['later'], tone: ['bold'], my_notes: 'Later manual', opaque: { later: true } } });
  f.handle.db.update(boards).set({ descriptor: { ...(board(f.handle).descriptor as any), archive_on_promote: true } }).where(eq(boards.id, RADIATOR_BOARD_ID)).run();
  await f.undo(); const undone = row(f.handle);
  assert.equal(undone.notes, 'Later note'); assert.equal(undone.title, 'Later title'); assert.equal(undone.favorite, 0);
  assert.deepEqual((undone.fields as any).aesthetic_tags, ['later']); assert.deepEqual((undone.fields as any).tone, ['bold']); assert.deepEqual((undone.fields as any).opaque, { later: true });
  assert.equal((undone.fields as any).my_notes, 'Later manual'); assert.equal((board(f.handle).descriptor as any).archive_on_promote, true);
  assert.equal(f.verify().ok, true);
});

test('synthetic migration: undo rejects all owned-value and membership conflicts atomically', async t => {
  const mutations: [string, (f: ReturnType<typeof setup>) => void][] = [
    ['later AI', f => writeItemDirect(f.handle, { ...row(f.handle), fields: { ...(row(f.handle).fields as any), 'intel_v1.job': 'Later AI' } })],
    ['later retained AI', f => writeItemDirect(f.handle, { ...row(f.handle, 118), fields: { ...(row(f.handle, 118).fields as any), steal_this: 'Later retained AI' } })],
    ['model column', f => f.handle.db.update(items).set({ analysisModel: 'later-model' }).where(eq(items.id, id(0))).run()],
    ['new metadata', f => writeItemDirect(f.handle, { ...row(f.handle), fields: { ...(row(f.handle).fields as any), 'radiator_meta.state': { status: 'researching' } } })],
    ['moved', f => f.handle.db.update(items).set({ boardId: 'unrelated-fixture' }).where(eq(items.id, id(1))).run()],
    ['deleted', f => f.handle.db.delete(items).where(eq(items.id, id(1))).run()],
    ['added', f => writeItemDirect(f.handle, { id: 'added', boardId: RADIATOR_BOARD_ID })],
    ['descriptor prompt', f => f.handle.db.update(boards).set({ descriptor: { ...(board(f.handle).descriptor as any), enrichment_prompt: 'Later prompt' } }).where(eq(boards.id, RADIATOR_BOARD_ID)).run()],
    ['profile', f => f.handle.sqlite.prepare("UPDATE setting SET value='{}' WHERE key='radiator.intelligence.profile'").run()],
    ['before-image missing', f => rmSync(path.join(f.backupDir, readdirSync(f.backupDir)[0]))],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async t => {
    const f = setup(t); await f.apply(); mutate(f); const before = dump(f.handle);
    assert.equal(f.verify().ok, false); await assert.rejects(f.undo(), /conflicts/); assert.equal(dump(f.handle), before);
  });
});

test('synthetic migration: invalid hash, field write and provenance rejected at plan/apply boundaries', async t => {
  const f = setup(t); const valid = structuredClone(f.prepared); const before = dump(f.handle);
  for (const mutate of [
    (p: PreparedMigration) => { p.inputSha256 = '0'.repeat(64); },
    (p: PreparedMigration) => { p.items.pop(); Object.assign(p, seal(p)); },
    (p: PreparedMigration) => { p.items[0].setFields.notes = 'overwrite'; Object.assign(p, seal(p)); },
    (p: PreparedMigration) => { delete p.items[0].setFields[RADIATOR_RECEIPT_KEY]; Object.assign(p, seal(p)); },
    (p: PreparedMigration) => { (p.items[0].setFields[RADIATOR_RECEIPT_KEY] as any).modelId = 'wrong'; Object.assign(p, seal(p)); },
  ]) {
    const invalid = structuredClone(valid); mutate(invalid);
    assert.throws(() => dryRunMigration(f.handle, invalid, { dataDir: f.dataDir }));
    await assert.rejects(applyMigration(f.handle, invalid, { dataDir: f.dataDir, backupDir: f.backupDir, planDigest: '0'.repeat(64) }));
    assert.equal(dump(f.handle), before);
  }
});


test('synthetic migration: committed run is discoverable on a fresh read-only connection and explicit CLI', async t => {
  const f = setup(t); const plan = f.plan(); await f.apply(plan.planDigest);
  const sqlite = new Database(path.join(f.dataDir, 'board.db'), { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma('query_only = ON');
    assert.equal(verifyMigration({ sqlite, db: drizzle(sqlite, { schema }) }, { runId: f.prepared.runId, dataDir: f.dataDir }).ok, true);
  } finally { sqlite.close(); }
  const before = dump(f.handle);
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/radiator-migrate.ts', ...args], { encoding: 'utf8', cwd: process.cwd() });
  const result = run('verify', '--target', RADIATOR_BOARD_ID, '--db', path.join(f.dataDir, 'board.db'), '--data-dir', f.dataDir, '--run-id', f.prepared.runId);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(dump(f.handle), before);
  const missing = path.join(f.dataDir, 'does-not-exist.db');
  const denied = run('--target', RADIATOR_BOARD_ID, '--db', missing, '--data-dir', f.dataDir);
  assert.equal(denied.status, 1); assert.ok(!readdirSync(f.dataDir).includes('does-not-exist.db'));
  const force = run('undo', '--target', RADIATOR_BOARD_ID, '--db', path.join(f.dataDir, 'board.db'), '--data-dir', f.dataDir, '--run-id', f.prepared.runId, '--force');
  assert.equal(force.status, 1); assert.equal(dump(f.handle), before);
});


test('synthetic migration: added member reports membership conflict without inspecting unowned keys', async t => {
  const f = setup(t); await f.apply();
  writeItemDirect(f.handle, { id: 'new-after-apply', boardId: RADIATOR_BOARD_ID, status: 'done' });
  const before = dump(f.handle); const verification = f.verify();
  assert.equal(verification.ok, false);
  assert.ok(verification.conflicts.some(c => c.code === 'membership-changed'));
  await assert.rejects(f.undo(), /membership-changed/);
  assert.equal(dump(f.handle), before);
});

test('synthetic migration: selected pending/processing jobs block plan/apply/verify/undo', async t => {
  for (const status of ['pending', 'processing']) await t.test(status, async t => {
    const f = setup(t); const plan = f.plan();
    f.handle.db.update(items).set({ status }).where(eq(items.id, id(118))).run();
    const before = dump(f.handle);
    assert.ok(f.plan().conflicts.some(c => c.code === 'item-in-flight' && c.id === id(118)));
    await assert.rejects(f.apply(plan.planDigest), /item-in-flight/); assert.equal(dump(f.handle), before);
    f.handle.db.update(items).set({ status: 'done' }).where(eq(items.id, id(118))).run();
    await f.apply();
    f.handle.db.update(items).set({ status }).where(eq(items.id, id(0))).run();
    const applied = dump(f.handle);
    assert.ok(f.verify().conflicts.some(c => c.code === 'item-in-flight' && c.id === id(0)));
    await assert.rejects(f.undo(), /item-in-flight/); assert.equal(dump(f.handle), applied);
  });
});

test('synthetic migration: before-image file, directory and parent sync precede every retirement; parent-sync failure rolls back', async t => {
  for (const failParent of [false, true]) await t.test(failParent ? 'parent fsync failure' : 'durable ordering', async t => {
    const f = setup(t); const before = dump(f.handle); const synced: string[] = [];
    const backupDir = fs.realpathSync(f.backupDir); const parentDir = path.dirname(backupDir);
    const descriptors = new Map<number, string>();
    const originalOpen = fs.openSync; const originalSync = fs.fsyncSync;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args); descriptors.set(fd, String(args[0])); return fd;
    }) as typeof fs.openSync;
    fs.fsyncSync = (fd: number) => {
      const name = descriptors.get(fd)!;
      if (failParent && name === parentDir) throw new Error('injected parent fsync failure');
      originalSync(fd); synced.push(name);
    };
    syncBuiltinESMExports();
    let writes = 0;
    f.handle.sqlite.function('check_durable_before_retirement', () => {
      const parent = synced.indexOf(parentDir);
      const directory = synced.indexOf(backupDir);
      const file = synced.findIndex(name => name.startsWith(backupDir + path.sep) && name.endsWith('.json'));
      assert.ok(file >= 0 && directory > file && parent > directory, JSON.stringify(synced));
      writes++; return 1;
    });
    f.handle.sqlite.exec('CREATE TEMP TRIGGER check_migration_durable BEFORE UPDATE ON item BEGIN SELECT check_durable_before_retirement(); END');
    try {
      if (failParent) {
        await assert.rejects(f.apply(), /injected parent fsync failure/);
        assert.equal(writes, 0); assert.equal(dump(f.handle), before);
      } else { await f.apply(); assert.equal(writes, 114); assert.equal(f.verify().ok, true); }
    } finally { fs.openSync = originalOpen; fs.fsyncSync = originalSync; syncBuiltinESMExports(); }
  });
});


test('synthetic migration: approved candidates, fresh eligibility and all-or-nothing execution are distinct', async t => {
  const scenarios: [string, (f: ReturnType<typeof setup>) => void, Partial<ReturnType<ReturnType<typeof setup>['plan']>>][] = [
    ['note edited', f => f.handle.db.update(items).set({ notes: 'Fresh edit' }).where(eq(items.id, id(0))).run(), { eligible: 113, conflictedSelected: 1, added: 0, deleted: 0, moved: 0 }],
    ['deleted', f => f.handle.db.delete(items).where(eq(items.id, id(1))).run(), { eligible: 113, conflictedSelected: 1, deleted: 1, added: 0, moved: 0 }],
    ['moved', f => f.handle.db.update(items).set({ boardId: 'unrelated-fixture' }).where(eq(items.id, id(1))).run(), { eligible: 113, conflictedSelected: 1, moved: 1, added: 0, deleted: 0 }],
    ['added', f => writeItemDirect(f.handle, { id: 'new-counted-member', boardId: RADIATOR_BOARD_ID, status: 'done' }), { eligible: 114, conflictedSelected: 0, added: 1, deleted: 0, moved: 0 }],
    ['asset missing', f => rmSync(path.join(f.dataDir, 'fixture.png')), { eligible: 113, conflictedSelected: 1 }],
    ['global descriptor', f => f.handle.db.update(boards).set({ name: 'Changed board' }).where(eq(boards.id, RADIATOR_BOARD_ID)).run(), { eligible: 0, conflictedSelected: 119 }],
    ['retained note', f => f.handle.db.update(items).set({ notes: 'Fresh retained edit' }).where(eq(items.id, id(118))).run(), { eligible: 114, conflictedSelected: 1 }],
  ];
  for (const [name, mutate, expected] of scenarios) await t.test(name, t => {
    const f = setup(t); const clean = f.plan();
    assert.equal(clean.approvedEligible, 114); assert.equal(clean.eligible, 114); assert.equal(clean.executableChanges, 114);
    mutate(f); const before = dump(f.handle); const plan = f.plan();
    assert.equal(plan.approvedEligible, 114); assert.equal(plan.retained, 5); assert.equal(plan.executableChanges, 0);
    for (const [key, value] of Object.entries(expected)) assert.equal(plan[key as keyof typeof plan], value, key);
    assert.equal(dump(f.handle), before);
  });
  await t.test('optional retained outcome accounting', t => {
    const f = setup(t); const input = structuredClone(f.prepared);
    for (const [n, entry] of input.items.filter(i => i.disposition === 'retained').entries()) entry.retentionReason = n < 4 ? 'blocked-evidence' : 'invalid-output';
    const plan = dryRunMigration(f.handle, seal(input), { dataDir: f.dataDir });
    assert.deepEqual(plan.retentionReasons, { blockedEvidence: 4, invalidOutput: 1, unspecified: 0 });
    assert.equal(plan.eligible, 114); assert.equal(plan.executableChanges, 114);
  });
});

test('synthetic migration: abrupt child exit mid-batch leaves zero committed migration and resumes cleanly', async t => {
  const f = setup(t); const plan = f.plan(); const before = dump(f.handle);
  const root = path.dirname(f.dataDir);
  const inputPath = path.join(root, 'trusted-synthetic-prepared.json');
  const harnessPath = path.join(root, 'trusted-migration-interruption.mjs');
  const dbPath = path.join(f.dataDir, 'board.db');
  // Both harness and fixture are written by this test outside the target data directory.
  writeFileSync(inputPath, JSON.stringify(f.prepared), { flag: 'wx', mode: 0o600 });
  writeFileSync(harnessPath, `
import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))};
import { drizzle } from ${JSON.stringify(import.meta.resolve('drizzle-orm/better-sqlite3'))};
import * as schema from ${JSON.stringify(new URL('../db/schema.ts', import.meta.url).href)};
import { applyMigration } from ${JSON.stringify(new URL('./migration.ts', import.meta.url).href)};
import { readFileSync } from 'node:fs';
const [dbPath, inputPath, dataDir, backupDir, planDigest] = process.argv.slice(2);
const sqlite = new Database(dbPath, { fileMustExist: true });
sqlite.pragma('foreign_keys = ON');
sqlite.function('exit_during_synthetic_migration', () => { process.exit(73); });
sqlite.exec("CREATE TRIGGER interrupt_synthetic_migration BEFORE UPDATE ON item WHEN NEW.id='synthetic-057' BEGIN SELECT exit_during_synthetic_migration(); END");
await applyMigration({ sqlite, db: drizzle(sqlite, { schema }) }, JSON.parse(readFileSync(inputPath, 'utf8')), { dataDir, backupDir, planDigest });
process.exitCode = 74; // Reaching this line means the interruption did not happen.
`, { flag: 'wx', mode: 0o600 });
  f.handle.sqlite.close();
  const child = spawnSync(process.execPath, ['--import', 'tsx', harnessPath, dbPath, inputPath, f.dataDir, f.backupDir, plan.planDigest], { encoding: 'utf8', cwd: process.cwd(), timeout: 15000 });
  // Reopen without bootstrap or journal-mode changes, even if the child failed.
  const sqlite = new Database(dbPath, { fileMustExist: true }); sqlite.pragma('foreign_keys = ON');
  Object.assign(f.handle, { sqlite, db: drizzle(sqlite, { schema }) });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 73, child.stderr);
  assert.equal(f.handle.db.select().from(items).all().filter(i => (i.fields as any)?.[RADIATOR_RECEIPT_KEY]).length, 0);
  const profileCount = f.handle.sqlite.prepare("SELECT count(*) AS n FROM setting WHERE key='radiator.intelligence.profile'").get() as { n: number };
  assert.equal(profileCount.n, 0);
  assert.equal(f.handle.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='radiator_migration_run'").get(), undefined);
  assert.equal(readdirSync(f.backupDir).filter(name => name.endsWith('.json')).length, 1);
  assert.ok(f.handle.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='interrupt_synthetic_migration'").get());
  f.handle.sqlite.exec('DROP TRIGGER interrupt_synthetic_migration');
  assert.equal(dump(f.handle), before);
  const resumed = await f.apply(plan.planDigest);
  assert.equal(resumed.alreadyApplied, false); assert.equal(resumed.eligible, 114); assert.equal(f.verify().ok, true);
  assert.equal((await f.apply(plan.planDigest)).alreadyApplied, true);
});
