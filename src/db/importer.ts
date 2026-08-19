import { readFileSync, existsSync } from 'node:fs';

import { eq } from 'drizzle-orm';

import { writeItem } from './queue.js';
import { items, type NewItem, type NewAsset } from './schema.js';
import { INSPIRATION_BOARD_ID, LIBRARY_BOARD_ID } from './seed.js';
import type { DbHandle } from './index.js';

// Story 1.5 — flat-JSON → SQLite importer.
//
// Two layers (the split is non-negotiable — Story 3.3's import-bookmarks skill
// wraps layer (a) with an in-memory payload; the one-shot migration uses (b)):
//   (a) importRecords({ handle, boardId, records }) — board-agnostic per-record
//       mapping + insert through the typed writer (so search_blob + FTS are
//       maintained and writes are idempotent on the preserved record id).
//   (b) importFlatJson({ handle, inspirationPath, libraryPath }) — reads the flat
//       files (gracefully skipping any that are absent) and delegates to (a).
//
// Idempotency: the original record `id` is preserved as `item.id` (the stable dedupe
// key). importRecords SKIPS a record whose id already exists (global dedupe by PK)
// rather than re-writing it — so a second run creates nothing, leaves existing rows
// (incl. user edits) and the FTS index untouched, and reports created=0/skipped=N.

type Mapped = { item: NewItem; assets: NewAsset[] };
type RawRecord = Record<string, unknown>;

function parseAdded(added: unknown): number | undefined {
  if (typeof added !== 'string' || added.length === 0) return undefined;
  const ms = Date.parse(added);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** Flatten a nested group ({audience,...}) into dotted keys (meta.audience, …). */
function flattenGroup(target: Record<string, unknown>, prefix: string, group: unknown): void {
  if (group && typeof group === 'object' && !Array.isArray(group)) {
    for (const [k, v] of Object.entries(group as Record<string, unknown>)) {
      if (v !== undefined && v !== null) target[`${prefix}.${k}`] = v;
    }
  }
}

/** Inspiration record (bookmarks.json) → item + screenshot asset. */
function mapInspiration(r: RawRecord, boardId: string): Mapped {
  const id = String(r.id);
  const fields: Record<string, unknown> = {};
  flattenGroup(fields, 'meta', r.meta);
  flattenGroup(fields, 'design', r.design);
  flattenGroup(fields, 'reflection', r.reflection);
  if (typeof r.favorite_reason === 'string' && r.favorite_reason.length > 0) {
    fields['favorite_reason'] = r.favorite_reason;
  }

  const item: NewItem = {
    id,
    boardId,
    source: typeof r.url === 'string' ? r.url : null,
    title: typeof r.title === 'string' ? r.title : null,
    favorite: r.favorite ? 1 : 0,
    notes: typeof r.notes === 'string' ? r.notes : null,
    fields,
    createdAt: parseAdded(r.added),
  };

  const itemAssets: NewAsset[] =
    typeof r.screenshot === 'string' && r.screenshot.length > 0
      ? [{ id: `${id}-screenshot`, itemId: id, kind: 'screenshot', path: r.screenshot }]
      : [];

  return { item, assets: itemAssets };
}

/** Library record (library.json) → item (no asset). */
function mapLibrary(r: RawRecord, boardId: string): Mapped {
  const id = String(r.id);
  const fields: Record<string, unknown> = {};
  for (const key of ['summary', 'author', 'topics', 'type', 'key_points']) {
    if (r[key] !== undefined && r[key] !== null) fields[key] = r[key];
  }

  const item: NewItem = {
    id,
    boardId,
    source: typeof r.url === 'string' ? r.url : null,
    title: typeof r.title === 'string' ? r.title : null,
    notes: typeof r.notes === 'string' ? r.notes : null,
    fields,
    analysisProvider: typeof r.analysis_agent === 'string' ? r.analysis_agent : null,
    analysisModel: typeof r.analysis_model === 'string' ? r.analysis_model : null,
    createdAt: parseAdded(r.added),
  };

  return { item, assets: [] };
}

/**
 * System keys that live in item COLUMNS, not in the `fields` bag. Kept in sync with
 * export's `toRecord`, which is the shape the generic mapper reverses.
 */
const SYSTEM_RECORD_KEYS = new Set([
  'id', 'url', 'title', 'status', 'favorite', 'notes',
  'analysis_agent', 'analysis_model', 'added', 'screenshot',
]);

/**
 * Board-agnostic record → item. The exact inverse of export's `toRecord`: system keys
 * become columns, every nested group re-flattens to dotted field keys, and remaining
 * scalars/arrays pass through untouched.
 *
 * This is what makes an export re-importable. The two hand-written mappers below stay
 * for the legacy flat files (bookmarks.json / library.json), whose shape predates the
 * descriptor and whose field selection must not change; every OTHER board — including
 * every composed one — lands here instead of throwing "no mapping registered".
 */
function mapGeneric(r: RawRecord, boardId: string): Mapped {
  const id = String(r.id);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(r)) {
    if (SYSTEM_RECORD_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      flattenGroup(fields, key, value);
    } else {
      fields[key] = value;
    }
  }

  const item: NewItem = {
    id,
    boardId,
    source: typeof r.url === 'string' ? r.url : null,
    title: typeof r.title === 'string' ? r.title : null,
    favorite: r.favorite ? 1 : 0,
    notes: typeof r.notes === 'string' ? r.notes : null,
    fields,
    analysisProvider: typeof r.analysis_agent === 'string' ? r.analysis_agent : null,
    analysisModel: typeof r.analysis_model === 'string' ? r.analysis_model : null,
    createdAt: parseAdded(r.added),
  };
  if (typeof r.status === 'string' && r.status.length > 0) item.status = r.status;

  const itemAssets: NewAsset[] =
    typeof r.screenshot === 'string' && r.screenshot.length > 0
      ? [{ id: `${id}-screenshot`, itemId: id, kind: 'screenshot', path: r.screenshot }]
      : [];

  return { item, assets: itemAssets };
}

