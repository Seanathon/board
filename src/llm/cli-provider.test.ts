import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { runProviderConformance } from './conformance.js';
import { LLMSchemaError, LLMTransportError } from './provider.js';
import { CliProvider, type CliChild, type SpawnFn } from './cli-provider.js';

// A fake child process: emits canned stdout/stderr then 'close' with `code`, unless
// `hang` (then it never closes — exercises the timeout/kill path).
function fakeSpawn(opts: { stdout?: string; stderr?: string; code?: number; hang?: boolean }): {
  spawn: SpawnFn;
  lastArgs: () => { command: string; args: string[] } | undefined;
  killed: () => boolean;
} {
  let captured: { command: string; args: string[] } | undefined;
  let wasKilled = false;
  const spawn: SpawnFn = (command, args) => {
    captured = { command, args };
    const child: CliChild = {
      stdout: { on: (ev, cb) => { if (ev === 'data' && opts.stdout) queueMicrotask(() => cb(Buffer.from(opts.stdout!))); } },
      stderr: { on: (ev, cb) => { if (ev === 'data' && opts.stderr) queueMicrotask(() => cb(Buffer.from(opts.stderr!))); } },
      on: (ev, cb) => { if (ev === 'close' && !opts.hang) queueMicrotask(() => (cb as (c: number) => void)(opts.code ?? 0)); },
      kill: () => { wasKilled = true; },
    };
    return child;
  };
  return { spawn, lastArgs: () => captured, killed: () => wasKilled };
}

const schema = z.object({ title: z.string(), n: z.number() });

describe('CliProvider (Story 4.3)', () => {
  // AC 2/5 — claude: schema inline on argv, reads stdout, parses + revalidates
  it('claude: spawns with schema on argv, parses stdout', async () => {
    const f = fakeSpawn({ stdout: '{"title":"hi","n":4}', code: 0 });
    const provider = new CliProvider({ agent: { id: 'claude', model: null }, spawn: f.spawn, timeoutMs: 1000 });
    const out = await provider.complete('PROMPT', schema);
    assert.deepEqual(out, { title: 'hi', n: 4 });
    const call = f.lastArgs()!;
    assert.equal(call.command, 'claude');
    assert.ok(call.args.includes('--json-schema'), 'schema injected on argv');
    assert.ok(call.args.includes('PROMPT'), 'prompt on argv');
    // no secret/key on argv (CLI uses the user subscription — there is none)
    assert.ok(!call.args.some((a) => /bearer|api[_-]?key|sk-/i.test(a)), 'no secret on argv');
  });

  // AC 5 — codex: schema via temp file, reads RESULT FILE (injected readFile), stricter schema
  it('codex: uses output files, reads the result file', async () => {
    const f = fakeSpawn({ code: 0 });
    const provider = new CliProvider({
      agent: { id: 'codex', model: null },
      spawn: f.spawn,
      readFile: () => '{"title":"c","n":9}',
      timeoutMs: 1000,
    });
    const out = await provider.complete('PROMPT', schema);
    assert.deepEqual(out, { title: 'c', n: 9 });
    const call = f.lastArgs()!;
    assert.equal(call.command, 'codex');
    assert.ok(call.args.includes('--output-schema'), 'codex schema file flag');
    assert.ok(call.args.includes('--output-last-message'), 'codex result file flag');
  });

  // AC 2 — schema mismatch → typed LLMSchemaError
  it('throws LLMSchemaError on schema-violating output', async () => {
    const f = fakeSpawn({ stdout: '{"title":"x","n":"bad"}', code: 0 });
    const provider = new CliProvider({ agent: { id: 'claude', model: null }, spawn: f.spawn, timeoutMs: 1000 });
    await assert.rejects(() => provider.complete('p', schema), (e: unknown) => e instanceof LLMSchemaError);
  });

  // AC 3 — non-zero exit → LLMTransportError
  it('throws LLMTransportError on a non-zero exit', async () => {
    const f = fakeSpawn({ stderr: 'boom', code: 1 });
    const provider = new CliProvider({ agent: { id: 'claude', model: null }, spawn: f.spawn, timeoutMs: 1000 });
    await assert.rejects(() => provider.complete('p', schema), (e: unknown) => e instanceof LLMTransportError);
  });

  // AC 3 — captured stderr is logged on a non-zero exit
  it('logs captured stderr on a non-zero exit', async () => {
    const logged: string[] = [];
    const logger = { info: () => {}, warn: () => {}, error: (m: string) => logged.push(m) };
    const f = fakeSpawn({ stderr: 'kaboom-detail', code: 2 });
    const provider = new CliProvider({ agent: { id: 'claude', model: null }, spawn: f.spawn, timeoutMs: 1000, logger });
    await assert.rejects(() => provider.complete('p', schema), (e: unknown) => e instanceof LLMTransportError);
    assert.ok(logged.some((l) => l.includes('kaboom-detail')), 'stderr should be captured + logged');
  });

  // AC 5 — codex writes the STRICTER schema (additionalProperties:false, required=all)
  it('codex writes the stricter output schema to the schema file', async () => {
    let written = '';
    const f = fakeSpawn({ code: 0 });
    const provider = new CliProvider({
      agent: { id: 'codex', model: null },
      spawn: f.spawn,
      readFile: () => '{"title":"c","n":1}',
      writeFile: (_p, data) => { written = data; },
      timeoutMs: 1000,
    });
    await provider.complete('p', schema);
    const js = JSON.parse(written);
    assert.equal(js.additionalProperties, false, 'codex schema must be strict');
    assert.deepEqual(js.required, ['title', 'n']);
  });

  // Resource safety on the small LXC — output is bounded (prototype's maxBuffer)
  it('kills + rejects when output exceeds the size cap', async () => {
    const huge = 'x'.repeat(11 * 1024 * 1024);
    const f = fakeSpawn({ stdout: huge, hang: true }); // emits a giant chunk, never closes
    const provider = new CliProvider({ agent: { id: 'claude', model: null }, spawn: f.spawn, timeoutMs: 60_000 });
    await assert.rejects(() => provider.complete('p', schema), (e: unknown) => e instanceof LLMTransportError);
    assert.equal(f.killed(), true, 'overflowing process must be killed');
  });

  // AC 3 — wall-clock timeout KILLS the process and throws
  it('kills the process and throws on timeout', async () => {
    const f = fakeSpawn({ hang: true });
    const provider = new CliProvider({ agent: { id: 'claude', model: null }, spawn: f.spawn, timeoutMs: 10 });
    await assert.rejects(() => provider.complete('p', schema), (e: unknown) => e instanceof LLMTransportError);
    assert.equal(f.killed(), true, 'a hung process must be killed');
  });

  // AC 4 — passes the shared conformance suite (claude/stdout seam)
  runProviderConformance({
    label: 'CliProvider',
    makeProviderReturning: (raw) =>
      new CliProvider({ agent: { id: 'claude', model: null }, spawn: fakeSpawn({ stdout: raw, code: 0 }).spawn, timeoutMs: 1000 }),
  });
});

