import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import { initDb } from '../db/index.js';
import { boards, assets, items } from '../db/schema.js';
import { runItemJob, type TimeoutFn } from '../db/queue.js';
import { statusHub, type StatusEvent } from '../sse.js';
import {
  createCaptureRegistry,
  dispatchCapture,
  runCaptureForItem,
  type CaptureAdapter,
} from './adapter.js';

const neverFires: TimeoutFn = () => () => {};

const testAdapter: CaptureAdapter = {
  ingestMode: 'test',
  fetch: async (source) => ({
    fields: { captured: typeof source === 'string' ? source : 'upload' },
    assets: [{ kind: 'shot', path: '/data/screenshots/x.png' }],
  }),
};

const manualAdapter: CaptureAdapter = {
  ingestMode: 'manual',
  fetch: async (source) => ({
    fields: {},
    assets: [{ kind: 'image', path: typeof source === 'string' ? source : '/uploaded.png' }],
  }),
};

describe('capture dispatch (Story 6.1)', () => {
  // AC 1 — dispatcher resolves the adapter by ingest_mode and returns {fields, assets}
  it('dispatches to the adapter matching the ingest_mode', async () => {
    const reg = createCaptureRegistry();
    reg.register(testAdapter);
    const out = await dispatchCapture(reg, 'test', 'https://x.example', { itemId: 'i', boardId: 'b' });
    assert.deepEqual(out.fields, { captured: 'https://x.example' });
    assert.equal(out.assets.length, 1);
    assert.equal(out.assets[0].kind, 'shot');
  });

  // AC 1 — unknown ingest_mode → clear error
  it('throws a clear error for an unknown ingest_mode', async () => {
    const reg = createCaptureRegistry();
    await assert.rejects(() => dispatchCapture(reg, 'nope', 's', { itemId: 'i', boardId: 'b' }), /ingest_mode|adapter/i);
  });

  // AC 2 — a non-URL (manual upload) source works (item isn't URL-bound)
  it('supports a non-URL upload source', async () => {
    const reg = createCaptureRegistry();
    reg.register(manualAdapter);
    const out = await dispatchCapture(reg, 'manual', { buffer: Buffer.from('img') }, { itemId: 'i', boardId: 'b' });
    assert.equal(out.assets[0].kind, 'image');
  });
});

describe('runCaptureForItem idempotency (Story 6.1)', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-capture-'));
    handle = initDb(join(dir, 'c.db'));
    handle.db.insert(boards).values({ id: 'tb', name: 'T', view: 'grid', descriptor: { fields: [], enrichment_prompt: '', view: 'grid', ingest_mode: 'test' } }).run();
    handle.db.insert(items).values({ id: 'it', boardId: 'tb', source: 'https://x.example' }).run();
  });
  after(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // AC 3/5 — re-capturing the same item id replaces, does not duplicate the asset
  it('does not duplicate the asset on re-capture (idempotent by item id)', async () => {
    const reg = createCaptureRegistry();
    reg.register(testAdapter);

    await runCaptureForItem(handle, reg, { itemId: 'it', boardId: 'tb', source: 'https://x.example' });
    await runCaptureForItem(handle, reg, { itemId: 'it', boardId: 'tb', source: 'https://x.example' });

    const assetRows = handle.db.select().from(assets).where(eq(assets.itemId, 'it')).all();
    assert.equal(assetRows.length, 1, 'asset must not be duplicated on re-capture');
    const itemRow = handle.db.select().from(items).where(eq(items.id, 'it')).get();
    assert.equal((itemRow?.fields as { captured?: string }).captured, 'https://x.example', 'fields merged from capture');
    // still exactly one item
    assert.equal(handle.db.select().from(items).all().length, 1);
  });

  // captured system-column keys (title) land on the COLUMN, not the fields bag
  it('lifts a captured `title` into the item.title column (not fields)', async () => {
    const reg = createCaptureRegistry();
    reg.register({
      ingestMode: 'test',
      fetch: async () => ({ fields: { title: 'Captured Title', body: 'prose' }, assets: [] }),
    });
    handle.db.insert(items).values({ id: 'it2', boardId: 'tb', source: 'https://y.example' }).run();
    await runCaptureForItem(handle, reg, { itemId: 'it2', boardId: 'tb', source: 'https://y.example' });
    const row = handle.db.select().from(items).where(eq(items.id, 'it2')).get();
    assert.equal(row?.title, 'Captured Title', 'title lifted to the system column');
    assert.equal((row?.fields as Record<string, unknown>).title, undefined, 'title not duplicated in fields');
    assert.equal((row?.fields as Record<string, unknown>).body, 'prose', 'non-system fields stay in fields');
  });

  // Regression: capture run INSIDE a worker job must NOT deadlock (writeItemDirect,
  // not the enqueueing writeItem). Without the fix this hangs forever.
  it('runs capture inside a worker job without deadlocking', async () => {
    const reg = createCaptureRegistry();
    reg.register({ ingestMode: 'test', fetch: async () => ({ fields: { body: 'injob' }, assets: [{ kind: 'shot', path: '/p.png' }] }) });
    handle.db.insert(items).values({ id: 'job-it', boardId: 'tb', source: 'https://j.example' }).run();
    const result = await runItemJob(handle, {
      itemId: 'job-it',
      type: 'capture',
      timeoutMs: 60_000,
      timeoutFn: neverFires,
      work: (signal) => runCaptureForItem(handle, reg, { itemId: 'job-it', boardId: 'tb', source: 'https://j.example', signal }),
    });
    assert.equal(result.ok, true);
    const row = handle.db.select().from(items).where(eq(items.id, 'job-it')).get();
    assert.equal(row?.status, 'done');
    assert.equal((row?.fields as Record<string, unknown>).body, 'injob');
  });
});

