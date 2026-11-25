import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobHealthMonitor, jobHealthOptionsFromEnv, setJobHealthMonitor } from './job-health.js';
import { initDb } from './index.js';
import { boards, items } from './schema.js';
import { runItemJob, type TimeoutFn } from './queue.js';

const make = (opts: Parameters<typeof createJobHealthMonitor>[0] = {}) => {
  const warns: string[] = [];
  const infos: string[] = [];
  const m = createJobHealthMonitor({ window: 10, minJobs: 5, threshold: 0.5, warn: (x) => warns.push(x), info: (x) => infos.push(x), ...opts });
  return { m, warns, infos };
};
const feed = (m: ReturnType<typeof createJobHealthMonitor>, board: string, ...failed: boolean[]) => failed.forEach((f) => m.record(board, f));

describe('job health monitor', () => {
  it('stays quiet below minJobs even if every job failed', () => {
    const { m, warns } = make();
    feed(m, 'b', true, true, true, true);
    assert.equal(warns.length, 0);
  });

  it('alerts ONCE when the failure rate crosses the threshold, not on every failure after', () => {
    const { m, warns } = make();
    feed(m, 'b', true, true, true, false, false); // 3/5 = 60% at the 5th job
    assert.equal(warns.length, 1);
    assert.match(warns[0], /^ALERT board b: 3 of the last 5 jobs failed \(60%, threshold 50%\)/);
    feed(m, 'b', true, true, true);
    assert.equal(warns.length, 1, 'no repeat while still alerting');
    assert.equal(m.snapshot()[0].alerting, true);
  });

  it('reports recovery once the rate falls below half the threshold, then can alert again', () => {
    const { m, warns, infos } = make();
    feed(m, 'b', true, true, true, true, true);
    assert.equal(warns.length, 1);
    feed(m, 'b', ...Array(10).fill(false)); // window now all successes
    assert.equal(infos.length, 1);
    assert.match(infos[0], /^RECOVERED board b: 2 of the last 10 jobs failed \(20%\)/, 'first moment the rate is below half the threshold');
    feed(m, 'b', ...Array(8).fill(true));
    assert.equal(warns.length, 2, 're-alerts after recovering');
  });

  it('does not flap in the band between half the threshold and the threshold', () => {
    const { m, warns, infos } = make({ window: 4, minJobs: 4 });
    feed(m, 'b', true, true, false, false); // 50% -> alert
    feed(m, 'b', false, true, false); // window stays at 25%: below the threshold, not below half of it
    assert.equal(m.snapshot()[0].failureRate, 0.25);
    assert.equal(warns.length, 1, 'no second alert');
    assert.equal(infos.length, 0, 'and no recovery yet');
  });

  it('keeps boards independent and the window bounded', () => {
    const { m, warns } = make({ window: 5, minJobs: 5 });
    feed(m, 'bad', true, true, true, true, true);
    feed(m, 'good', false, false, false, false, false);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /board bad/);
    feed(m, 'bad', ...Array(20).fill(false));
    const bad = m.snapshot().find((s) => s.boardId === 'bad')!;
    assert.equal(bad.jobs, 5);
    assert.deepEqual(m.snapshot().map((s) => s.boardId), ['bad', 'good']);
  });

  it('parses env options and ignores junk', () => {
    assert.deepEqual(jobHealthOptionsFromEnv({ BOARD_ALERT_ERROR_RATE: '0.3', BOARD_ALERT_MIN_JOBS: '8', BOARD_ALERT_WINDOW: '40' }), { threshold: 0.3, minJobs: 8, window: 40 });
    assert.deepEqual(jobHealthOptionsFromEnv({ BOARD_ALERT_ERROR_RATE: '5', BOARD_ALERT_MIN_JOBS: 'x', BOARD_ALERT_WINDOW: '0' }), { threshold: undefined, minJobs: undefined, window: undefined });
    assert.deepEqual(jobHealthOptionsFromEnv({}), { threshold: undefined, minJobs: undefined, window: undefined });
  });
});

describe('runItemJob feeds the monitor', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;
  const never: TimeoutFn = () => () => {};
  const { m, warns } = make({ window: 4, minJobs: 4 });
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-health-'));
    handle = initDb(join(dir, 'h.db'));
    handle.db.insert(boards).values({ id: 'hb', name: 'H', view: 'grid' }).run();
    setJobHealthMonitor(m);
  });
  after(() => { setJobHealthMonitor(undefined); handle.sqlite.close(); rmSync(dir, { recursive: true, force: true }); });

  it('counts done and error outcomes per board and alerts when they fail', async () => {
    for (let i = 0; i < 4; i++) {
      handle.db.insert(items).values({ id: `h${i}`, boardId: 'hb', source: 'x' }).run();
      await runItemJob(handle, { itemId: `h${i}`, type: 'enrich', timeoutMs: 1000, timeoutFn: never, logger: { error() {} }, work: () => { if (i > 0) throw new Error('boom'); } });
    }
    const s = m.snapshot().find((b) => b.boardId === 'hb')!;
    assert.deepEqual([s.jobs, s.failures], [4, 3]);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /ALERT board hb/);
  });
});
