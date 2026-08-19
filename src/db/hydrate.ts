import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { assets, items, type Item, type Asset } from './schema.js';
import { jobLinePositionOf } from './queue.js';
import type { DbHandle } from './index.js';

// Story 8.x cutover — present a SQLite item in the shape the (polished, prototype)
// frontend renderers consume: system columns lifted to the top level, the flat dotted
// `fields` un-flattened into nested groups (meta.*/design.*/reflection.* → nested
// objects), the screenshot asset attached, and createdAt rendered as a YYYY-MM-DD
// `added`. This lets the running app read/write SQLite WITHOUT rewriting the renderers.
export function hydrateItemForUi(item: Item, itemAssets: Asset[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: item.id,
    url: item.source ?? '',
    title: item.title ?? '',
    notes: item.notes ?? '',
    favorite: !!item.favorite,
    status: item.status,
    added: item.createdAt ? new Date(item.createdAt * 1000).toISOString().slice(0, 10) : '',
  };
  if (item.errorReason) out.error_reason = item.errorReason;

  // Where it stands in the job line, so a reload mid-queue keeps saying "3rd in line"
  // instead of falling back to "Capturing the page". Undefined for anything not
  // waiting, which is every item on a normal load.
  const queuePosition = jobLinePositionOf(item.id);
  if (queuePosition !== undefined) out.queuePosition = queuePosition;

  // The card/modal image: a real screenshot (url-screenshot boards) or, failing that,
  // the page's hero image (og:image, captured for readable boards). Either one fills the
  // single `screenshot` field the renderers read.
  const shot = itemAssets.find((a) => a.kind === 'screenshot') ?? itemAssets.find((a) => a.kind === 'image');
  if (shot?.path) out.screenshot = shot.path;

  const fields = (item.fields as Record<string, unknown>) ?? {};
  for (const [key, value] of Object.entries(fields)) {
    const dot = key.indexOf('.');
    if (dot > 0) {
      const group = key.slice(0, dot);
      const leaf = key.slice(dot + 1);
      const nested = (out[group] as Record<string, unknown>) ?? {};
      nested[leaf] = value;
      out[group] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** All items on a board, newest first, hydrated for the UI (one asset query, grouped). */
export function listBoardItemsForUi(handle: DbHandle, boardId: string): Record<string, unknown>[] {
  const rows = handle.db
    .select()
    .from(items)
    .where(eq(items.boardId, boardId))
    .orderBy(desc(items.createdAt))
    .all();
  const byItem = new Map<string, Asset[]>();
  for (const a of handle.db.select().from(assets).all()) {
    const list = byItem.get(a.itemId) ?? [];
    list.push(a);
    byItem.set(a.itemId, list);
  }
  return rows.map((it) => hydrateItemForUi(it, byItem.get(it.id) ?? []));
}

/** Story 12.2 — filter/recency/pagination options for the public list API. */
export interface ListItemsQuery {
  boardId?: string;
  status?: string;
  /** unix seconds; returns items with created_at >= since */
  since?: number;
  limit?: number;
  offset?: number;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

/**
 * Story 12.2 — cross-board, filtered, paginated item list for `GET /api/v1/items`,
 * newest-first (created_at DESC, idx_item_created_at). Distinct from
 * `listBoardItemsForUi` (single board, unbounded). The limit is clamped to a bounded
 * max so a polling client can't request an unbounded scan. Assets are loaded only for
 * the returned page (not the whole table).
 */
export function listItemsForApi(handle: DbHandle, q: ListItemsQuery = {}): Record<string, unknown>[] {
  const conds = [];
  if (q.boardId) conds.push(eq(items.boardId, q.boardId));
  if (q.status) conds.push(eq(items.status, q.status));
  if (q.since !== undefined) conds.push(gte(items.createdAt, q.since));
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

  // Defensive: a non-finite limit/offset (e.g. NaN from a bad caller) falls back to
  // the default rather than producing a degenerate query.
  const limit = Math.min(Math.max(Number.isFinite(q.limit) ? (q.limit as number) : LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const offset = Math.max(Number.isFinite(q.offset) ? (q.offset as number) : 0, 0);

  const rows = handle.db
    .select()
    .from(items)
    .where(where)
    .orderBy(desc(items.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  const ids = rows.map((r) => r.id);
  const byItem = new Map<string, Asset[]>();
  if (ids.length > 0) {
    for (const a of handle.db.select().from(assets).where(inArray(assets.itemId, ids)).all()) {
      const list = byItem.get(a.itemId) ?? [];
      list.push(a);
      byItem.set(a.itemId, list);
    }
  }
  return rows.map((it) => hydrateItemForUi(it, byItem.get(it.id) ?? []));
}

/** One item, hydrated for the UI (or undefined). */
export function getItemForUi(handle: DbHandle, id: string): Record<string, unknown> | undefined {
  const item = handle.db.select().from(items).where(eq(items.id, id)).get();
  if (!item) return undefined;
  const itemAssets = handle.db.select().from(assets).where(eq(assets.itemId, id)).all();
  return hydrateItemForUi(item, itemAssets);
}
