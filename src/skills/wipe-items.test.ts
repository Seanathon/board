import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb } from '../db/index.js';
import { boards, items, assets } from '../db/schema.js';
import { seed, INSPIRATION_BOARD_ID } from '../db/seed.js';
import { writeItem } from '../db/queue.js';
import { buildCtx, type Ctx } from './types.js';
import { wipeItemsSkill } from './wipe-items.js';

// "Start from a fresh state" — the ONLY destructive path in the data feature. It
// clears items and their images; boards and their descriptors survive, so a wiped
// install still has the shape the user built, just none of the contents.
describe('wipe-items skill', () => {
  let dir: string;
  let shotDir: string;
  let handle: ReturnType<typeof initDb>;
  let ctx: Ctx;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-wipe-'));
    shotDir = mkdtempSync(join(tmpdir(), 'board-oss-wipe-shots-'));
    handle = initDb(join(dir, 'w.db'));
    seed(handle.db);
    ctx = buildCtx({
      db: handle,
      queue: { enqueueWrite: async (fn) => fn() },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    mkdirSync(join(shotDir), { recursive: true });
    writeFileSync(join(shotDir, 'a.png'), 'imagebytes');
    await writeItem(handle, { id: 'a', boardId: INSPIRATION_BOARD_ID, source: 'https://a', title: 'A' },
      [{ id: 'a-shot', itemId: 'a', kind: 'screenshot', path: 'screenshots/a.png' }]);
    await writeItem(handle, { id: 'b', boardId: INSPIRATION_BOARD_ID, source: 'https://b', title: 'B' });
  });
  after(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(shotDir, { recursive: true, force: true });
  });

  it('refuses to run without the explicit confirmation token', async () => {
    await assert.rejects(
      () => wipeItemsSkill.run({ confirm: 'yes', screenshotsDir: shotDir }, ctx),
      /confirm/i,
      'a stray call must not be able to destroy the collection',
    );
    assert.equal(handle.db.select().from(items).all().length, 2, 'nothing was deleted');
  });

  it('deletes every item, its asset rows and the image files, keeping boards', async () => {
    const boardsBefore = handle.db.select().from(boards).all().length;

    const out = await wipeItemsSkill.run({ confirm: 'delete', screenshotsDir: shotDir }, ctx);

    assert.equal(out.itemsDeleted, 2);
    assert.equal(out.assetsDeleted, 1);
    assert.equal(handle.db.select().from(items).all().length, 0, 'no items remain');
    assert.equal(handle.db.select().from(assets).all().length, 0, 'no asset rows remain');
    assert.equal(handle.db.select().from(boards).all().length, boardsBefore, 'boards and their descriptors survive');
    assert.equal(existsSync(join(shotDir, 'a.png')), false, 'the image file is removed, not orphaned on disk');
  });

  it('leaves the full-text index empty so wiped items stop appearing in search', () => {
    const rows = handle.sqlite.prepare('SELECT count(*) AS n FROM item_fts').get() as { n: number };
    assert.equal(rows.n, 0, 'FTS must not retain rows for deleted items');
  });
});
