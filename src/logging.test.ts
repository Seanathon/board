import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installConsoleFileLog } from './logging.js';

describe('installConsoleFileLog', () => {
  let dir: string;
  const printed: string[] = [];
  const fake = () => ({
    log: (...a: unknown[]) => { printed.push('log:' + a.join(' ')); },
    info: (...a: unknown[]) => { printed.push('info:' + a.join(' ')); },
    warn: (...a: unknown[]) => { printed.push('warn:' + a.join(' ')); },
    error: (...a: unknown[]) => { printed.push('error:' + a.join(' ')); },
  });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-oss-log-')); printed.length = 0; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('tees every level to the file with timestamp + level and still prints', () => {
    const target = fake();
    const file = join(dir, 'logs', 'b.log');
    const restore = installConsoleFileLog({ file, target });
    target.log('hello', { a: 1 });
    target.warn('careful');
    target.error('item x failed: SyntaxError: bad');
    assert.deepEqual(printed, ['log:hello [object Object]', 'warn:careful', 'error:item x failed: SyntaxError: bad']);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO hello \{ a: 1 \}$/);
    assert.match(lines[1], / WARN careful$/);
    assert.match(lines[2], / ERROR item x failed: SyntaxError: bad$/);
    assert.equal(statSync(file).mode & 0o077, 0, 'owner-only');
    restore();
  });

  it('indents continuation lines so one entry stays one record', () => {
    const target = fake();
    const file = join(dir, 'm.log');
    installConsoleFileLog({ file, target });
    target.error('first\nsecond');
    assert.match(readFileSync(file, 'utf8'), / ERROR first\n {2}second\n$/);
  });

  it('rotates by size and keeps only `keep` old files', () => {
    const target = fake();
    const file = join(dir, 'r.log');
    installConsoleFileLog({ file, maxBytes: 200, keep: 2, target });
    for (let i = 0; i < 40; i++) target.log(`line ${i} ${'x'.repeat(40)}`);
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['r.log', 'r.log.1', 'r.log.2']);
    assert.match(readFileSync(file, 'utf8'), /line 39 /, 'newest entries in the live file');
  });

  it('restore() puts the original console functions back', () => {
    const target = fake();
    const before = target.log;
    const restore = installConsoleFileLog({ file: join(dir, 'x.log'), target });
    assert.notEqual(target.log, before);
    restore();
    assert.equal(target.log, before);
  });

  it('a file that cannot be written disables file logging once and never throws', () => {
    const target = fake();
    installConsoleFileLog({ file: join('/dev/null', 'nope', 'x.log'), target });
    assert.doesNotThrow(() => { target.log('a'); target.log('b'); });
    assert.equal(printed.filter((p) => p.startsWith('warn:file logging disabled')).length, 1);
    assert.ok(printed.includes('log:a') && printed.includes('log:b'), 'console output unaffected');
  });
});
