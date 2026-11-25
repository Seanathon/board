import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import { initDb } from '../db/index.js';
import { boards, items } from '../db/schema.js';
import { createCaptureRegistry } from '../capture/adapter.js';
import { disabledLlm } from '../skills/types.js';
import type { TimeoutFn } from '../db/queue.js';
import { runCaptureEnrichJob } from './pipeline.js';

const neverFires: TimeoutFn = () => () => {};

describe('runCaptureEnrichJob non-blocking accept (Story 8.4 AC4)', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-pipeline-'));
    handle = initDb(join(dir, 'p.db'));
    handle.db.insert(boards).values({ id: 'b', name: 'B', view: 'grid', descriptor: { view: 'grid', ingest_mode: 'test', enrichment_prompt: '', fields: [] } }).run();
    handle.db.insert(items).values({ id: 'it', boardId: 'b', source: 'https://x.example' }).run();
  });
  after(() => { handle.sqlite.close(); rmSync(dir, { recursive: true, force: true }); });

  // AC4 — the accept enqueues and does NOT run capture synchronously (ordering, not timing)
  it('does not run capture before returning (enqueue + return)', async () => {
    let captureRan = false;
    const reg = createCaptureRegistry();
    reg.register({ ingestMode: 'test', fetch: async () => { captureRan = true; return { fields: {}, assets: [] }; } });

    const p = runCaptureEnrichJob(handle, {
      itemId: 'it', boardId: 'b', source: 'https://x.example', ingestMode: 'test',
      registry: reg, llm: disabledLlm, timeoutFn: neverFires,
    });
    // Synchronously after the call returns, capture must NOT have run yet.
    assert.equal(captureRan, false, 'capture must not run synchronously — accept is non-blocking');

    await p; // the job drains on the worker
    assert.equal(captureRan, true, 'capture runs asynchronously on the worker');
    // disabled enrichment → item resolves done (not error)
    assert.equal(handle.db.select().from(items).where(eq(items.id, 'it')).get()?.status, 'done');
  });
});

it('timed-out enrichment holds original job lane until transport teardown finishes', async () => {
  const { enqueueJob } = await import('../db/queue.js');
  const { setBrowserDiscovery } = await import('../db/board-options.js');
  const handle = initDb(':memory:'); let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  try {
    handle.db.insert(boards).values({ id: 'b', name: 'B', view: 'list', descriptor: { view: 'list', ingest_mode: 'url-readable', enrichment_prompt: '', fields: [{ key: 'custom', label: 'Custom', type: 'text', enrichable: true }] } }).run();
    handle.db.insert(items).values({ id: 'i', boardId: 'b', source: 'https://example.com/', fields: { text: 'Captured evidence. '.repeat(60) } }).run();
    await setBrowserDiscovery(handle, 'b', true);
    let entered!: () => void; const entry = new Promise<void>(r => { entered = r; });
    const work = runCaptureEnrichJob(handle, { itemId: 'i', boardId: 'b', registry: createCaptureRegistry(), timeoutMs: 40,
      llm: { async complete(_p, _s, context) { entered(); await new Promise<void>(r => context!.signal!.addEventListener('abort', () => r(), { once: true })); await gate; throw new Error('disposed'); } } });
    await entry; assert.equal((await work).timedOut, true);
    let next = false;
    const second = enqueueJob({ type: 'enrich', timeoutMs: 1000, run: async () => { next = true; } });
    await new Promise(r => setImmediate(r)); assert.equal(next, false);
    release(); await second; assert.equal(next, true);
  } finally { release(); handle.sqlite.close(); }
});
