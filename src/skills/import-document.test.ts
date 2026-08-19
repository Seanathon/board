import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import { initDb } from '../db/index.js';
import { boards, items } from '../db/schema.js';
import { seed, INSPIRATION_BOARD_ID } from '../db/seed.js';
import { exportJson } from '../db/export.js';
import { writeItem } from '../db/queue.js';
import { buildCtx, type Ctx } from './types.js';
import { importDocumentSkill } from './import-document.js';

// Export emitted a whole document (boards + per-board items + assets) that NOTHING
// could read back: no skill consumed it and no code path recreated a board from one.
// This closes the round trip.
describe('import-document skill', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;
  let ctx: Ctx;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-impdoc-'));
    handle = initDb(join(dir, 'i.db'));
    seed(handle.db);
    ctx = buildCtx({
      db: handle,
      queue: { enqueueWrite: async (fn) => fn() },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
  });
  after(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('recreates a missing board and its items from an export document', async () => {
    const doc = {
      version: 1 as const,
      boards: [{ id: 'wishlist', name: 'Wish List', view: 'grid', descriptor: { name: 'Wish List', fields: [], view: 'grid', ingest_mode: 'url-screenshot' } }],
      items: { wishlist: [{ id: 'w1', url: 'https://example.com/a', title: 'A', priority: 'high' }] },
      assets: [],
    };

    const out = await importDocumentSkill.run({ document: doc }, ctx);

    assert.equal(out.boardsCreated, 1, 'a board present in the document but not the DB is created');
    assert.equal(out.itemsCreated, 1);
    const board = handle.db.select().from(boards).where(eq(boards.id, 'wishlist')).get();
    assert.ok(board, 'the composed board exists after import');
    assert.equal(board.name, 'Wish List');
    const item = handle.db.select().from(items).where(eq(items.id, 'w1')).get();
    assert.equal((item?.fields as Record<string, unknown>)['priority'], 'high');
  });

  it('never overwrites an existing board or its items', async () => {
    await writeItem(handle, { id: 'keep-me', boardId: INSPIRATION_BOARD_ID, source: 'https://x', title: 'Original' });
    const before = handle.db.select().from(boards).where(eq(boards.id, INSPIRATION_BOARD_ID)).get();

    const out = await importDocumentSkill.run({
      document: {
        version: 1 as const,
        boards: [{ id: INSPIRATION_BOARD_ID, name: 'HIJACKED', view: 'list', descriptor: { name: 'x', fields: [], view: 'list', ingest_mode: 'url-readable' } }],
        items: { [INSPIRATION_BOARD_ID]: [{ id: 'keep-me', url: 'https://evil', title: 'Clobbered' }] },
        assets: [],
      },
    }, ctx);

    const after = handle.db.select().from(boards).where(eq(boards.id, INSPIRATION_BOARD_ID)).get();
    assert.equal(after?.name, before?.name, 'an existing board keeps its name');
    assert.equal(after?.view, before?.view, 'an existing board keeps its view');
    const item = handle.db.select().from(items).where(eq(items.id, 'keep-me')).get();
    assert.equal(item?.title, 'Original', 'an existing item is never rewritten');
    assert.equal(out.itemsSkipped, 1);
    assert.equal(out.boardsCreated, 0);
  });

  it('round-trips a real exportJson document into an empty database', async () => {
    const src = initDb(join(dir, 'src.db'));
    seed(src.db);
    src.db.insert(boards).values({ id: 'wishlist', name: 'Wish List', view: 'grid', descriptor: { name: 'Wish List', fields: [], view: 'grid', ingest_mode: 'url-screenshot' } as never }).run();
    await writeItem(src, { id: 'rt-1', boardId: 'wishlist', source: 'https://example.com/rt', title: 'Round Trip', fields: { 'gift.price': 42 } });
    const doc = exportJson(src);
    src.sqlite.close();

    const destDir = mkdtempSync(join(tmpdir(), 'board-oss-impdoc-dest-'));
    const dest = initDb(join(destDir, 'd.db'));
    const destCtx = buildCtx({ db: dest, queue: { enqueueWrite: async (fn) => fn() }, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    try {
      const out = await importDocumentSkill.run({ document: doc }, destCtx);
      assert.ok(out.boardsCreated >= 4, 'every exported board is recreated in an empty DB');
      const item = dest.db.select().from(items).where(eq(items.id, 'rt-1')).get();
      assert.ok(item, 'the composed board item survives the round trip');
      assert.equal((item.fields as Record<string, unknown>)['gift.price'], 42);
    } finally {
      dest.sqlite.close();
      rmSync(destDir, { recursive: true, force: true });
    }
  });
});
