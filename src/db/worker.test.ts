import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { enqueueWrite, enqueueJob, type Job, type TimeoutFn } from './queue.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));
// a timeoutFn whose callback the test fires manually (deterministic, no real clock)
function manualTimeout(): { fn: TimeoutFn; fire: () => void } {
  let cb: (() => void) | null = null;
  return { fn: (c) => { cb = c; return () => (cb = null); }, fire: () => cb?.() };
}
const neverFires: TimeoutFn = () => () => {};

describe('job worker (Story 5.1)', () => {
  // AC 1/5 — serial: a job holds the slot across an await; active-count never > 1
  it('runs jobs serially (concurrency 1) — a parallel impl would hit active-count 2', async () => {
    let active = 0;
    let max = 0;
    const d1 = deferred();
    const d2 = deferred();
    const mk = (d: { promise: Promise<void> }): Job => ({
      type: 't',
      timeoutMs: 60_000,
      run: async () => {
        active += 1;
        max = Math.max(max, active);
        await d.promise; // hold the slot across an async boundary
        active -= 1;
      },
    });
    const p1 = enqueueJob(mk(d1), { timeoutFn: neverFires });
    const p2 = enqueueJob(mk(d2), { timeoutFn: neverFires });
    await tick();
    assert.equal(active, 1, 'only one job may run at a time');
    d1.resolve();
    await p1;
    d2.resolve();
    await p2;
    assert.equal(max, 1);
  });

  // Interactive writes must NOT queue behind a job. A capture job holds its lane for
  // its whole duration (Chrome + LLM, up to CAPTURE_TIMEOUT_MS = 180s); when writes
  // shared that lane, `addItemSkill`'s one-row INSERT — and so POST /api/collections/
  // :cid/items — blocked for the length of the running capture (measured: 42s with a
  // single job in flight). Concurrency 1 for JOBS (NFR-1: two Chromiums OOM the LXC)
  // and single-writer for SQLITE are two different constraints; they now have two
  // lanes. See the AD6 revision in queue.ts.
  it('does not queue a raw enqueueWrite behind a running job', async () => {
    const dj = deferred();
    const pj = enqueueJob(
      { type: 't', timeoutMs: 60_000, run: async () => { await dj.promise; } },
      { timeoutFn: neverFires },
    );
    await tick(); // the job is now running and holding its lane

    let wrote = false;
    const pw = enqueueWrite(() => { wrote = true; });
    await tick();
    assert.equal(wrote, true, 'a write must not wait for a long-running job to finish');

    await pw;
    dj.resolve();
    await pj;
  });

  // NOTE: AC4/5's "combined active-count never > 1" (a raw enqueueWrite and a job may
  // not overlap) was DELETED, not weakened. It asserted the single shared lane that is
  // the head-of-line-blocking bug above; the two invariants that actually matter are
  // kept and asserted separately — jobs stay concurrency 1 (the test above this one,
  // which is what NFR-1 needs), and SQLite writes stay serialized among themselves
  // (queue.test.ts's lost-update proof). Nothing asserts the two share a lane, because
  // they deliberately no longer do.

  // Writes issued from INSIDE a job go through `enqueueWrite` now that the lanes are
  // split. Under the old shared lane that self-deadlocked (the inner write waited on
  // the slot the job itself held) — which is why the job path had to use the `*Direct`
  // variants. Guard the property those call sites now depend on.
  it('lets a job await a write it enqueues itself (no self-deadlock)', async () => {
    let wrote = false;
    const result = await enqueueJob(
      { type: 't', timeoutMs: 60_000, run: async () => { await enqueueWrite(() => { wrote = true; }); } },
      { timeoutFn: neverFires },
    );
    assert.equal(result.ok, true, 'a job that awaits its own write must complete');
    assert.equal(wrote, true);
  });

  // AC 2/5 — timeout fires the abort signal, marks failed, and the queue proceeds
  it('times out a hung job: aborts, marks failed, proceeds to the next', async () => {
    const t = manualTimeout();
    let aborted = false;
    const hung: Job = {
      type: 'capture',
      timeoutMs: 50,
      run: (signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        return new Promise<void>(() => {}); // never resolves
      },
    };
    const p = enqueueJob(hung, { timeoutFn: t.fn });
    await tick();
    t.fire();
    const res = await p;
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.equal(aborted, true, 'the abort signal must fire on timeout');

    // queue proceeds: a subsequent job still runs
    const ran: string[] = [];
    await enqueueJob({ type: 'next', timeoutMs: 60_000, run: async () => { ran.push('x'); } }, { timeoutFn: neverFires });
    assert.deepEqual(ran, ['x']);
  });

  // AC 3 — the 5.1<->6.5 seam: after a capture timeout, the next job must NOT start
  // until the timed-out job's teardown releases memory.
  it('holds the slot until teardown completes before starting the next job', async () => {
    const t = manualTimeout();
    const td = deferred();
    const cap: Job = {
      type: 'capture',
      timeoutMs: 50,
      run: () => new Promise<void>(() => {}),
      teardown: () => td.promise,
    };
    const pcap = enqueueJob(cap, { timeoutFn: t.fn });
    await tick();
    t.fire();
    const status = await pcap;
    assert.equal(status.timedOut, true, 'status is marked failed immediately');

    let nextStarted = false;
    void enqueueJob({ type: 'next', timeoutMs: 60_000, run: async () => { nextStarted = true; } }, { timeoutFn: neverFires });
    await tick();
    assert.equal(nextStarted, false, 'next job must wait for teardown to release memory');

    td.resolve();
    await tick();
    await tick();
    assert.equal(nextStarted, true, 'next job runs once teardown completes');
  });
});
