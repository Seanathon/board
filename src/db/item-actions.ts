import { basename, dirname, join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';

import { eq } from 'drizzle-orm';

import { assets, boards, items, type Item } from './schema.js';
import { isRadiatorBoardActive } from '../radiator/profile.js';
import { isRadiatorReadOnlyField, isRadiatorMetadataKey } from '../radiator/contract.js';
import { enqueueWrite, writeItemDirect, writeItem, deleteItem } from './queue.js';
import type { BoardDescriptor } from '../descriptor/types.js';
import type { DbHandle } from './index.js';

// Story 8.3 — per-item curation actions on the SQLite store (notes, favorite,
// delete). REST, not skills (the v1 skill list is fixed and excludes these).

// `notes` and `favorite` are always-user-owned system columns. Any other PATCHable
// user field is an `enrichable:false` descriptor field (e.g. favorite_reason) — the
// allowlist is descriptor-driven so enriched/system fields can NEVER be overwritten.
const USER_COLUMNS = new Set(['notes', 'favorite']);

/**
 * PATCH an item's user-owned fields. Disallowed keys (status, enriched fields, …)
 * are SILENTLY IGNORED (matching the prototype). Writes through the typed item-write
 * helper so `search_blob`/FTS refresh (notes are searchable). Returns the updated
 * row, or undefined if the item doesn't exist.
 */
export async function patchItemFields(
  handle: DbHandle,
  itemId: string,
  patch: Record<string, unknown>,
): Promise<Item | undefined> {
  const item = handle.db.select().from(items).where(eq(items.id, itemId)).get();
  if (!item) return undefined;
  const board = handle.db.select().from(boards).where(eq(boards.id, item.boardId)).get();
  const descriptor = board?.descriptor as BoardDescriptor | undefined;
  const allowedFieldKeys = new Set(
    (descriptor?.fields ?? []).filter((f) => f.enrichable === false && !isRadiatorMetadataKey(f.key) && (!isRadiatorBoardActive(handle, item.boardId) || !isRadiatorReadOnlyField(f.key))).map((f) => f.key),
  );

  const columnUpdates: Record<string, unknown> = {};
  const fieldUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (USER_COLUMNS.has(key)) {
      columnUpdates[key] = key === 'favorite' ? (value ? 1 : 0) : value;
    } else if (allowedFieldKeys.has(key)) {
      fieldUpdates[key] = value;
    }
    // else: disallowed (status / enriched / unknown) → silently ignored.
  }

  if (isRadiatorBoardActive(handle, item.boardId)) return enqueueWrite(() => {
    const fresh = handle.db.select().from(items).where(eq(items.id, itemId)).get();
    if (!fresh || fresh.boardId !== item.boardId) return undefined;
    writeItemDirect(handle, { ...fresh, ...columnUpdates, updatedAt: Math.floor(Date.now() / 1000), fields: { ...((fresh.fields as Record<string, unknown>) ?? {}), ...fieldUpdates } });
    return handle.db.select().from(items).where(eq(items.id, itemId)).get();
  });
  const fields = { ...((item.fields as Record<string, unknown>) ?? {}), ...fieldUpdates };
  // Bump updatedAt (seconds, matching the unixepoch() DB default) so a future
  // "recently edited" sort sees curation edits.
  const updatedAt = Math.floor(Date.now() / 1000);
  await writeItem(handle, { ...item, ...columnUpdates, updatedAt, fields });
  return handle.db.select().from(items).where(eq(items.id, itemId)).get();
}

/**
 * Delete an item, its asset rows (via deleteItem), AND its asset FILES on disk —
 * board-agnostic (any item may have an uploaded asset, Story 6.4), unlike the
 * prototype's grid-only cleanup. Routes each asset to its own dir by the stored path
 * prefix (screenshots/ vs the snapshots/ sibling), so both kinds clean up correctly
 * (Story 2.2 relative-path contract). Returns the number of asset files unlinked.
 */
export async function deleteItemWithAssets(
  handle: DbHandle,
  itemId: string,
  screenshotsDir: string,
): Promise<{ deleted: boolean; filesRemoved: number }> {
  const item = handle.db.select().from(items).where(eq(items.id, itemId)).get();
  if (!item) return { deleted: false, filesRemoved: 0 };

  const assetRows = handle.db.select().from(assets).where(eq(assets.itemId, itemId)).all();
  await deleteItem(handle, itemId); // removes asset rows + item + fts atomically

  // Route each asset to ITS OWN dir by the stored path prefix, then resolve by basename.
  // Epic-16 snapshot assets ("snapshots/<id>.html") live in the snapshots/ sibling of
  // screenshotsDir — the old basename-under-screenshotsDir unlink orphaned them. Snapshots
  // dir is the sibling of screenshotsDir (both are `<dataDir>/{screenshots,snapshots}`).
  const snapshotsDir = join(dirname(screenshotsDir), 'snapshots');
  let filesRemoved = 0;
  for (const a of assetRows) {
    if (!a.path) continue;
    // Shared-file safety (Story 15.3): a materialized copy's asset row references the SAME
    // file (identical relative `path`) as its source. `deleteItem` already removed THIS
    // item's asset rows, so if any OTHER asset row still has this exact path, the file is
    // shared — do NOT unlink it. The full relative path is 1:1 with the resolved file
    // (prefix → dir, basename → name), so guard and unlink can never disagree.
    const stillReferenced = handle.db
      .select({ path: assets.path })
      .from(assets)
      .all()
      .some((r) => r.path === a.path);
    if (stillReferenced) continue;
    const baseDir = a.path.startsWith('snapshots/') ? snapshotsDir : screenshotsDir;
    const abs = join(baseDir, basename(a.path));
    if (existsSync(abs)) {
      unlinkSync(abs);
      filesRemoved += 1;
    }
  }
  return { deleted: true, filesRemoved };
}
