import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { initDb } from './index.js';
import { boards, items, assets } from './schema.js';
import { deleteItem, enqueueWrite, runItemJob, writeItem, type TimeoutFn } from './queue.js';
import { patchItemFields } from './item-actions.js';
import { beginItemLease, currentLeaseItem } from './item-lease.js';
import { runEnrichmentForItem } from '../enrichment/worker.js';
import { runCaptureEnrichJob } from '../enrichment/pipeline.js';
import { createCaptureRegistry, runCaptureForItem, type CaptureCtx } from '../capture/adapter.js';
import { uploadAssetForItem } from '../capture/manual-upload.js';
import { runSnapshotJob } from '../capture/url-snapshot.js';
import { snapshotFromHtml, writeSnapshotAsset } from './snapshot-asset.js';
import { tagSkill } from '../skills/tag.js';
import { wipeItemsSkill } from '../skills/wipe-items.js';
import { disabledLlm, type CompletionContext, type LLMProvider, type Ctx } from '../skills/types.js';

const never: TimeoutFn = () => () => {};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(r => setImmediate(r));
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'completion-guards-'));
  const handle = initDb(join(dir, 'test.sqlite'));
  const descriptor = { view: 'grid', ingest_mode: 'manual-upload', enrichment_prompt: '', fields: [
    { key: 'summary', label: 'Summary', type: 'text', enrichable: true },
    { key: 'tags', label: 'Tags', type: 'tags', enrichable: true },
    { key: 'annotation', label: 'Annotation', type: 'text', enrichable: false },
  ] };
  handle.db.insert(boards).values(['a', 'b'].map(id => ({ id, name: id, view: 'grid', descriptor }))).run();
  await writeItem(handle, { id: 'item', boardId: 'a', source: 'source-a', title: 'Original', status: 'done', fields: { text: 'Body', tags: ['initial'], annotation: 'Original' } });
  const row = () => handle.db.select().from(items).where(eq(items.id, 'item')).get();
  const ctx: Ctx = { db: handle, llm: disabledLlm, queue: { enqueueWrite }, logger: { info() {}, warn() {}, error() {} } };
  const cleanup = () => { handle.sqlite.close(); rmSync(dir, { recursive: true, force: true }); };
  return { handle, dir, descriptor, row, ctx, cleanup };
}
function delayedProvider() {
  const entered = deferred(), release = deferred(); let context: CompletionContext | undefined;
  const llm: LLMProvider = { async complete<T>(_prompt: string, _schema: unknown, ctx?: CompletionContext): Promise<T> {
    context = ctx; entered.resolve(); await release.promise;
    return { summary: 'Late summary', tags: ['generated'], title: 'Generated title' } as T;
  } };
  return { entered, release, llm, context: () => context };
}

for (const mutation of ['delete', 'recreate', 'source', 'source-aba', 'home', 'home-aba', 'descriptor', 'cancel', 'wipe-recreate'] as const) {
  test(`enrichment refuses stale ${mutation} completion without resurrection or moveback`, async () => {
    const f = await fixture(), p = delayedProvider(), ctrl = new AbortController();
    try {
      const original = f.row()!;
      const work = runEnrichmentForItem(f.handle, { itemId: 'item', llm: p.llm, signal: ctrl.signal });
      await p.entered.promise;
      if (mutation === 'delete' || mutation === 'recreate') await deleteItem(f.handle, 'item');
      if (mutation === 'recreate') await writeItem(f.handle, original);
      if (mutation === 'source' || mutation === 'source-aba') await writeItem(f.handle, { ...f.row()!, source: 'source-b' });
      if (mutation === 'source-aba') await writeItem(f.handle, { ...f.row()!, source: original.source });
      if (mutation === 'home' || mutation === 'home-aba') await writeItem(f.handle, { ...f.row()!, boardId: 'b' });
      if (mutation === 'home-aba') await writeItem(f.handle, { ...f.row()!, boardId: 'a' });
      if (mutation === 'descriptor') f.handle.db.update(boards).set({ descriptor: { ...f.descriptor, fields: [] } }).where(eq(boards.id, 'a')).run();
      if (mutation === 'cancel') ctrl.abort();
      if (mutation === 'wipe-recreate') {
        await wipeItemsSkill.run({ confirm: 'delete', screenshotsDir: f.dir }, f.ctx);
        await writeItem(f.handle, original);
      }
      const before = f.row(); p.release.resolve(); await work;
      assert.deepEqual(f.row(), before);
    } finally { p.release.resolve(); f.cleanup(); }
  });
}