it('CLI cancellation kills but holds completion until close and never spawns pre-aborted work', async () => {
  let close: ((code: number | Error) => void) | undefined; let kills = 0, calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    return { stdout: { on() {} }, stderr: { on() {} }, on(event, cb) { if (event === 'close') close = cb; }, kill() { kills++; } };
  };
  const provider = new CliProvider({ agent: { id: 'claude', model: 'configured-model' }, spawn });
  const controller = new AbortController(), context = { itemId: 'i', boardId: 'b', source: null, signal: controller.signal };
  let finished = false;
  const work = assert.rejects(provider.complete('p', z.object({}), context), /aborted/).then(() => { finished = true; });
  controller.abort(); await new Promise(r => setImmediate(r));
  assert.equal(kills, 1); assert.equal(finished, false); close!(0); await work;
  await assert.rejects(provider.complete('p', z.object({}), context)); assert.equal(calls, 1);
});


it('Codex data-only completion disables inherited MCP entries without changing default completions', async () => {
  const calls: string[][] = [];
  const spawn: SpawnFn = (_command, args) => {
    calls.push(args);
    return fakeSpawn({ stdout: args[0] === 'mcp' ? '[{"name":"inherited","enabled":true},{"name":"already_off","enabled":false}]' : '', code: 0 }).spawn(_command, args, {});
  };
  const provider = new CliProvider({ agent: { id: 'codex', model: 'configured-model' }, spawn, readFile: () => '{"title":"ok","n":1}' });
  await provider.complete('p', schema);
  assert.equal(calls.length, 1);
  assert(!calls[0].some(arg => arg.startsWith('mcp_servers.')));
  calls.length = 0;
  await provider.complete('p', schema, { itemId: 'i', boardId: 'b', source: 'https://example.com', purpose: 'discovery' });
  assert.deepEqual(calls[0], ['mcp', 'list', '--json']);
  assert(calls[1].includes('mcp_servers.inherited.enabled=false'));
  assert(calls[1].includes('mcp_servers.already_off.enabled=false'));
  assert(calls[1].includes('features.shell_tool=false'));
  assert(!calls[1].includes('mcp_servers={}'));
});

it('Codex discovery refuses malformed MCP inventories before starting inference', async () => {
  for (const stdout of ['not json', '{}', '[{"name":"unsafe.name"}]']) {
    let calls = 0;
    const provider = new CliProvider({ agent: { id: 'codex', model: null }, spawn: (command, args, opts) => { calls++; return fakeSpawn({ stdout }).spawn(command, args, opts); } });
    await assert.rejects(provider.complete('p', schema, { itemId: 'i', boardId: 'b', source: null, purpose: 'discovery' }), /MCP configuration/);
    assert.equal(calls, 1);
  }
});