type Mapper = (r: RawRecord, boardId: string) => Mapped;

const MAPPERS: Record<string, Mapper> = {
  [INSPIRATION_BOARD_ID]: mapInspiration,
  [LIBRARY_BOARD_ID]: mapLibrary,
};

export interface ImportRecordsArgs {
  handle: DbHandle;
  boardId: string;
  records: RawRecord[];
}

export interface ImportResult {
  created: number;
  skipped: number;
  itemIds: string[];
}

/**
 * Layer (a): map an in-memory record array onto items under `boardId` and write
 * them through the typed single-writer path. Dedupe is GLOBAL by `item.id` (the
 * preserved record id is the PK): a record whose id already exists is skipped, not
 * re-written — so re-running is idempotent AND user edits to existing items aren't
 * clobbered. Returns created/skipped counts + the created item ids.
 */
/**
 * Whether a mapped record already carries an AI read. Mirrors the frontend's
 * `itemRenderState` so an item is never shown as loading when it has nothing left to
 * load. Covers both legacy board shapes: Inspiration stores flat dotted keys
 * (`meta.tier`), Library stores undotted ones (`summary`). A predicate that knows only
 * one shape strands the other board's items at 'pending' forever.
 */
const ENRICHMENT_KEYS = ['meta.tier', 'design.steal_this', 'meta.tags', 'summary', 'topics', 'key_points'];

function hasEnrichment(fields: unknown): boolean {
  if (!fields || typeof fields !== 'object') return false;
  const f = fields as Record<string, unknown>;
  return ENRICHMENT_KEYS.some((k) => {
    const v = f[k];
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === 'string' ? v.length > 0 : v != null;
  });
}

export async function importRecords({ handle, boardId, records }: ImportRecordsArgs): Promise<ImportResult> {
  const mapper = MAPPERS[boardId] ?? mapGeneric;
  const result: ImportResult = { created: 0, skipped: 0, itemIds: [] };
  for (const [i, r] of records.entries()) {
    // Fail loud on a missing id — it is the idempotency/dedupe key. Without this,
    // id-less records would all collapse to the string "undefined" and overwrite
    // each other (matters for Story 3.3's untrusted in-memory payloads).
    if (r.id === undefined || r.id === null || String(r.id).length === 0) {
      throw new Error(`Record at index ${i} for board "${boardId}" is missing a required \`id\``);
    }
    const id = String(r.id);
    const existing = handle.db.select().from(items).where(eq(items.id, id)).get();
    if (existing) {
      result.skipped += 1;
      continue;
    }
    const { item, assets: itemAssets } = mapper(r, boardId);
    // Imported records were enriched in the JSON era, so they arrive complete. Without
    // this they inherit the schema default 'pending' and are indistinguishable from an
    // item still being captured — which is exactly the signal the capture UI reads.
    const status = hasEnrichment(item.fields) ? 'done' : item.status;
    await writeItem(handle, { ...item, status }, itemAssets);
    result.created += 1;
    result.itemIds.push(id);
  }
  return result;
}

export interface ImportFlatJsonArgs {
  handle: DbHandle;
  inspirationPath: string;
  libraryPath: string;
  /** Optional logger; defaults to console for the one-shot CLI. */
  logger?: { info: (msg: string) => void };
}

function readRecords(path: string, logger: { info: (msg: string) => void }): RawRecord[] | null {
  if (!existsSync(path)) {
    logger.info(`[import] skipping ${path} — file not found`);
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    logger.info(`[import] skipping ${path} — not a top-level array`);
    return null;
  }
  return parsed as RawRecord[];
}

/**
 * Layer (b): read the prototype flat files and import them under the two seeded
 * boards. Missing files are skipped with a log line (a fresh self-hoster has none).
 */
export async function importFlatJson({
  handle,
  inspirationPath,
  libraryPath,
  logger = { info: (m: string) => console.log(m) },
}: ImportFlatJsonArgs): Promise<{ inspiration: number; library: number }> {
  const result = { inspiration: 0, library: 0 };

  const insp = readRecords(inspirationPath, logger);
  if (insp) result.inspiration = (await importRecords({ handle, boardId: INSPIRATION_BOARD_ID, records: insp })).created;

  const lib = readRecords(libraryPath, logger);
  if (lib) result.library = (await importRecords({ handle, boardId: LIBRARY_BOARD_ID, records: lib })).created;

  logger.info(`[import] imported ${result.inspiration} inspiration + ${result.library} library items`);
  return result;
}
