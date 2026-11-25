import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb } from './index.js';
import { boards, items } from './schema.js';
import { runItemJob, type TimeoutFn } from './queue.js';
import {
  createFileFailureSink,
  failureRawOutput,
  failureStage,
  inStage,
  reportJobFailure,
  setJobFailureSink,
  type JobFailure,
} from './job-failures.js';
import { LLMSchemaError } from '../llm/provider.js';

const neverFires: TimeoutFn = () => () => {};
const sample = (over: Partial<JobFailure> = {}): JobFailure => ({
  at: '2026-11-25T00:00:00.000Z', itemId: 'item-1', jobType: 'capture', stage: 'analysis',
  name: 'SyntaxError', message: 'bad json', category: 'AI returned invalid output', ...over,
});

describe('inStage / failure helpers', () => {
  it('tags an error with the stage, innermost stage wins, error otherwise untouched', async () => {
    const err = new Error('x');
    await assert.rejects(inStage('analysis', () => inStage('validation', () => Promise.reject(err))), err);
    assert.equal(failureStage(err), 'validation');
    assert.equal(Object.keys(err).includes('stage'), false, 'stage is non-enumerable');
  });

  it('survives frozen errors and non-objects', async () => {
    await assert.rejects(inStage('capture', () => { throw Object.freeze(new Error('f')); }));
    await assert.rejects(inStage('capture', () => Promise.reject('plain string')));
    assert.equal(failureStage(Object.freeze(new Error('f'))), 'unknown');
    assert.equal(failureStage({ stage: 'Not Valid!' }), 'unknown');
  });

  it('finds raw output on the error or its cause', () => {
    assert.equal(failureRawOutput(new LLMSchemaError('m', { rawOutput: 'RAW' })), 'RAW');
    assert.equal(failureRawOutput(new Error('o', { cause: { rawOutput: 'CAUSE' } })), 'CAUSE');
    assert.equal(failureRawOutput(new Error('none')), undefined);
  });
});

describe('createFileFailureSink', () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'board-oss-failures-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('appends JSONL and keeps raw output with owner-only permissions', () => {
    const sink = createFileFailureSink(join(dir, 'a'));
    sink.record(sample(), '{"half": "written",');
    sink.record(sample({ itemId: 'item-2' }));
    const lines = readFileSync(join(dir, 'a', 'failures.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].stage, 'analysis');
    assert.match(lines[0].rawOutputFile, /^item-1-\d+\.raw\.txt$/);
    assert.equal(lines[1].rawOutputFile, undefined);
    assert.equal(readFileSync(join(dir, 'a', lines[0].rawOutputFile), 'utf8'), '{"half": "written",');
    assert.equal(statSync(join(dir, 'a', lines[0].rawOutputFile)).mode & 0o077, 0);
    assert.equal(statSync(join(dir, 'a', 'failures.jsonl')).mode & 0o077, 0);
  });

  it('clips oversized raw output and sanitises the item id used in file names', () => {
    const sink = createFileFailureSink(join(dir, 'b'));
    sink.record(sample({ itemId: '../../etc/passwd' }), 'x'.repeat(200_000));
    const [file] = readdirSync(join(dir, 'b')).filter((f) => f.endsWith('.raw.txt'));
    assert.ok(!file.includes('/') && !file.includes('..'));
    assert.equal(statSync(join(dir, 'b', file)).size, 64 * 1024);
  });

  it('keeps only the newest 200 raw files', () => {
    const d = join(dir, 'c');
    const sink = createFileFailureSink(d);
    sink.record(sample(), 'seed');
    for (let i = 0; i < 205; i++) writeFileSync(join(d, `old-${String(i).padStart(3, '0')}.raw.txt`), 'o');
    sink.record(sample(), 'new');
    assert.equal(readdirSync(d).filter((f) => f.endsWith('.raw.txt')).length, 200);
  });
});

describe('runItemJob failure evidence', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;
  const seen: Array<{ failure: JobFailure; raw?: string }> = [];
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-failjob-'));
    handle = initDb(join(dir, 'f.db'));
    handle.db.insert(boards).values({ id: 'b', name: 'B', view: 'grid' }).run();
    setJobFailureSink({ record: (failure, raw) => { seen.push({ failure, raw }); } });
  });
  afterEach(() => { seen.length = 0; });
  after(() => { setJobFailureSink(undefined); handle.sqlite.close(); rmSync(dir, { recursive: true, force: true }); });
  const seed = (id: string) => handle.db.insert(items).values({ id, boardId: 'b', source: 'x' }).run();
  const quiet = { error() {} };

  it('records stage, scrubbed message, category and raw output for a failed job', async () => {
    seed('j1');
    await runItemJob(handle, {
      itemId: 'j1', type: 'capture', timeoutMs: 60_000, timeoutFn: neverFires, logger: quiet,
      work: () => inStage('analysis', () => { throw new LLMSchemaError('output failed schema; api_key=sk-live-1234567890abcdef', { rawOutput: 'RAW MODEL TEXT' }); }),
    });
    assert.equal(seen.length, 1);
    const { failure, raw } = seen[0];
    assert.deepEqual([failure.itemId, failure.jobType, failure.stage, failure.name, failure.category],
      ['j1', 'capture', 'analysis', 'LLMSchemaError', 'AI returned invalid output']);
    assert.doesNotMatch(failure.message, /1234567890abcdef/);
    assert.equal(raw, 'RAW MODEL TEXT');
  });

  it('records stage unknown when nothing tagged the error, and nothing on success', async () => {
    seed('j2'); seed('j3');
    await runItemJob(handle, { itemId: 'j2', type: 'enrich', timeoutMs: 60_000, timeoutFn: neverFires, logger: quiet, work: () => { throw new Error('boom'); } });
    await runItemJob(handle, { itemId: 'j3', type: 'enrich', timeoutMs: 60_000, timeoutFn: neverFires, work: () => {} });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].failure.stage, 'unknown');
    assert.equal(seen[0].failure.category, 'processing failed');
  });

  it('a throwing sink never changes the job outcome', async () => {
    seed('j4');
    setJobFailureSink({ record() { throw new Error('disk full'); } });
    await runItemJob(handle, { itemId: 'j4', type: 'enrich', timeoutMs: 60_000, timeoutFn: neverFires, logger: quiet, work: () => { throw new Error('boom'); } });
    assert.equal(handle.db.select().from(items).all().find((i) => i.id === 'j4')?.status, 'error');
    setJobFailureSink({ record: (failure, raw) => { seen.push({ failure, raw }); } });
  });

  it('records a timeout with stage timeout', async () => {
    seed('j5');
    let fire: (() => void) | null = null;
    const p = runItemJob(handle, {
      itemId: 'j5', type: 'capture', timeoutMs: 5, logger: quiet,
      timeoutFn: (cb) => { fire = cb; return () => (fire = null); },
      work: () => new Promise(() => {}),
    });
    await new Promise((r) => setImmediate(r));
    (fire as unknown as () => void)();
    await p;
    assert.equal(seen.at(-1)?.failure.stage, 'timeout');
    assert.equal(seen.at(-1)?.failure.category, 'timed out');
  });

  it('reportJobFailure with no sink installed is a no-op', () => {
    setJobFailureSink(undefined);
    reportJobFailure(sample());
    setJobFailureSink({ record: (failure, raw) => { seen.push({ failure, raw }); } });
  });
});