test('provider receives trusted optional context; concurrent notes/tags/title/assets survive', async () => {
  const f = await fixture(), p = delayedProvider(), ctrl = new AbortController();
  try {
    const work = runEnrichmentForItem(f.handle, { itemId: 'item', llm: p.llm, signal: ctrl.signal });
    await p.entered.promise;
    const context = p.context()!;
    assert.deepEqual({ itemId: context.itemId, boardId: context.boardId, source: context.source }, { itemId: 'item', boardId: 'a', source: 'source-a' });
    assert.equal(context.purpose, 'enrichment'); assert.equal(context.discovery, undefined);
    assert.equal(context.signal?.aborted, false); assert.equal(context.isCurrent?.(), true);
    await patchItemFields(f.handle, 'item', { notes: 'Later notes', annotation: 'Later annotation', favorite: true });
    await tagSkill.run({ itemId: 'item', tags: ['curated'] }, f.ctx);
    await writeItem(f.handle, { ...f.row()!, title: 'Curated title' });
    f.handle.db.insert(assets).values({ id: 'retained', itemId: 'item', kind: 'snapshot', path: 'retained.bin' }).run();
    p.release.resolve(); await work;
    const row = f.row()!;
    assert.equal(row.title, 'Curated title'); assert.equal(row.notes, 'Later notes'); assert.equal(row.favorite, 1);
    assert.deepEqual(row.fields, { text: 'Body', tags: ['curated'], annotation: 'Later annotation', summary: 'Late summary' });
    assert.equal(f.handle.db.select().from(assets).all().length, 1);
  } finally { p.release.resolve(); f.cleanup(); }
});

test('new intent invalidates old work before next queued job starts, including old status', async () => {
  const f = await fixture(), first = delayedProvider(), second = delayedProvider(), registry = createCaptureRegistry();
  try {
    const a = runCaptureEnrichJob(f.handle, { itemId: 'item', boardId: 'a', registry, llm: first.llm, timeoutFn: never });
    await first.entered.promise;
    const b = runCaptureEnrichJob(f.handle, { itemId: 'item', boardId: 'a', registry, llm: second.llm, timeoutFn: never });
    first.release.resolve(); await a;
    await second.entered.promise;
    assert.equal((f.row()!.fields as Record<string, unknown>).summary, undefined);
    assert.equal(f.row()!.status, 'processing');
    second.release.resolve(); await b;
    assert.equal((f.row()!.fields as Record<string, unknown>).summary, 'Late summary');
    assert.equal(f.row()!.status, 'done');
  } finally { first.release.resolve(); second.release.resolve(); f.cleanup(); }
});

for (const mutation of ['delete-recreate', 'move', 'cancel', 'manual-upload'] as const) {
  test(`capture rejects ${mutation} late write and preserves current asset bytes`, async () => {
    const f = await fixture(), entered = deferred(), release = deferred(), ctrl = new AbortController();
    const registry = createCaptureRegistry(); let captureContext: CaptureCtx | undefined;
    registry.register({ ingestMode: 'manual-upload', async fetch(_source, ctx) {
      captureContext = ctx; entered.resolve(); await release.promise;
      return { fields: { title: 'Late capture', text: 'Late body', notes: 'forbidden', annotation: 'forbidden' }, assets: [] };
    } });
    try {
      const original = f.row()!;
      const work = runCaptureForItem(f.handle, registry, { itemId: 'item', boardId: 'a', source: { buffer: Buffer.from('input') }, signal: ctrl.signal });
      await entered.promise;
      let uploaded: string | undefined;
      if (mutation === 'delete-recreate') { await deleteItem(f.handle, 'item'); await writeItem(f.handle, original); }
      if (mutation === 'move') await writeItem(f.handle, { ...f.row()!, boardId: 'b' });
      if (mutation === 'cancel') ctrl.abort();
      if (mutation === 'manual-upload') uploaded = await uploadAssetForItem(f.handle, { itemId: 'item', screenshotsDir: f.dir, dataUrl: 'data:image/png;base64,Y3VyYXRlZA==' });
      assert.equal(captureContext?.isCurrent?.(), false);
      const before = f.row(), beforeAssets = f.handle.db.select().from(assets).all();
      release.resolve(); await work;
      assert.deepEqual(f.row(), before); assert.deepEqual(f.handle.db.select().from(assets).all(), beforeAssets);
      if (uploaded) assert.equal(readFileSync(join(f.dir, basename(uploaded)), 'utf8'), 'curated');
    } finally { release.resolve(); f.cleanup(); }
  });
}

