import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';

import { initDb } from './index.js';
import { items, assets, boards } from './schema.js';
import { seed, INSPIRATION_BOARD_ID, LIBRARY_BOARD_ID } from './seed.js';
import { importFlatJson, importRecords } from './importer.js';

const here = dirname(fileURLToPath(import.meta.url));
const inspirationPath = join(here, '__fixtures__', 'bookmarks.sample.json');
const libraryPath = join(here, '__fixtures__', 'library.sample.json');

describe('flat-JSON importer (Story 1.5)', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-import-'));
    handle = initDb(join(dir, 'import.db'));
    seed(handle.db);
    await importFlatJson({ handle, inspirationPath, libraryPath });
  });
  after(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ftsCount = (term: string): number =>
    (handle.sqlite.prepare('SELECT COUNT(*) c FROM item_fts WHERE item_fts MATCH ?').get(term) as { c: number }).c;

  // AC 1 — each record → item under the correct board
  it('imports each record under the correct seeded board', () => {
    const insp = handle.db.select().from(items).where(eq(items.boardId, INSPIRATION_BOARD_ID)).all();
    const lib = handle.db.select().from(items).where(eq(items.boardId, LIBRARY_BOARD_ID)).all();
    assert.equal(insp.length, 2);
    assert.equal(lib.length, 2);
  });

  // AC 2 — assets linked for inspiration, none for library
  it('links a screenshot asset for inspiration; none for library', () => {
    const a = handle.db.select().from(assets).where(eq(assets.itemId, 'acme-111')).all();
    assert.equal(a.length, 1);
    assert.equal(a[0]?.kind, 'screenshot');
    assert.equal(a[0]?.path, 'screenshots/acme-111.png');

    const libAssets = handle.db.select().from(assets).where(eq(assets.itemId, 'ragpaper-333')).all();
    assert.equal(libAssets.length, 0);
  });

  // AC 1 — sampled field fidelity + system-column mapping
  it('maps fields, system columns and analysis metadata faithfully', () => {
    const acme = handle.db.select().from(items).where(eq(items.id, 'acme-111')).get();
    const f = acme?.fields as Record<string, unknown>;
    assert.equal(acme?.source, 'https://acme.example');
    assert.equal(acme?.title, 'Acme');
    assert.equal(acme?.favorite, 1); // system column, from record.favorite=true
    assert.equal(f['meta.audience'], 'b2b');
    assert.deepEqual(f['meta.tags'], ['dark-theme', 'monospace']);
    assert.equal(f['design.design_system_score'], 'systematic');
    assert.equal(f['favorite_reason'], 'great restraint');
    // favorite / notes / title are NOT in the fields bag (system columns)
    for (const sys of ['favorite', 'notes', 'title']) assert.equal(f[sys], undefined);

    const paper = handle.db.select().from(items).where(eq(items.id, 'ragpaper-333')).get();
    const pf = paper?.fields as Record<string, unknown>;
    assert.equal(paper?.notes, 'revisit the eval section'); // system column
    assert.equal(paper?.analysisProvider, 'claude');
    assert.equal(paper?.analysisModel, 'claude-opus-4');
    assert.equal(pf['summary'], 'gribblesummary about retrieval augmented generation and why it matters');
    assert.deepEqual(pf['topics'], ['ai', 'rag', 'retrieval']);
  });

  // AC 1 — `added` carried into created_at
  it('carries `added` into created_at', () => {
    const acme = handle.db.select().from(items).where(eq(items.id, 'acme-111')).get();
    assert.equal(acme?.createdAt, Math.floor(Date.parse('2025-01-15') / 1000));
  });

  // AC 3 — items are searchable (importer went through the FTS-maintaining write path)
  it('populates search_blob and makes items searchable', () => {
    assert.equal(ftsCount('zqxwvdesign'), 1);
    assert.equal(ftsCount('gribblesummary'), 1);
    assert.equal(ftsCount('nonexistentqqq'), 0);
  });

  // AC 4 — idempotent at item AND FTS level
  it('is idempotent on re-run (no dup items, FTS hit stays 1)', async () => {
    await importFlatJson({ handle, inspirationPath, libraryPath });
    const total = handle.db.select().from(items).all();
    assert.equal(total.length, 4, 'no duplicate items on second run');
    const acmeAssets = handle.db.select().from(assets).where(eq(assets.itemId, 'acme-111')).all();
    assert.equal(acmeAssets.length, 1, 'no duplicate assets on second run');
    assert.equal(ftsCount('zqxwvdesign'), 1, 'FTS hit must stay exactly 1, not 2');
  });
});