// Follow-up (SSRF): the dispatchCapture seam guards a user-supplied URL BEFORE the adapter
// fetches it — so create/share/assign/refetch can't be steered at an internal address.
describe('dispatchCapture — SSRF guard at the URL seam', () => {
  it('blocks a private/loopback URL before the adapter runs', async () => {
    const registry = createCaptureRegistry();
    let fetched = false;
    registry.register({ ingestMode: 'url-readable', fetch: async () => { fetched = true; return { fields: {}, assets: [] }; } });
    await assert.rejects(
      dispatchCapture(registry, 'url-readable', 'http://169.254.169.254/latest/meta-data/', {} as never),
      /BlockedUrlError|blocked/i,
    );
    assert.equal(fetched, false, 'the adapter fetch never ran for a blocked URL');
  });

  it('lets a manual-upload buffer source through (no URL to guard)', async () => {
    const registry = createCaptureRegistry();
    let fetched = false;
    registry.register({ ingestMode: 'manual-upload', fetch: async () => { fetched = true; return { fields: {}, assets: [] }; } });
    await dispatchCapture(registry, 'manual-upload', { buffer: Buffer.from('img') }, {} as never);
    assert.equal(fetched, true, 'buffer sources skip the URL guard');
  });
});

// Story: progressive reveal. Capture writes title + screenshot BEFORE the LLM runs,
// but that write published nothing, so the browser could not show the page until
// enrichment finished (or failed). Capture now announces itself.
describe('runCaptureForItem publishes a captured event (progressive reveal)', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-capture-evt-'));
    handle = initDb(join(dir, 'c.db'));
    handle.db.insert(boards).values({ id: 'tb', name: 'T', view: 'grid', descriptor: { fields: [], enrichment_prompt: '', view: 'grid', ingest_mode: 'test' } }).run();
    handle.db.insert(items).values({ id: 'it', boardId: 'tb', source: 'https://x.example' }).run();
  });
  after(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('publishes `captured` with the title so the card fills before enrichment', async () => {
    const seen: StatusEvent[] = [];
    const unsubscribe = statusHub.subscribe({
      write: (frame) => {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) seen.push(JSON.parse(line.slice(6)) as StatusEvent);
      },
    });
    try {
      const reg = createCaptureRegistry();
      reg.register({
        ingestMode: 'test',
        fetch: async () => ({ fields: { title: 'Captured Title' }, assets: [] }),
      });
      await runCaptureForItem(handle, reg, { itemId: 'it', boardId: 'tb', source: 'https://x.example' });
    } finally {
      unsubscribe();
    }

    const captured = seen.find((e) => e.status === 'captured');
    assert.ok(captured, 'capture must publish a `captured` event');
    assert.equal(captured.itemId, 'it');
    assert.equal(captured.boardId, 'tb');
    assert.equal(captured.title, 'Captured Title', 'the event carries the captured title');
  });
});
