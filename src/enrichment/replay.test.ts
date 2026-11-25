import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDb } from '../db/index.js';
import { boards } from '../db/schema.js';
import { replayEnrichment } from './replay.js';
import type { BoardDescriptor } from '../descriptor/types.js';

const descriptor = {
  view: 'grid', ingest_mode: 'test', enrichment_prompt: 'x',
  fields: [
    { key: 'summary', label: 'Summary', type: 'text', enrichable: true },
    { key: 'relevance', label: 'Relevance', type: 'enum', enrichable: true, values: ['adjacent', 'unclassified'] },
  ],
} as unknown as BoardDescriptor;

describe('replayEnrichment', () => {
  it('accepts a valid output and reports what would be written', () => {
    const v = replayEnrichment(descriptor, '{"summary":"s","relevance":"adjacent","title":"T"}');
    assert.equal(v.ok, true);
    assert.deepEqual(v.accepted, { summary: 's', relevance: 'adjacent', title: 'T' });
    assert.deepEqual([v.repairs, v.ignoredKeys, v.issues], [[], [], []]);
  });

  it('reports repairs and ignored keys for a salvageable output', () => {
    const v = replayEnrichment(descriptor, '```json\n{"summary":"s","relevance",\n"extra":1}\n```');
    assert.equal(v.ok, true);
    assert.deepEqual(v.repairs, [{ kind: 'dangling-key', key: 'relevance' }]);
    assert.deepEqual(v.ignoredKeys, ['extra']);
    assert.deepEqual(v.accepted, { summary: 's' });
  });

  it('names the rule that rejected an output', () => {
    const bad = replayEnrichment(descriptor, '{"summary":"s","relevance":"competitor"}');
    assert.equal(bad.ok, false);
    assert.match(bad.issues[0], /^relevance: /);
    assert.match(replayEnrichment(descriptor, 'no json here').issues[0], /not parseable as JSON/);
    assert.match(replayEnrichment(descriptor, '[1,2]').issues[0], /not a JSON object/);
  });
});

describe('replay:enrichment CLI', () => {
  let dir: string;
  let dbPath: string;
  const cli = fileURLToPath(new URL('./replay-cli.ts', import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
  const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-replay-'));
    dbPath = join(dir, 'r.db');
    const h = initDb(dbPath);
    h.db.insert(boards).values({ id: 'b', name: 'B', view: 'grid', descriptor }).run();
    h.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    h.sqlite.close();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 0 and never modifies the database', () => {
    const raw = join(dir, 'ok.txt');
    writeFileSync(raw, '{"summary":"s","relevance":"adjacent"}');
    const before = sha(dbPath);
    const r = run('--db', dbPath, '--board', 'b', '--raw', raw);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ACCEPTED\n {2}would write: summary, relevance/);
    assert.equal(sha(dbPath), before, 'database bytes unchanged');
  });

  it('exits 1 with the problem for a rejected output, and supports --json', () => {
    const raw = join(dir, 'bad.txt');
    writeFileSync(raw, '{"relevance":"competitor"}');
    const r = run('--db', dbPath, '--board', 'b', '--raw', raw, '--json');
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).ok, false);
  });

  it('exits 64 on bad usage or an unknown board', () => {
    assert.equal(run().status, 64);
    const raw = join(dir, 'x.txt');
    writeFileSync(raw, '{}');
    assert.equal(run('--db', dbPath, '--board', 'nope', '--raw', raw).status, 64);
  });
});
