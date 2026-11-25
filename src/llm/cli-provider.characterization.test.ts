import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnalysisCommand,
  parseJsonFromText,
  extractAnalysisPayload,
  toCodexOutputSchema,
} from '../add.js';

// Story 4.3 — CHARACTERIZATION tests. These pin the prototype's EXISTING CLI
// argv-build + output-parse behavior (NFR-5/C7) so the port into CliProvider is
// provably behavior-preserving. Unlike TDD, these start GREEN against the current
// add.ts and must stay green through the refactor. Discovery additionally pins
// data-only tool restrictions; provider identity and output parsing remain unchanged.

const SCHEMA = { type: 'object', properties: { title: { type: 'string' } } };

describe('CLI characterization: buildAnalysisCommand (Story 4.3)', () => {
  it('claude: schema inline on argv + stdout-format, optional --model', () => {
    const noModel = buildAnalysisCommand({ id: 'claude', model: null }, 'PROMPT', SCHEMA, 'SYS');
    assert.equal(noModel.command, 'claude');
    assert.deepEqual(noModel.args, [
      '-p', 'PROMPT',
      '--tools', '',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(SCHEMA),
      '--append-system-prompt', 'SYS',
    ]);
    const withModel = buildAnalysisCommand({ id: 'claude', model: 'sonnet' }, 'P', SCHEMA, 'S');
    assert.deepEqual(withModel.args.slice(-2), ['--model', 'sonnet']);
  });

  it('codex: schema + result via temp files, prompt last, optional --model', () => {
    const cmd = buildAnalysisCommand({ id: 'codex', model: null }, 'PROMPT', SCHEMA, 'SYS', {
      schemaFile: '/tmp/s.json',
      resultFile: '/tmp/r.json',
    });
    assert.equal(cmd.command, 'codex');
    assert.deepEqual(cmd.args, [
      '--ask-for-approval', 'never',
      'exec',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--output-schema', '/tmp/s.json',
      '--output-last-message', '/tmp/r.json',
      'PROMPT',
    ]);
    const withModel = buildAnalysisCommand({ id: 'codex', model: 'o4' }, 'P', SCHEMA, 'S', {
      schemaFile: '/tmp/s.json',
      resultFile: '/tmp/r.json',
    });
    // --model inserted before the trailing prompt
    assert.deepEqual(withModel.args.slice(-3), ['--model', 'o4', 'P']);
  });

  it('codex requires schema + result files', () => {
    assert.throws(() => buildAnalysisCommand({ id: 'codex', model: null }, 'P', SCHEMA, 'S'), /Codex/);
  });
});

describe('CLI characterization: output parsing (Story 4.3)', () => {
  it('parseJsonFromText handles raw, fenced, and brace-fallback', () => {
    assert.deepEqual(parseJsonFromText('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonFromText('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonFromText('noise before {"a":1} noise after'), { a: 1 });
  });

  it('extractAnalysisPayload unwraps structured_output ?? result ?? value', () => {
    assert.deepEqual(extractAnalysisPayload({ structured_output: { x: 1 } }), { x: 1 });
    assert.deepEqual(extractAnalysisPayload({ result: { y: 2 } }), { y: 2 });
    assert.deepEqual(extractAnalysisPayload({ z: 3 }), { z: 3 });
  });

  it('toCodexOutputSchema forces additionalProperties:false + required=all on objects', () => {
    const out = toCodexOutputSchema({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } }) as Record<string, unknown>;
    assert.equal(out.additionalProperties, false);
    assert.deepEqual(out.required, ['a', 'b']);
  });
});
