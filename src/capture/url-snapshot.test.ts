import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';

import { createUrlSnapshotCapture, type CaptureHtmlFn } from './url-snapshot.js';
import { writeSnapshotAsset } from '../db/snapshot-asset.js';
import { runSnapshotJob } from './url-snapshot.js';
import { initDb } from '../db/index.js';
import { assets, items } from '../db/schema.js';
import type { TimeoutFn } from '../db/queue.js';

// Story 16.1 — snapshot asset kind via SingleFile on the existing capture sidecar.
// Tests inject a fake browser + a fake SingleFile driver (captureHtml) — no real Chrome,
// no real single-file-cli. The default driver (dynamic import + CDP-connect to the
// existing browser) is verified by inspection/manual run, not here (see story notes).

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// A minimal launchable+teardownable fake browser (process() emits 'exit' on kill()).
function fakeBrowser() {
  const proc = new EventEmitter() as EventEmitter & { kill: (s?: string) => boolean; killed: boolean };
  proc.killed = false;
  proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit('exit', 0)); return true; };
  return { close: async () => {}, process: () => proc };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'board-oss-snap-'));
}

describe('createUrlSnapshotCapture (Story 16.1)', () => {
  // AC 1 — capture produces the self-contained HTML bytes + sha256 hash via the driver.
  it('captures HTML bytes and hashes them (sha256) via the injected SingleFile driver', async () => {
    const html = '<html><body>archived content</body></html>';
    const cap = createUrlSnapshotCapture({ launch: async () => fakeBrowser(), captureHtml: async () => html });
    const out = await cap.capture('https://x.example', { itemId: 'i1' });
    assert.ok(out, 'returns a capture');
    assert.equal(out.bytes, Buffer.byteLength(html));
    assert.equal(out.hash, sha256(html));
    assert.ok(Buffer.isBuffer(out.buf));
  });

  // AC 3 — over the per-snapshot byte cap → NO asset (skip), file never written.
  it('returns null (skip) when the captured HTML exceeds the byte cap', async () => {
    const cap = createUrlSnapshotCapture({
      launch: async () => fakeBrowser(),
      captureHtml: async () => 'x'.repeat(1000),
      maxBytes: 100,
    });
    const out = await cap.capture('https://x.example', { itemId: 'i1' });
    assert.equal(out, null, 'over-cap capture yields no asset');
  });
});

