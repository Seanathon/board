import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import { initDb } from './index.js';
import { boards, items } from './schema.js';
import { runItemJob, reconcileInterruptedItems, cleanErrorReason, describeJobError, type TimeoutFn } from './queue.js';
import { EnrichmentDisabledError } from '../skills/types.js';
import { LLMTransportError } from '../llm/provider.js';

const neverFires: TimeoutFn = () => () => {};
function manualTimeout(): { fn: TimeoutFn; fire: () => void } {
  let cb: (() => void) | null = null;
  return { fn: (c) => { cb = c; return () => (cb = null); }, fire: () => cb?.() };
}
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('item status lifecycle (Story 5.2)', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-status-'));
    handle = initDb(join(dir, 's.db'));
    handle.db.insert(boards).values({ id: 'b', name: 'B', view: 'grid' }).run();
  });
  after(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seedItem = (id: string) => handle.db.insert(items).values({ id, boardId: 'b', source: 'x' }).run();
  const statusOf = (id: string) => handle.db.select().from(items).where(eq(items.id, id)).get();

  // AC 1 — pending → processing → done
  it('moves pending → processing → done on success', async () => {
    seedItem('ok');
    let sawProcessing = false;
    await runItemJob(handle, {
      itemId: 'ok',
      type: 'enrich',
      timeoutMs: 60_000,
      timeoutFn: neverFires,
      work: async () => {
        sawProcessing = statusOf('ok')?.status === 'processing';
      },
    });
    assert.equal(sawProcessing, true, 'status must be processing while work runs');
    assert.equal(statusOf('ok')?.status, 'done');
  });

  // AC 2 — throw → error + clean, mapped reason (no stack/secret)
  it('maps a thrown error to status=error + a clean reason', async () => {
    seedItem('boom');
    await runItemJob(handle, {
      itemId: 'boom',
      type: 'enrich',
      timeoutMs: 60_000,
      timeoutFn: neverFires,
      work: async () => {
        throw new LLMTransportError('ECONNREFUSED secret-host at /Users/x/llm.ts:1');
      },
    });
    const row = statusOf('boom');
    assert.equal(row?.status, 'error');
    assert.equal(row?.errorReason, 'could not reach the AI provider');
    assert.doesNotMatch(row?.errorReason ?? '', /secret-host|llm\.ts:1/, 'no raw error/stack leaked');
  });

  it('names malformed model output instead of "processing failed", and logs the real cause', async () => {
    seedItem('syntax');
    const logged: string[] = [];
    await runItemJob(handle, {
      itemId: 'syntax',
      type: 'enrich',
      timeoutMs: 60_000,
      timeoutFn: neverFires,
      logger: { error: (m) => logged.push(m) },
      work: async () => {
        JSON.parse('{"a":"1" "b"}');
      },
    });
    const row = statusOf('syntax');
    assert.equal(row?.status, 'error');
    assert.equal(row?.errorReason, 'AI returned invalid output');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /item syntax \(enrich\) failed: SyntaxError: /);
  });

  it('maps validation errors to the same user-safe reason; unknown errors stay generic', () => {
    assert.equal(cleanErrorReason(Object.assign(new Error('x'), { name: 'ZodError' })), 'AI returned invalid output');
    assert.equal(cleanErrorReason(new Error('boom')), 'processing failed');
  });

  it('logs failure detail one-line, bounded and with credentials masked', () => {
    const line = describeJobError(
      new Error('request failed\nAuthorization: Bearer abcdef0123456789 api_key=sk-live-1234567890abcdef ' + 'x'.repeat(500)),
    );
    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(line, /abcdef0123456789|1234567890abcdef/);
    assert.ok(line.length <= 330);
    assert.match(line, /^Error: request failed/);
  });

  // AC 3 — EnrichmentDisabledError → done (NOT error)
  it('classifies EnrichmentDisabledError as done, not error', async () => {
    seedItem('disabled');
    await runItemJob(handle, {
      itemId: 'disabled',
      type: 'enrich',
      timeoutMs: 60_000,
      timeoutFn: neverFires,
      work: async () => {
        throw new EnrichmentDisabledError();
      },
    });
    const row = statusOf('disabled');
    assert.equal(row?.status, 'done', 'a no-AI install must not show error cards');
    assert.equal(row?.errorReason, null);
  });

  // AC 2 — timeout → error, not stuck processing
  it('marks a timed-out job error (not stuck processing)', async () => {
    seedItem('hang');
    const t = manualTimeout();
    const p = runItemJob(handle, {
      itemId: 'hang',
      type: 'capture',
      timeoutMs: 50,
      timeoutFn: t.fn,
      work: () => new Promise<void>(() => {}), // never resolves
    });
    await new Promise((r) => setImmediate(r));
    t.fire();
    await p;
    const row = statusOf('hang');
    assert.equal(row?.status, 'error');
    assert.equal(row?.errorReason, 'timed out');
  });

  // AC 2 — the timeout status is AUTHORITATIVE even if the abandoned work settles late
  it('keeps status=error when the abandoned work resolves after a timeout', async () => {
    seedItem('late');
    const t = manualTimeout();
    const d = deferred();
    const p = runItemJob(handle, {
      itemId: 'late',
      type: 'capture',
      timeoutMs: 50,
      timeoutFn: t.fn,
      work: async () => { await d.promise; }, // resolves only when we let it, after the timeout
    });
    await tick();
    t.fire();
    await p;
    assert.equal(statusOf('late')?.status, 'error');
    assert.equal(statusOf('late')?.errorReason, 'timed out');

    d.resolve(); // late work completion must NOT clobber the terminal error status
    await tick();
    await tick();
    assert.equal(statusOf('late')?.status, 'error', 'timeout status must survive late work resolution');
    assert.equal(statusOf('late')?.errorReason, 'timed out');
  });

  // AC 4 — boot reconciliation: no item stuck processing across a crash
  it('reconciles orphaned processing items to error on boot', () => {
    seedItem('orphan');
    handle.db.update(items).set({ status: 'processing' }).where(eq(items.id, 'orphan')).run();
    const changed = reconcileInterruptedItems(handle);
    assert.ok(changed >= 1);
    const row = statusOf('orphan');
    assert.equal(row?.status, 'error');
    assert.equal(row?.errorReason, 'interrupted');
  });
});
