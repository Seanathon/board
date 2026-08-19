import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// Story 1.1 — board / item / asset tables (schema-as-data foundation).
//
// Design notes (see docs/bmad/stories/1-1-sqlite-drizzle-schema.md):
// - `id` columns are caller-supplied TEXT primary keys (NOT autoincrement) so 1.2
//   can seed stable "inspiration"/"library" ids and 1.5 can preserve original ids.
// - `created_at`/`updated_at`/`captured_at` accept an explicit value on insert and
//   fall back to unixepoch() when omitted (AC 3).
// - `board.descriptor` and `item.fields` are JSON (text mode:'json') so they
//   round-trip as structured objects (AC 4).
// - `search_blob` is a plain text column here; the FTS5 virtual table is Story 1.4.
// - Per-field columns are intentionally avoided — one `item.fields` JSON bag for all
//   boards (AD9, schema-as-data). Do NOT add inspiration_item / library_item tables.

export const boards = sqliteTable('board', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  view: text('view').notNull(),
  descriptor: text('descriptor', { mode: 'json' }),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
});

export const items = sqliteTable(
  'item',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    source: text('source'),
    title: text('title'),
    status: text('status').notNull().default('pending'),
    errorReason: text('error_reason'),
    favorite: integer('favorite').notNull().default(0),
    notes: text('notes'),
    fields: text('fields', { mode: 'json' }),
    searchBlob: text('search_blob'),
    analysisProvider: text('analysis_provider'),
    analysisModel: text('analysis_model'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    // The four system-column indexes (AC 5 / NFR-2). json_extract/tags index
    // promotion is deferred (PRD Open Question #1) — do not add it here.
    index('idx_item_board_id').on(t.boardId),
    index('idx_item_status').on(t.status),
    index('idx_item_favorite').on(t.favorite),
    index('idx_item_created_at').on(t.createdAt),
  ],
);

export const assets = sqliteTable('asset', {
  id: text('id').primaryKey(),
  itemId: text('item_id')
    .notNull()
    .references(() => items.id),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  width: integer('width'),
  height: integer('height'),
  hash: text('hash'),
  capturedAt: integer('captured_at').notNull().default(sql`(unixepoch())`),
});

// Story 14.3 — additive override-signal store. Records when a user assigned an Inbox
// item to a DIFFERENT board than the AI suggested (suggested vs chosen), for future
// suggestion quality. Append-only signal; NEVER a reshape of item/board rows.
export const suggestionOverrides = sqliteTable('suggestion_override', {
  id: text('id').primaryKey(),
  itemId: text('item_id')
    .notNull()
    .references(() => items.id),
  suggestedBoardId: text('suggested_board_id'),
  // Intentionally NOT FK-constrained: the override is a historical signal that should
  // survive even if the chosen board is later deleted (item_id keeps its FK so a bad
  // item is rejected). Signal-only data.
  chosenBoardId: text('chosen_board_id').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
});

export type SuggestionOverride = typeof suggestionOverrides.$inferSelect;

// Story 15.1 — the additive `view` table: a saved cross-board LENS. A composed board is
// a row of JSON — `filter` (the live query) + an optional `order` overlay (pinned ids)
// + optional `captions` — NOT a join table and NOT m2m on `item`. Items keep one
// canonical home board (single-FK, D12); a view holds no copy of item content. `view`
// and `order` are SQL keywords — the raw BOOTSTRAP_SQL (db/index.ts) quotes them; Drizzle
// auto-escapes its own generated SQL.
export const views = sqliteTable('view', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** The live query that defines membership (resolved dynamically). */
  filter: text('filter', { mode: 'json' }).notNull(),
  /** Optional pin/reorder overlay: item-ids that sort first, in this order. */
  order: text('order', { mode: 'json' }),
  /** Optional per-item caption overlay. */
  captions: text('captions', { mode: 'json' }),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
});

// Runtime-editable configuration, kept in the SAME SQLite file as the collection so
// the "copy one file and walk away" promise stays true (a sidecar JSON would break it).
export const settings = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
});

export type Board = typeof boards.$inferSelect;
export type NewBoard = typeof boards.$inferInsert;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type View = typeof views.$inferSelect;
export type NewView = typeof views.$inferInsert;