describe('writeSnapshotAsset — additive, no-regression, dedupe (Story 16.1)', () => {
  async function seeded() {
    const { seed } = await import('../db/seed.js');
    const dir = tmp();
    const handle = initDb(join(dir, 'c.db'));
    seed(handle.db);
    return { handle, dir };
  }

  // AC 6 — THE load-bearing test: a snapshot write on an item that already has a
  // kind='screenshot' asset must leave that screenshot ROW *and its FILE* intact, and
  // the item must end with TWO asset rows (additive, not replace-all).
  it('preserves an existing screenshot asset (row AND file) and adds the snapshot', async () => {
    const { handle, dir } = await seeded();
    const { snapshotFromHtml } = await import('../db/snapshot-asset.js');
    const screenshotsDir = join(dir, 'screenshots');
    const snapshotsDir = join(dir, 'snapshots');
    try {
      handle.db.insert(items).values({ id: 'it1', boardId: 'library', source: 'https://x' }).run();
      // a real screenshot asset row + a real file on disk
      mkdirSync(screenshotsDir, { recursive: true });
      const shotAbs = join(screenshotsDir, 'it1.png');
      writeFileSync(shotAbs, Buffer.from('PNGDATA'));
      handle.db.insert(assets).values({ id: 'it1-shot', itemId: 'it1', kind: 'screenshot', path: 'screenshots/it1.png', hash: 'shothash' }).run();

      const res = await writeSnapshotAsset(handle, 'it1', snapshotFromHtml('<html>snap</html>'), { snapshotsDir });
      assert.equal(res.written, true);

      // screenshot row survives
      const shotRow = handle.db.select().from(assets).where(eq(assets.id, 'it1-shot')).get();
      assert.ok(shotRow, 'screenshot asset row still exists');
      assert.equal(shotRow.kind, 'screenshot');
      // screenshot FILE survives
      assert.ok(existsSync(shotAbs), 'screenshot file on disk still exists');
      // two rows total: screenshot + snapshot (additive)
      const rows = handle.db.select().from(assets).where(eq(assets.itemId, 'it1')).all();
      assert.equal(rows.length, 2, 'item has both the screenshot AND the snapshot');
      assert.ok(rows.some((r) => r.kind === 'snapshot' && r.id === 'it1-snapshot'));
      // the snapshot .html was written
      assert.ok(existsSync(join(snapshotsDir, basename(res.asset!.path))), 'snapshot html written');
    } finally {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC 1/7 — hash dedupe is OBSERVABLE: identical bytes re-archived → written:false AND
  // the file writer is NOT called again (a stable-id upsert always yields one row, so
  // "one row" would prove nothing — assert the skipped WRITE instead).
  it('dedupes identical bytes (no second file write) but rewrites changed bytes', async () => {
    const { handle, dir } = await seeded();
    const { snapshotFromHtml } = await import('../db/snapshot-asset.js');
    const snapshotsDir = join(dir, 'snapshots');
    let writes = 0;
    const writeFile = () => { writes += 1; };
    try {
      handle.db.insert(items).values({ id: 'it2', boardId: 'library', source: 'https://x' }).run();
      const snapA = snapshotFromHtml('<html>A</html>');

      const r1 = await writeSnapshotAsset(handle, 'it2', snapA, { snapshotsDir, writeFile });
      assert.equal(r1.written, true);
      assert.equal(writes, 1, 'first capture writes the file');

      const r2 = await writeSnapshotAsset(handle, 'it2', snapA, { snapshotsDir, writeFile });
      assert.equal(r2.written, false, 'identical bytes are deduped');
      assert.equal(writes, 1, 'dedupe SKIPPED the second file write (observable, not just one row)');

      const r3 = await writeSnapshotAsset(handle, 'it2', snapshotFromHtml('<html>B changed</html>'), { snapshotsDir, writeFile });
      assert.equal(r3.written, true, 'changed bytes are re-archived');
      assert.equal(writes, 2, 'changed bytes write the file again');

      // still exactly one snapshot row (in-place update), now with the new hash
      const snapRows = handle.db.select().from(assets).where(eq(assets.id, 'it2-snapshot')).all();
      assert.equal(snapRows.length, 1);
      assert.equal(snapRows[0].hash, snapshotFromHtml('<html>B changed</html>').hash);
    } finally {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runSnapshotJob — status-neutral degradation (Story 16.1)', () => {
  const manualTimeout = (): { fn: TimeoutFn; fire: () => void } => {
    let cb: (() => void) | null = null;
    return { fn: (c) => { cb = c; return () => (cb = null); }, fire: () => cb?.() };
  };
  function inspectableBrowser() {
    const proc = new EventEmitter() as EventEmitter & { kill: (s?: string) => boolean; killed: boolean };
    proc.killed = false;
    proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit('exit', 0)); return true; };
    return { browser: { close: async () => {}, process: () => proc }, proc };
  }
  async function seededItem(status: string) {
    const { seed } = await import('../db/seed.js');
    const dir = tmp();
    const handle = initDb(join(dir, 'c.db'));
    seed(handle.db);
    handle.db.insert(items).values({ id: 'd1', boardId: 'library', source: 'https://x', status }).run();
    return { handle, dir };
  }

  // AC 4 — a capture throw must NOT change the item's status (a curated `done` item must
  // never flip to `error`), must surface no error, and must write no asset.
  it('swallows a capture failure: no asset, item status unchanged, no throw', async () => {
    const { handle, dir } = await seededItem('done');
    try {
      const capture = createUrlSnapshotCapture({
        launch: async () => inspectableBrowser().browser,
        captureHtml: async () => { throw new Error('SingleFile blew up'); },
      });
      const res = await runSnapshotJob(handle, { itemId: 'd1', url: 'https://x', capture, snapshotsDir: join(dir, 'snapshots') });
      assert.equal(res.status, 'failed');
      assert.equal(handle.db.select().from(items).where(eq(items.id, 'd1')).get()!.status, 'done', 'status untouched');
      assert.equal(handle.db.select().from(assets).where(eq(assets.itemId, 'd1')).all().length, 0, 'no asset written');
    } finally {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC 4 (the optional-dependency reality) — when single-file-cli is NOT installed, the
  // default captureHtml's dynamic import rejects with ERR_MODULE_NOT_FOUND; that must
  // degrade identically (no asset, item untouched, no error). We inject that exact
  // rejection so the test is DETERMINISTIC regardless of whether the optional dep is
  // installed (npm installs optionalDependencies by default → ambient-absence would flake).
  it('degrades gracefully when the optional single-file-cli module is absent', async () => {
    const { handle, dir } = await seededItem('done');
    try {
      const moduleNotFound: CaptureHtmlFn = async () => {
        const err = new Error("Cannot find module 'single-file-cli'") as Error & { code?: string };
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      };
      const capture = createUrlSnapshotCapture({ launch: async () => inspectableBrowser().browser, captureHtml: moduleNotFound });
      const res = await runSnapshotJob(handle, { itemId: 'd1', url: 'https://x', capture, snapshotsDir: join(dir, 'snapshots') });
      assert.equal(res.status, 'failed', 'module-absence is swallowed like any capture failure');
      assert.equal(handle.db.select().from(items).where(eq(items.id, 'd1')).get()!.status, 'done');
      assert.equal(handle.db.select().from(assets).where(eq(assets.itemId, 'd1')).all().length, 0);
    } finally {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC 3 — a hung capture times out, the browser is SIGKILL-ed before the slot releases,
  // and the item is untouched (no error).
  it('times out a hung capture: SIGKILLs the browser, no asset, status unchanged', async () => {
    const { handle, dir } = await seededItem('done');
    const { proc, browser } = inspectableBrowser();
    const t = manualTimeout();
    try {
      const capture = createUrlSnapshotCapture({
        launch: async () => browser,
        captureHtml: () => new Promise<string>(() => {}), // hangs, ignores the signal
      });
      // Public IP literal so the SSRF guard takes its DNS-free path — the browser launches
      // promptly and the timeout-then-SIGKILL timing under test is deterministic.
      const request = { itemId: 'd1', url: 'https://93.184.216.34', capture, snapshotsDir: join(dir, 'snapshots'), timeoutFn: t.fn };
      handle.db.update(items).set({ source: request.url }).where(eq(items.id, request.itemId)).run();
      const p = runSnapshotJob(handle, request);
      await new Promise((r) => setImmediate(r));
      t.fire(); // trip the timeout
      const res = await p;
      assert.equal(res.status, 'failed');
      assert.equal(proc.killed, true, 'the hung browser was SIGKILL-ed on the teardown path');
      assert.equal(handle.db.select().from(items).where(eq(items.id, 'd1')).get()!.status, 'done');
    } finally {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runSnapshotJob — success path through the worker slot (Story 16.1)', () => {
  const neverFires: TimeoutFn = () => () => {};
  function fb() {
    const proc = new EventEmitter() as EventEmitter & { kill: (s?: string) => boolean; killed: boolean };
    proc.killed = false;
    proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit('exit', 0)); return true; };
    return { close: async () => {}, process: () => proc };
  }
  // REGRESSION for the nested-enqueue deadlock: a SUCCESSFUL capture must persist the
  // asset THROUGH the job (which holds the single-writer slot) and return 'written' —
  // not hang on a re-entrant enqueue. (writeSnapshotAssetDirect, not the enqueued wrapper.)
  it('persists the snapshot and returns written when the capture succeeds (no deadlock)', async () => {
    const { seed } = await import('../db/seed.js');
    const dir = tmp();
    const handle = initDb(join(dir, 'c.db'));
    seed(handle.db);
    handle.db.insert(items).values({ id: 'ok1', boardId: 'library', source: 'https://x', status: 'done' }).run();
    try {
      const capture = createUrlSnapshotCapture({ launch: async () => fb(), captureHtml: async () => '<html>archived</html>' });
      const res = await runSnapshotJob(handle, {
        itemId: 'ok1', url: 'https://x', capture, snapshotsDir: join(dir, 'snapshots'), timeoutFn: neverFires,
      });
      assert.equal(res.status, 'written', 'success path completes through the slot (would hang if it re-enqueued)');
      const row = handle.db.select().from(assets).where(eq(assets.id, 'ok1-snapshot')).get();
      assert.ok(row, 'snapshot asset row persisted');
      assert.equal(row.kind, 'snapshot');
      assert.ok(existsSync(join(dir, row.path)), 'snapshot html written');
      assert.equal(handle.db.select().from(items).where(eq(items.id, 'ok1')).get()!.status, 'done', 'status untouched');
    } finally {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