test('capture preserves concurrent curation and unrelated assets on valid completion', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), registry = createCaptureRegistry();
  f.handle.db.insert(assets).values({ id: 'existing', itemId: 'item', kind: 'snapshot', path: 'existing.bin' }).run();
  registry.register({ ingestMode: 'manual-upload', async fetch() {
    entered.resolve(); await release.promise;
    return { fields: { title: 'Captured', tags: ['captured'], notes: 'forbidden', annotation: 'forbidden', text: 'New body' }, assets: [{ kind: 'image', path: 'new.bin' }] };
  } });
  try {
    const work = runCaptureForItem(f.handle, registry, { itemId: 'item', boardId: 'a', source: { buffer: Buffer.from('input') } });
    await entered.promise;
    await patchItemFields(f.handle, 'item', { notes: 'Keep notes', annotation: 'Keep annotation' });
    await tagSkill.run({ itemId: 'item', tags: ['keep'] }, f.ctx);
    await writeItem(f.handle, { ...f.row()!, title: 'Keep title' });
    release.resolve(); await work;
    assert.equal(f.row()!.title, 'Keep title'); assert.equal(f.row()!.notes, 'Keep notes');
    assert.deepEqual(f.row()!.fields, { tags: ['keep'], annotation: 'Keep annotation', text: 'New body' });
    assert.equal(f.handle.db.select().from(assets).all().length, 2);
  } finally { release.resolve(); f.cleanup(); }
});

test('timeout and late failure cannot mark a recreated item done/error', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(); let fire = () => {};
  try {
    const original = f.row()!;
    const work = runItemJob(f.handle, { itemId: 'item', type: 'test', timeoutMs: 1, timeoutFn(cb) { fire = cb; return () => {}; }, async work() { entered.resolve(); await release.promise; throw new Error('late'); } });
    await entered.promise; await deleteItem(f.handle, 'item'); await writeItem(f.handle, original);
    fire(); await work; release.resolve(); await tick();
    assert.deepEqual(f.row(), original);
  } finally { release.resolve(); f.cleanup(); }
});

test('snapshot late completion after deletion/recreation writes neither asset nor file', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(); let fileWrites = 0;
  try {
    const original = f.row()!;
    const work = runSnapshotJob(f.handle, { itemId: 'item', url: 'source-a', snapshotsDir: f.dir, timeoutFn: never,
      capture: { async capture() { entered.resolve(); await release.promise; return snapshotFromHtml('synthetic'); } },
      writeFile() { fileWrites++; },
    });
    await entered.promise; await deleteItem(f.handle, 'item'); await writeItem(f.handle, original);
    release.resolve(); await work;
    assert.equal(fileWrites, 0); assert.equal(f.handle.db.select().from(assets).all().length, 0);
  } finally { release.resolve(); f.cleanup(); }
});

test('lease generations are connection-local and identity ABA cannot regain a lease', async () => {
  const f = await fixture();
  try {
    const lease = beginItemLease(f.handle, 'item')!;
    await writeItem(f.handle, { ...f.row()!, source: 'source-b' });
    await writeItem(f.handle, { ...f.row()!, source: 'source-a' });
    assert.equal(currentLeaseItem(f.handle, lease), undefined);
  } finally { f.cleanup(); }
});

test('capture byte-write guard prevents a late screenshot from overwriting an uploaded file', async () => {
  const { createUrlScreenshotAdapter } = await import('../capture/url-screenshot.js');
  const f = await fixture(), entered = deferred(), release = deferred();
  const lease = beginItemLease(f.handle, 'item');
  const page = {
    async setViewport() {}, async goto() {},
    async screenshot() { entered.resolve(); await release.promise; return Buffer.from('late capture'); },
    async evaluate(fn: (...args: unknown[]) => unknown) { return fn.toString().includes('document.title') ? { title: 'Late', text: 'Late' } : undefined; },
  };
  const adapter = createUrlScreenshotAdapter({ launch: async () => ({ newPage: async () => page as never, async close() {} }), sleep: async () => {} });
  try {
    const work = adapter.fetch('synthetic-source', { itemId: 'item', boardId: 'a', screenshotsDir: f.dir, isCurrent: () => !!currentLeaseItem(f.handle, lease) });
    await entered.promise;
    const uploaded = await uploadAssetForItem(f.handle, { itemId: 'item', screenshotsDir: f.dir, dataUrl: 'data:image/png;base64,Y3VyYXRlZA==' });
    release.resolve(); await assert.rejects(work, /superseded/);
    assert.equal(readFileSync(join(f.dir, basename(uploaded)), 'utf8'), 'curated');
  } finally { release.resolve(); f.cleanup(); }
});

