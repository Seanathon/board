import { eq } from 'drizzle-orm';
import { boards, items, settings } from './schema.js';
import { getSetting, setSetting } from './settings.js';
import { enqueueTransaction, interruptItemJobDirect } from './queue.js';
import type { DbHandle } from './index.js';

const key = (boardId: string) => `board:${boardId}:browser-discovery`;
export function browserDiscoveryEnabled(handle: DbHandle, boardId: string): boolean {
  return getSetting(handle, key(boardId)) === 'true';
}
export async function setBrowserDiscovery(handle: DbHandle, boardId: string, enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') throw new TypeError('browserDiscovery must be a boolean');
  await enqueueTransaction(handle, () => {
    if (!handle.db.select().from(boards).where(eq(boards.id, boardId)).get()) throw new Error('Unknown board');
    if (browserDiscoveryEnabled(handle, boardId) === enabled) return;
    setSetting(handle, key(boardId), String(enabled));
    // Invalidate even an off/on ABA; a value comparison after inference is not enough.
    for (const item of handle.db.select({ id: items.id }).from(items).where(eq(items.boardId, boardId)).all()) interruptItemJobDirect(handle, item.id, 'analysis cancelled after board settings changed');
  });
}
/** Called inside the board deletion transaction. */
export function deleteBoardOptions(handle: DbHandle, boardId: string): void {
  handle.db.delete(settings).where(eq(settings.key, key(boardId))).run();
}