// Hardening — a record missing its id (the dedupe key) fails loud rather than
// silently collapsing every id-less record onto "undefined".
describe('importRecords id guard (Story 1.5)', () => {
  it('throws on a record missing a required id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-oss-import-id-'));
    const handle = initDb(join(dir, 'g.db'));
    seed(handle.db);
    await assert.rejects(
      importRecords({ handle, boardId: LIBRARY_BOARD_ID, records: [{ title: 'no id here' }] }),
      /missing a required `id`/,
    );
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// AC 4 / NFR-4 — graceful when files are absent
describe('importer graceful absence (Story 1.5)', () => {
  it('no-ops cleanly when flat files do not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-oss-import-missing-'));
    const handle = initDb(join(dir, 'm.db'));
    seed(handle.db);
    await assert.doesNotReject(
      importFlatJson({
        handle,
        inspirationPath: join(dir, 'nope-bookmarks.json'),
        libraryPath: join(dir, 'nope-library.json'),
      }),
    );
    assert.equal(handle.db.select().from(items).all().length, 0);
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// An imported record arrives with its enrichment already done (it was enriched in the
// JSON era), but `status` was never set, so it defaulted to 'pending' and stayed
// there forever. That left 150 fully-populated items indistinguishable from items
// still being captured, which is the signal the loading UI keys off.
describe('imported item status', () => {
  it('stores an already-enriched record as done, not pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-oss-import-status-'));
    const handle = initDb(join(dir, 'c.db'));
    try {
      seed(handle.db);
      await importRecords({
        handle,
        boardId: INSPIRATION_BOARD_ID,
        records: [{
          id: 'imported-1',
          url: 'https://example.com',
          title: 'Enriched Already',
          meta: { tier: 'reference', tags: ['dark-theme'], audience: 'developer' },
          design: { steal_this: 'Do the thing' },
        }],
      });
      const row = handle.db.select().from(items).where(eq(items.id, 'imported-1')).get();
      assert.equal(row?.status, 'done', 'an already-enriched import must not sit at pending');
    } finally {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Library enrichment lives under a different set of keys than Inspiration's
  // meta.*/design.* — a predicate that only knows one board's shape leaves the other
  // board's items stranded at 'pending'.
  it('recognizes library-shaped enrichment too, not just the inspiration shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-oss-import-lib-status-'));
    const handle = initDb(join(dir, 'c.db'));
    try {
      seed(handle.db);
      await importRecords({
        handle,
        boardId: LIBRARY_BOARD_ID,
        records: [{
          id: 'lib-1',
          url: 'https://arxiv.org/abs/1',
          title: 'A Paper',
          summary: 'It compresses reasoning traces.',
          topics: ['llm', 'compression'],
          type: 'paper',
        }],
      });
      const row = handle.db.select().from(items).where(eq(items.id, 'lib-1')).get();
      assert.equal(row?.status, 'done', 'an enriched library import must not sit at pending');
    } finally {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A composed board has no hand-written mapper, so importRecords used to throw
// `No importer mapping registered` — meaning export emitted boards that nothing
// could read back. The generic mapper is the inverse of export's toRecord: system
// columns are lifted, and any nested group is re-flattened to dotted field keys.
describe('generic mapper (any board, not just the seeded two)', () => {
  it('round-trips an exported record into a composed board', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-oss-generic-map-'));
    const handle = initDb(join(dir, 'c.db'));
    try {
      seed(handle.db);
      handle.db.insert(boards).values({
        id: 'wishlist', name: 'Wish List', view: 'grid',
        descriptor: { name: 'Wish List', fields: [], view: 'grid', ingest_mode: 'url-screenshot' } as never,
      }).run();

      await importRecords({
        handle,
        boardId: 'wishlist',
        records: [{
          id: 'w1',
          url: 'https://example.com/thing',
          title: 'A Thing',
          favorite: true,
          notes: 'mine',
          added: '2026-01-02T00:00:00.000Z',
          analysis_agent: 'claude',
          screenshot: 'screenshots/w1.png',
          gift: { price: 42, store: 'somewhere' },
          priority: 'high',
        }],
      });

      const row = handle.db.select().from(items).where(eq(items.id, 'w1')).get();
      assert.ok(row, 'the item must be created on a board with no hand-written mapper');
      assert.equal(row.title, 'A Thing');
      assert.equal(row.source, 'https://example.com/thing');
      assert.equal(row.favorite, 1);
      assert.equal(row.notes, 'mine');
      assert.equal(row.analysisProvider, 'claude');
      const f = row.fields as Record<string, unknown>;
      assert.equal(f['gift.price'], 42, 'nested groups re-flatten to dotted keys');
      assert.equal(f['gift.store'], 'somewhere');
      assert.equal(f['priority'], 'high', 'top-level custom fields survive');
      assert.equal(f['url'], undefined, 'system columns must not leak into fields');
      assert.equal(f['screenshot'], undefined);

      const shots = handle.db.select().from(assets).where(eq(assets.itemId, 'w1')).all();
      assert.equal(shots.length, 1, 'the screenshot asset is recreated');
      assert.equal(shots[0].path, 'screenshots/w1.png');
    } finally {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