test('abort after provider resolves but before queued write is checked inside the write lane', async () => {
  const f = await fixture(), p = delayedProvider(), ctrl = new AbortController(), gate = deferred();
  try {
    const work = runEnrichmentForItem(f.handle, { itemId: 'item', llm: p.llm, signal: ctrl.signal });
    await p.entered.promise;
    const blocker = enqueueWrite(() => gate.promise);
    p.release.resolve(); await tick(); ctrl.abort(); gate.resolve(); await blocker; await work;
    assert.equal((f.row()!.fields as Record<string, unknown>).summary, undefined);
  } finally { p.release.resolve(); gate.resolve(); f.cleanup(); }
});

test('stale pipeline admission cannot invalidate a current lease or mark a different home done', async () => {
  const f = await fixture();
  try {
    await writeItem(f.handle, { ...f.row()!, boardId: 'b' });
    const lease = beginItemLease(f.handle, 'item')!, before = f.row();
    const result = await runCaptureEnrichJob(f.handle, { itemId: 'item', boardId: 'a', llm: disabledLlm, registry: createCaptureRegistry(), timeoutFn: never });
    assert.equal(result.ok, false); assert.deepEqual(f.row(), before); assert.ok(currentLeaseItem(f.handle, lease));
  } finally { f.cleanup(); }
});

test('snapshot mismatched source is refused before capture, file or asset writes', async () => {
  const f = await fixture(); let captures = 0, fileWrites = 0;
  try {
    const before = f.row();
    const result = await runSnapshotJob(f.handle, { itemId: 'item', url: 'different-source', snapshotsDir: f.dir, timeoutFn: never,
      capture: { async capture() { captures++; return snapshotFromHtml('synthetic'); } },
      writeFile() { fileWrites++; },
    });
    assert.equal(result.status, 'failed'); assert.equal(captures, 0); assert.equal(fileWrites, 0);
    assert.deepEqual(f.row(), before); assert.equal(f.handle.db.select().from(assets).all().length, 0);
  } finally { f.cleanup(); }
});

test('manual upload takes terminal ownership from a running pipeline without accepting its late output', async () => {
  const f = await fixture(), p = delayedProvider();
  try {
    const work = runCaptureEnrichJob(f.handle, { itemId: 'item', boardId: 'a', registry: createCaptureRegistry(), llm: p.llm, timeoutFn: never });
    await p.entered.promise; assert.equal(f.row()!.status, 'processing');
    const path = await uploadAssetForItem(f.handle, { itemId: 'item', screenshotsDir: f.dir, dataUrl: 'data:image/png;base64,Y3VyYXRlZA==' });
    assert.equal(f.row()!.status, 'done'); assert.equal(f.row()!.errorReason, null);
    const before = f.row(), rows = f.handle.db.select().from(assets).all();
    p.release.resolve(); await work;
    assert.deepEqual(f.row(), before); assert.deepEqual(f.handle.db.select().from(assets).all(), rows);
    assert.equal(readFileSync(join(f.dir, basename(path)), 'utf8'), 'curated');
  } finally { p.release.resolve(); f.cleanup(); }
});

test('manual upload cannot transfer lifecycle ownership over an already newer admitted job', async () => {
  const f = await fixture(), old = delayedProvider(), next = delayedProvider(), gate = deferred();
  try {
    const first = runCaptureEnrichJob(f.handle, { itemId: 'item', boardId: 'a', registry: createCaptureRegistry(), llm: old.llm, timeoutFn: never });
    await old.entered.promise;
    const blocked = enqueueWrite(() => gate.promise);
    const upload = uploadAssetForItem(f.handle, { itemId: 'item', screenshotsDir: f.dir, dataUrl: 'data:image/png;base64,Y3VyYXRlZA==' });
    const refused = assert.rejects(upload, /superseded/);
    const second = runCaptureEnrichJob(f.handle, { itemId: 'item', boardId: 'a', registry: createCaptureRegistry(), llm: next.llm, timeoutFn: never });
    gate.resolve(); await blocked; await refused;
    old.release.resolve(); await first; await next.entered.promise;
    assert.equal(f.row()!.status, 'processing');
    next.release.resolve(); await second; assert.equal(f.row()!.status, 'done');
  } finally { gate.resolve(); old.release.resolve(); next.release.resolve(); f.cleanup(); }
});

