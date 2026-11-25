import { deleteBoardOptions } from './board-options.js';
import { eq } from 'drizzle-orm';

import { boards, items } from './schema.js';
import { enqueueTransaction } from './queue.js';
import { deleteItemWithAssets } from './item-actions.js';
import type { DbHandle } from './index.js';

// Board-level edit actions for the "New board" / "Edit board" UI.

/**
 * Rename a board through the single writer. Throws on an unknown board.
 */
export async function renameBoard(handle: DbHandle, boardId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('board name is required');
  const board = handle.db.select().from(boards).where(eq(boards.id, boardId)).get();
  if (!board) throw new Error(`unknown board "${boardId}"`);
  await enqueueTransaction(handle, () => {
    handle.db.update(boards).set({ name: trimmed }).where(eq(boards.id, boardId)).run();
  });
}

/**
 * Delete a board AND all of its items, asset rows, and asset files (cascade) — there
 * is no FK cascade, so each item is removed via deleteItemWithAssets (rows + files),
 * then the board row. Returns counts. NOTE: a SEEDED board (inspiration/library) will
 * be re-created empty on the next boot (seed is idempotent) — that's expected.
 */
export async function deleteBoardCascade(
  handle: DbHandle,
  boardId: string,
  screenshotsDir: string,
): Promise<{ deleted: boolean; items: number; files: number }> {
  const board = handle.db.select().from(boards).where(eq(boards.id, boardId)).get();
  if (!board) return { deleted: false, items: 0, files: 0 };

  const itemRows = handle.db.select().from(items).where(eq(items.boardId, boardId)).all();
  let files = 0;
  for (const it of itemRows) {
    const res = await deleteItemWithAssets(handle, it.id, screenshotsDir);
    files += res.filesRemoved;
  }
  await enqueueTransaction(handle, () => {
    deleteBoardOptions(handle, boardId);
    handle.db.delete(boards).where(eq(boards.id, boardId)).run();
  });
  return { deleted: true, items: itemRows.length, files };
}
