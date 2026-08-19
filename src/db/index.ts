import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { config } from '../config.js';
import * as schema from './schema.js';

// Story 1.1 — SQLite connection + WAL + FK enforcement + idempotent bootstrap.
//
// Schema-apply approach: an idempotent raw-SQL bootstrap (CREATE TABLE/INDEX IF NOT
// EXISTS) rather than a drizzle-kit migration pipeline. This is permitted by the
// story (Task 4) and is deliberate: Story 1.4 must inject an FTS5 virtual table +
// triggers as raw SQL (`CREATE VIRTUAL TABLE … USING fts5(...)`), which Drizzle
// cannot model declaratively. A raw bootstrap leaves that door open. The DDL below
// mirrors db/schema.ts exactly; the schema round-trip test guards against drift.

// Transient-lock wait budget. Config-overridable later. // Story 2.1 env
const BUSY_TIMEOUT_MS = 5000;

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS board (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  view TEXT NOT NULL,
  descriptor TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS setting (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS item (
  id TEXT PRIMARY KEY NOT NULL,
  board_id TEXT NOT NULL REFERENCES board(id),
  source TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_reason TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  fields TEXT,
  search_blob TEXT,
  analysis_provider TEXT,
  analysis_model TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS asset (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES item(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  hash TEXT,
  captured_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_item_board_id ON item(board_id);
CREATE INDEX IF NOT EXISTS idx_item_status ON item(status);
CREATE INDEX IF NOT EXISTS idx_item_favorite ON item(favorite);
CREATE INDEX IF NOT EXISTS idx_item_created_at ON item(created_at);

-- Story 14.3 — additive override-signal store (IF NOT EXISTS → existing DBs gain the
-- table on next boot; existing tables/rows are untouched, NFR-BC).
CREATE TABLE IF NOT EXISTS suggestion_override (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES item(id),
  suggested_board_id TEXT,
  chosen_board_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Story 15.1 — additive saved cross-board lens (IF NOT EXISTS → existing DBs gain it on
-- next boot; existing tables/rows untouched, NFR-BC). "view" and "order" are SQL
-- keywords → quoted here (the raw DDL is hand-written; Drizzle escapes its own SQL).
CREATE TABLE IF NOT EXISTS "view" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  filter TEXT NOT NULL,
  "order" TEXT,
  captions TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

// Story 1.4 — FTS5 over a SINGLE synthetic search_blob (not per-field columns), so
// any descriptor-defined board is searchable with no schema change. Drizzle cannot
// model FTS5 declaratively, so this is raw SQL. Standalone (not external-content)
// table: `item_id` is stored UNINDEXED for lookup; the writer (db/queue.ts)
// maintains it transactionally via plain INSERT/DELETE keyed on item_id.
const FTS_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS item_fts USING fts5(item_id UNINDEXED, search_blob);`;

export interface DbHandle {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
}

/**
 * Open (creating if necessary) a SQLite database at `path`, enable WAL and FK
 * enforcement, apply the idempotent schema bootstrap, and return both the Drizzle
 * handle and the raw better-sqlite3 connection.
 *
 * Pass an explicit path in tests (a temp file under os.tmpdir()).
 */
export function initDb(path: string): DbHandle {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  // WAL is load-bearing (NFR-2). FK enforcement is OFF by default per connection in
  // SQLite — without this, AC 4 enforcement silently does not happen.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // busy_timeout (Story 1.3, NFR-2) covers transient lock waits (e.g. a WAL
  // checkpoint) so SQLITE_BUSY never surfaces to a caller. The single-writer queue
  // (db/queue.ts) handles logical write ordering; both are needed.
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  sqlite.exec(BOOTSTRAP_SQL);
  // FTS5 is not in every SQLite build. Fail fast with an actionable message
  // (Epic 11 packaging on Debian/LXC must ship an FTS5-enabled build).
  try {
    sqlite.exec(FTS_SQL);
  } catch (err) {
    throw new Error(
      'SQLite was built without FTS5 (full-text search). Install an FTS5-enabled ' +
        `SQLite/better-sqlite3 build. Underlying error: ${(err as Error).message}`,
    );
  }
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

let _handle: DbHandle | undefined;

/** Lazily-initialized process-wide DB handle, rooted at `config.dbPath` (DATA_DIR). */
export function getDb(): DbHandle {
  if (!_handle) {
    _handle = initDb(config.dbPath);
  }
  return _handle;
}