test('manual tag ABA preserves reasserted tags while unrelated generated summary commits', async () => {
  const f = await fixture(), p = delayedProvider();
  try {
    const work = runEnrichmentForItem(f.handle, { itemId: 'item', llm: p.llm });
    await p.entered.promise;
    await tagSkill.run({ itemId: 'item', tags: ['intermediate'] }, f.ctx);
    await tagSkill.run({ itemId: 'item', tags: ['initial'] }, f.ctx);
    p.release.resolve(); await work;
    assert.deepEqual((f.row()!.fields as Record<string, unknown>).tags, ['initial']);
    assert.equal((f.row()!.fields as Record<string, unknown>).summary, 'Late summary');
  } finally { p.release.resolve(); f.cleanup(); }
});

test('late cancellation during browser close never changes retained image bytes before database guard', async () => {
  const { createUrlScreenshotAdapter } = await import('../capture/url-screenshot.js');
  const f = await fixture(), closing = deferred(), release = deferred(), ctrl = new AbortController();
  const page = { async setViewport() {}, async goto() {}, async screenshot() { return Buffer.from('late capture'); },
    async evaluate(fn: (...args: unknown[]) => unknown) { return fn.toString().includes('document.title') ? { title: 'Late', text: 'Late' } : undefined; },
  };
  const adapter = createUrlScreenshotAdapter({ launch: async () => ({ newPage: async () => page as never, async close() { closing.resolve(); await release.promise; } }), sleep: async () => {} });
  const registry = createCaptureRegistry();
  registry.register({ ingestMode: 'manual-upload', fetch: (_source, ctx) => adapter.fetch('synthetic-source', ctx) });
  try {
    const path = await uploadAssetForItem(f.handle, { itemId: 'item', screenshotsDir: f.dir, dataUrl: 'data:image/png;base64,Y3VyYXRlZA==' });
    const rows = f.handle.db.select().from(assets).all(), before = f.row();
    const work = runCaptureForItem(f.handle, registry, { itemId: 'item', boardId: 'a', source: { buffer: Buffer.from('input') }, screenshotsDir: f.dir, signal: ctrl.signal });
    await closing.promise; // New attempt bytes exist, but DB guard has not run.
    assert.equal(readFileSync(join(f.dir, basename(path)), 'utf8'), 'curated');
    ctrl.abort(); release.resolve(); await work;
    assert.deepEqual(f.row(), before); assert.deepEqual(f.handle.db.select().from(assets).all(), rows);
    assert.equal(readFileSync(join(f.dir, basename(path)), 'utf8'), 'curated');
  } finally { release.resolve(); f.cleanup(); }
});

test('snapshot failed row commit never overwrites bytes referenced by retained asset', async () => {
  const f = await fixture();
  try {
    const first = await writeSnapshotAsset(f.handle, 'item', snapshotFromHtml('original'), { snapshotsDir: f.dir });
    const rows = f.handle.db.select().from(assets).all();
    f.handle.sqlite.exec("CREATE TRIGGER fail_snapshot BEFORE UPDATE ON asset BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END");
    await assert.rejects(writeSnapshotAsset(f.handle, 'item', snapshotFromHtml('new'), { snapshotsDir: f.dir }), /synthetic refusal/);
    assert.deepEqual(f.handle.db.select().from(assets).all(), rows);
    assert.equal(readFileSync(join(f.dir, basename(first.asset!.path)), 'utf8'), 'original');
  } finally { f.cleanup(); }
});


for (const mutation of ['opt-out', 'manual-edit'] as const) {
  test(`discovery ${mutation} cancels lifecycle explicitly instead of stranding processing`, async () => {
    const { setBrowserDiscovery } = await import('./board-options.js');
    const f = await fixture(), p = delayedProvider();
    try {
      await setBrowserDiscovery(f.handle, 'a', true);
      const work = runCaptureEnrichJob(f.handle, { itemId: 'item', boardId: 'a', registry: createCaptureRegistry(), llm: p.llm, timeoutFn: never });
      await p.entered.promise;
      assert.equal(f.row()!.status, 'processing');
      if (mutation === 'opt-out') await setBrowserDiscovery(f.handle, 'a', false);
      else await patchItemFields(f.handle, 'item', { annotation: 'Kept edit' });
      const afterEdit = f.row();
      assert.equal(afterEdit!.status, 'error');
      assert.match(afterEdit!.errorReason!, /cancelled/);
      p.release.resolve(); await work;
      assert.deepEqual(f.row(), afterEdit);
      assert.equal((f.row()!.fields as Record<string, unknown>).summary, undefined);
    } finally { p.release.resolve(); f.cleanup(); }
  });
}
