import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import { initDb } from '../db/index.js';
import { items } from '../db/schema.js';
import { seed, INSPIRATION_BOARD_ID } from '../db/seed.js';
import { buildCtx, type Ctx } from './types.js';
import { importBookmarksSkill } from './import-bookmarks.js';

const PAYLOAD = [
  { id: 'sk-1', url: 'https://a.example', added: '2025-01-01', screenshot: 'screenshots/sk-1.png', title: 'A', meta: { audience: 'b2b' }, design: { steal_this: 'x' }, reflection: {}, favorite: false },
  { id: 'sk-2', url: 'https://b.example', added: '2025-01-02', screenshot: 'screenshots/sk-2.png', title: 'B', meta: { audience: 'consumer' }, design: {}, reflection: {}, favorite: true },
];

describe('import-bookmarks skill (Story 3.3)', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;
  let ctx: Ctx;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-importsk-'));
    handle = initDb(join(dir, 'isk.db'));
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

  // AC 1 + 4 — creates items and reports created count.
  // The blanket "everything imports as pending" of the original AC is superseded: an
  // imported record that already carries its AI read is stored as `done`, because
  // `pending` is the signal the capture UI renders a skeleton for, and a complete item
  // has nothing left to wait for. Records without enrichment still import as pending.
  it('creates items under the target board, status reflecting whether they are enriched', async () => {
    const out = await importBookmarksSkill.run(
      { boardId: INSPIRATION_BOARD_ID, bookmarks: PAYLOAD },
      ctx,
    );
    assert.equal(out.created, 2);
    assert.equal(out.skipped, 0);
    assert.deepEqual(out.itemIds.sort(), ['sk-1', 'sk-2']);

    const rows = handle.db.select().from(items).where(eq(items.boardId, INSPIRATION_BOARD_ID)).all();
    assert.equal(rows.length, 2);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    assert.equal(byId['sk-1'], 'done', 'sk-1 carries design.steal_this — already enriched');
    assert.equal(byId['sk-2'], 'pending', 'sk-2 has no AI read — still awaits enrichment');
  });

  // AC 2 + 4 — dedupe by preserved item.id; second run reports skipped, not created
  it('dedupes on a second run (created=0, skipped=N) without duplicating', async () => {
    const out = await importBookmarksSkill.run(
      { boardId: INSPIRATION_BOARD_ID, bookmarks: PAYLOAD },
      ctx,
    );
    assert.equal(out.created, 0);
    assert.equal(out.skipped, 2);
    const rows = handle.db.select().from(items).all();
    assert.equal(rows.length, 2, 'no duplicate items on re-run');
  });

  it('throws on an unknown target board', async () => {
    await assert.rejects(
      importBookmarksSkill.run({ boardId: 'no-such-board', bookmarks: PAYLOAD }, ctx),
      /board/i,
    );
  });

  it('rejects input that is not the {boardId, bookmarks} shape (zod)', () => {
    assert.equal(importBookmarksSkill.inputSchema.safeParse({ boardId: 'x' }).success, false);
    assert.equal(
      importBookmarksSkill.inputSchema.safeParse({ boardId: 'x', bookmarks: [{ id: 'a' }] }).success,
      true,
    );
  });
});
