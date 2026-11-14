import { boards, items, assets, type Asset, type Item } from './schema.js';
import type { BoardDescriptor } from '../descriptor/types.js';
import type { DbHandle } from './index.js';

// Story 17.1 — the trust handshake: export every board/item/asset reference. The
// inverse of db/importer.ts — it READS items → records (importer maps records → items).
// READ-ONLY by hard invariant: `select()` only, NEVER writeItem/enqueueWrite/INSERT/
// UPDATE/DELETE. JSON round-trips through importRecords where possible (per-board record
// arrays shaped exactly as mapInspiration/mapLibrary read). Netscape HTML is browser/
// linkding-compatible. Binary assets are referenced by path+hash, not inlined.

type RawRecord = Record<string, unknown>;

export interface ExportBoard {
  id: string;
  name: string;
  view: string;
  descriptor: unknown;
}
export interface ExportAsset {
  id: string;
  itemId: string;
  kind: string;
  path: string;
  hash: string | null;
  width: number | null;
  height: number | null;
}
export interface ExportDocument {
  version: 1;
  boards: ExportBoard[];
  /** per-board record arrays, keyed by board id — re-ingestible via importRecords. */
  items: Record<string, RawRecord[]>;
  assets: ExportAsset[];
}

/** Escape text for the HTML (Netscape) context — url/title/tags are untrusted. */
function escHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Group assets by item id (one read of the table). */
function assetsByItem(handle: DbHandle): Map<string, Asset[]> {
  const map = new Map<string, Asset[]>();
  for (const a of handle.db.select().from(assets).all()) {
    const list = map.get(a.itemId) ?? [];
    list.push(a);
    map.set(a.itemId, list);
  }
  return map;
}

/**
 * Shape one item as an importer-compatible record. Un-flattens the dotted `fields`
 * keys back into nested groups (`meta.audience` → `meta:{audience}`) for inspiration
 * round-trip; flat keys (library: summary/topics/…) and dot-less user fields land at
 * the top level. Also carries url, title, favorite, notes, added, the analysis fields,
 * screenshot, and status (completeness) — mappers read what they need, ignore the rest.
 */
export function toRecord(item: Item, shots: Asset[]): RawRecord {
  const rec: RawRecord = {
    id: item.id,
    url: item.source ?? null,
    title: item.title ?? null,
    status: item.status,
    favorite: !!item.favorite,
    notes: item.notes ?? null,
    analysis_agent: item.analysisProvider ?? null,
    analysis_model: item.analysisModel ?? null,
  };
  // `!= null` (not truthy) so a legitimate epoch-0 createdAt isn't dropped.
  if (item.createdAt != null) rec.added = new Date(item.createdAt * 1000).toISOString();

  const fields = (item.fields as Record<string, unknown>) ?? {};
  for (const [key, value] of Object.entries(fields)) {
    const dot = key.indexOf('.');
    if (dot > 0) {
      const group = key.slice(0, dot);
      const leaf = key.slice(dot + 1);
      const nested = (rec[group] as Record<string, unknown>) ?? {};
      nested[leaf] = value;
      rec[group] = nested;
    } else {
      rec[key] = value;
    }
  }

  const screenshot = shots.find((a) => a.kind === 'screenshot');
  if (screenshot?.path) rec.screenshot = screenshot.path;
  return rec;
}

/** Full read-only JSON export. */
export function exportJson(handle: DbHandle): ExportDocument {
  const boardRows = handle.db.select().from(boards).all();
  const itemRows = handle.db.select().from(items).all();
  const assetRows = handle.db.select().from(assets).all();
  const byItem = assetsByItem(handle);

  const itemsByBoard: Record<string, RawRecord[]> = {};
  for (const it of itemRows) {
    (itemsByBoard[it.boardId] ??= []).push(toRecord(it, byItem.get(it.id) ?? []));
  }

  return {
    version: 1,
    boards: boardRows.map((b) => ({ id: b.id, name: b.name, view: b.view, descriptor: b.descriptor })),
    items: itemsByBoard,
    assets: assetRows.map((a) => ({
      id: a.id, itemId: a.itemId, kind: a.kind, path: a.path, hash: a.hash, width: a.width, height: a.height,
    })),
  };
}

/** Resolve an item's tags from its board's `type:'tags'` fields (+ common fallbacks). */
function resolveTags(item: Item, descriptor: BoardDescriptor | undefined): string {
  const fields = (item.fields as Record<string, unknown>) ?? {};
  const tagKeys = new Set<string>();
  for (const f of descriptor?.fields ?? []) {
    if (f.type === 'tags') tagKeys.add(f.key);
  }
  // Fallback when no descriptor tag fields are resolvable.
  if (tagKeys.size === 0) ['meta.tags', 'meta.tone', 'topics'].forEach((k) => tagKeys.add(k));

  const out: string[] = [];
  for (const key of tagKeys) {
    const v = fields[key];
    if (Array.isArray(v)) {
      for (const t of v) if (typeof t === 'string' && t.length > 0) out.push(t);
    } else if (typeof v === 'string' && v.length > 0) {
      out.push(v);
    }
  }
  return [...new Set(out)].join(',');
}

/** Read-only Netscape Bookmark File export (browser/linkding-compatible). */
export function exportNetscape(handle: DbHandle): string {
  const descByBoard = new Map<string, BoardDescriptor | undefined>();
  for (const b of handle.db.select().from(boards).all()) {
    descByBoard.set(b.id, (b.descriptor as BoardDescriptor | undefined) ?? undefined);
  }
  const itemRows = handle.db.select().from(items).all();

  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  for (const it of itemRows) {
    if (!it.source) continue; // a Netscape bookmark must have an HREF
    const tags = resolveTags(it, descByBoard.get(it.boardId));
    const addDate = it.createdAt ?? '';
    const tagsAttr = tags ? ` TAGS="${escHtml(tags)}"` : '';
    lines.push(
      `<DT><A HREF="${escHtml(it.source)}" ADD_DATE="${addDate}"${tagsAttr}>${escHtml(it.title ?? it.source)}</A>`,
    );
  }
  lines.push('</DL><p>');
  return lines.join('\n');
}
