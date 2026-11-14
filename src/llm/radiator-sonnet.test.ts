import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { RADIATOR_SONNET_MODEL as MODEL, runRadiatorSonnet, type RadiatorSpawn } from './radiator-sonnet.js';

const receipt = () => ({
  type: 'result', subtype: 'success', is_error: false, result: '{"answer":"ok"}',
  session_id: '12345678-1234-1234-1234-123456789abc',
  modelUsage: { [MODEL]: { inputTokens: 12, outputTokens: 7 } },
  usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0 },
});
function fake(run?: (child: ReturnType<typeof createChild>) => void, inspect?: (...args: Parameters<RadiatorSpawn>) => void) {
  const child = createChild();
  const calls: Parameters<RadiatorSpawn>[] = [];
  const spawn: RadiatorSpawn = (...args) => {
    calls.push(args);
    inspect?.(...args);
    queueMicrotask(() => run?.(child));
    return child as unknown as ReturnType<RadiatorSpawn>;
  };
  return { child, calls, spawn };
}
function createChild() {
  const events = new EventEmitter();
  return Object.assign(events, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    signals: [] as string[],
    kill(signal: string) {
      this.signals.push(signal);
      if (signal === 'SIGKILL') events.emit('close', null);
      return true;
    },
  });
}
function success(child: ReturnType<typeof createChild>, value: unknown = receipt()) {
  const raw = Buffer.from(JSON.stringify(value));
  child.stdout.write(raw.subarray(0, 17));
  child.stdout.write(raw.subarray(17));
  child.emit('close', 0);
}

test('exact argv, private settings, stdin-only prompt and effective receipt; cleans cwd', async () => {
  let cwd = '';
  const prompt = '--model other\n$(touch /tmp/nope)\n秘密';
  const f = fake(success, (command, args, opts) => {
    assert.equal(command, 'claude');
    cwd = opts.cwd as string;
    const settingsPath = join(cwd, 'settings.json');
    assert.deepEqual(args, ['--bare', '--settings', settingsPath, '--model', MODEL,
      '--effort', 'medium', '--tools', '', '--print', '--output-format', 'json',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
    assert.equal(opts.shell, false);
    assert.equal(opts.detached, process.platform !== 'win32');
    assert.equal(opts.stdio, 'pipe');
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(settings.disableAllHooks, true);
    for (const ns of ['jev-model-router', 'jev-model-router@inline']) {
      assert.equal(settings.enabledPlugins[ns], false);
      assert.deepEqual(settings.pluginConfigs[ns].options, {
        enabled: false, routeMainModel: false, routeMainEffort: false, routeSubagentModel: false, classifyTurns: false,
      });
    }
  });
  const result = await runRadiatorSonnet(prompt, { spawn: f.spawn });
  assert.equal(f.child.stdin.read().toString(), prompt);
  assert.equal(result.text, receipt().result);
  assert.equal(result.modelId, MODEL);
  assert.equal(result.sessionId, receipt().session_id);
  assert.deepEqual(result.usage, receipt().usage);
  assert.ok(result.elapsedMs >= 0);
  assert.equal(existsSync(cwd), false);
});

test('trusted settings file preserves local auth configuration but forces both routers off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radiator-test-'));
  const file = join(dir, 'config.json');
  const original = { env: { LOCAL_TEST_SETTING: 'private-value' }, apiKeyHelper: 'trusted-helper',
    pluginConfigs: { 'jev-model-router': { options: { enabled: true, custom: 1 } } } };
  writeFileSync(file, JSON.stringify(original));
  try {
    const f = fake(success, (_command, args) => {
      const settings = JSON.parse(readFileSync(args[2], 'utf8'));
      assert.deepEqual(settings.env, original.env);
      assert.equal(settings.apiKeyHelper, original.apiKeyHelper);
      assert.equal(settings.pluginConfigs['jev-model-router'].options.enabled, false);
      assert.equal(settings.pluginConfigs['jev-model-router'].options.custom, 1);
      assert.ok(!args.some(arg => arg.includes('private-value')));
    });
    await runRadiatorSonnet('p', { spawn: f.spawn, settingsFile: file, command: '/trusted/claude' });
    assert.equal(f.calls[0][0], '/trusted/claude');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), original);
    const old = process.env.RADIATOR_CLAUDE_SETTINGS_FILE;
    try {
      process.env.RADIATOR_CLAUDE_SETTINGS_FILE = file;
      await runRadiatorSonnet('p', { spawn: fake(success).spawn });
    } finally {
      if (old === undefined) delete process.env.RADIATOR_CLAUDE_SETTINGS_FILE;
      else process.env.RADIATOR_CLAUDE_SETTINGS_FILE = old;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [name, patch] of Object.entries({
  'wrong model': { modelUsage: { 'claude-sonnet-5': { inputTokens: 1, outputTokens: 1 } } },
  'mixed models': { modelUsage: { [MODEL]: { inputTokens: 1, outputTokens: 1 }, other: {} } },
  'unknown model': { modelUsage: {} },
  'missing model metadata': { modelUsage: undefined },
  'model usage placeholder': { modelUsage: { [MODEL]: {} } },
  'missing usage': { usage: undefined },
  'empty usage': { usage: {} },
  'invalid token count': { usage: { input_tokens: -1, output_tokens: 1 } },
  'zero output': { usage: { input_tokens: 1, output_tokens: 0 } },
  'invalid cache count': { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 'unknown' } },
  'missing session': { session_id: '' },
  'invalid session': { session_id: 'not-a-session' },
  'error flag': { is_error: true },
  'error subtype': { subtype: 'error_max_turns' },
  'empty text': { result: ' ' },
  'oversized text': { result: 'x'.repeat(32_769) },
})) {
  test(`rejects ${name}`, async () => {
    const f = fake(child => success(child, { ...receipt(), ...patch }));
    await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn }), /Radiator CLI/);
    assert.equal(existsSync(f.calls[0][2].cwd as string), false);
  });
}

test('rejects malformed, trailing, and non-object output without leaking raw content', async () => {
  for (const raw of ['private-secret', 'null', '[]', `${JSON.stringify(receipt())} trailing`]) {
    const f = fake(child => { child.stdout.write(raw); child.emit('close', 0); });
    await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn }), error => {
      assert.ok(error instanceof Error && !error.message.includes('private-secret'));
      return true;
    });
  }
});

test('rejects input and timeout bounds before spawning', async () => {
  const f = fake();
  for (const prompt of ['', ' ', 'é'.repeat(50_001)]) await assert.rejects(runRadiatorSonnet(prompt, { spawn: f.spawn }));
  for (const timeoutMs of [0, -1, NaN, Infinity, 240_001]) await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn, timeoutMs }));
  await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn, command: 'bad\0command' }));
  assert.equal(f.calls.length, 0);
});

test('rejects invalid or oversized trusted settings without spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radiator-test-'));
  const file = join(dir, 'config.json');
  const f = fake();
  try {
    for (const raw of ['invalid-private-setting', '[]', 'x'.repeat(65_537)]) {
      writeFileSync(file, raw);
      await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn, settingsFile: file }), /^Error: Invalid Radiator local settings file$/);
    }
    await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn, settingsFile: dir }));
    assert.equal(f.calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('spawn throws/errors, pipe errors and nonzero exit are sanitized and clean up', async () => {
  let cwd = '';
  await assert.rejects(runRadiatorSonnet('p', { spawn: (_command, _args, opts) => {
    cwd = opts.cwd as string;
    throw new Error('private-secret');
  } }), /^Error: Radiator CLI failed to spawn$/);
  assert.equal(existsSync(cwd), false);
  for (const event of ['error', 'stdin', 'stdout', 'stderr', 'nonzero', 'signal']) {
    const f = fake(child => {
      if (event === 'error') child.emit('error', new Error('private-secret'));
      else if (event === 'nonzero' || event === 'signal') {
        child.stderr.write('private-secret'); child.emit('close', event === 'signal' ? null : 1);
      } else child[event as 'stdin' | 'stdout' | 'stderr'].emit('error', new Error('private-secret'));
    });
    await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn }), error => {
      assert.ok(error instanceof Error && !error.message.includes('private-secret')); return true;
    });
    assert.deepEqual(f.child.signals, event === 'nonzero' || event === 'signal' ? [] : ['SIGTERM', 'SIGKILL']);
    assert.equal(existsSync(f.calls[0][2].cwd as string), false);
  }
});

test('stdout/stderr overflow terminate even if a late valid success arrives', async () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const f = fake(child => {
      child[stream].write(Buffer.alloc(stream === 'stdout' ? 2 * 1024 * 1024 + 1 : 65_537));
      success(child);
    });
    await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn }), /exceeds bound/);
    assert.deepEqual(f.child.signals, ['SIGTERM']);
  }
});

test('timeout and abort reject once, ignore late completion, escalate finitely and remove listener', async () => {
  for (const mode of ['timeout', 'abort']) {
    const controller = new AbortController();
    const f = fake(mode === 'abort' ? () => controller.abort() : undefined);
    const promise = runRadiatorSonnet('p', { spawn: f.spawn, signal: controller.signal, timeoutMs: mode === 'timeout' ? 5 : 1000 });
    await assert.rejects(promise, mode === 'timeout' ? /timed out/ : /aborted/);
    success(f.child);
    f.child.emit('error', new Error('late private-secret'));
    controller.abort();
    assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
    await delay(20);
    assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(existsSync(f.calls[0][2].cwd as string), false);
  }
  const controller = new AbortController(); controller.abort();
  const f = fake();
  await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn, signal: controller.signal }), /aborted/);
  assert.equal(f.calls.length, 0);
});

test('cached input and multibyte output retain actual usage; successful completion removes abort handler', async () => {
  const controller = new AbortController();
  const value = receipt();
  value.result = '秘密';
  value.usage.input_tokens = 0;
  value.usage.cache_read_input_tokens = 12;
  value.modelUsage[MODEL].inputTokens = 0;
  const f = fake(child => {
    const bytes = Buffer.from(JSON.stringify(value));
    for (let i = 0; i < bytes.length; i++) child.stdout.write(bytes.subarray(i, i + 1));
    child.emit('close', 0);
  });
  const result = await runRadiatorSonnet('p', { spawn: f.spawn, signal: controller.signal });
  assert.equal(result.text, '秘密');
  assert.deepEqual(result.usage, value.usage);
  controller.abort();
  assert.deepEqual(f.child.signals, []);
});

test('synchronous success emitted by kill cannot override cancellation', async () => {
  const f = fake();
  f.child.kill = signal => {
    f.child.signals.push(signal);
    success(f.child);
    return true;
  };
  await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn, timeoutMs: 5 }), /timed out/);
  assert.deepEqual(f.child.signals, ['SIGTERM']);
});

test('abort during spawn is checked before sending prompt', async () => {
  const controller = new AbortController();
  const f = fake(undefined, () => controller.abort());
  await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn, signal: controller.signal }), /aborted/);
  assert.equal(f.child.stdin.read(), null);
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
});

test('aggregate and per-model token ceilings include cache reads and creation, accepting exact boundaries', async () => {
  const value = receipt();
  const usage = { input_tokens: 10_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 10_000, output_tokens: 8_000 };
  const modelUsage = { inputTokens: 10_000, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 10_000, outputTokens: 8_000 };
  const bounded = { ...value, usage, modelUsage: { [MODEL]: modelUsage } };
  assert.deepEqual((await runRadiatorSonnet('p', { spawn: fake(child => success(child, bounded)).spawn })).usage, usage);
  for (const [aggregateKey, modelKey] of [
    ['input_tokens', 'inputTokens'], ['cache_read_input_tokens', 'cacheReadInputTokens'],
    ['cache_creation_input_tokens', 'cacheCreationInputTokens'], ['output_tokens', 'outputTokens'],
  ]) {
    for (const scope of ['aggregate', 'model']) {
      const over = scope === 'aggregate'
        ? { ...bounded, usage: { ...usage, [aggregateKey]: usage[aggregateKey as keyof typeof usage] + 1 } }
        : { ...bounded, modelUsage: { [MODEL]: { ...modelUsage, [modelKey]: modelUsage[modelKey as keyof typeof modelUsage] + 1 } } };
      await assert.rejects(runRadiatorSonnet('p', { spawn: fake(child => success(child, over)).spawn }), /usage exceeds token bound/);
    }
  }
  for (const invalid of [-1, 0.5, Infinity, NaN, 'unknown', null]) {
    for (const cacheKey of ['cache_read_input_tokens', 'cache_creation_input_tokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
      const patched = cacheKey.includes('_')
        ? { ...bounded, usage: { ...usage, [cacheKey]: invalid } }
        : { ...bounded, modelUsage: { [MODEL]: { ...modelUsage, [cacheKey]: invalid } } };
      await assert.rejects(runRadiatorSonnet('p', { spawn: fake(child => success(child, patched)).spawn }), /missing actual usage/);
    }
  }
});

test('abort, timeout and overflow hold the serial caller and temporary settings until child disposal', async () => {
  for (const reason of ['abort', 'timeout', 'overflow']) {
    const controller = new AbortController();
    const f = fake(child => {
      if (reason === 'abort') controller.abort();
      if (reason === 'overflow') child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1));
    });
    let released = false;
    const promise = runRadiatorSonnet('p', { spawn: f.spawn, signal: controller.signal, timeoutMs: reason === 'timeout' ? 5 : 1000 });
    const rejected = assert.rejects(promise, reason === 'overflow' ? /exceeds bound/ : reason === 'timeout' ? /timed out/ : /aborted/);
    void promise.then(() => { released = true; }, () => { released = true; });
    await delay(20);
    assert.equal(released, false, `${reason}: serial caller must remain blocked during TERM grace`);
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    const cwd = f.calls[0][2].cwd as string;
    assert.equal(existsSync(join(cwd, 'settings.json')), true);
    // Late output/error cannot win; close is the disposal evidence for the fake child.
    f.child.stdout.write(JSON.stringify(receipt()));
    f.child.emit('error', new Error('late-secret'));
    await delay(5);
    assert.equal(released, false);
    f.child.emit('close', 0);
    await rejected;
    assert.equal(released, true);
    assert.equal(existsSync(cwd), false);
    await delay(260);
    assert.deepEqual(f.child.signals, ['SIGTERM'], 'confirmed disposal cancels escalation');
  }
});

test('TERM-resistant child holds caller until SIGKILL closes it', async () => {
  const controller = new AbortController();
  const f = fake(() => controller.abort());
  let released = false;
  const promise = runRadiatorSonnet('p', { spawn: f.spawn, signal: controller.signal });
  const rejected = assert.rejects(promise, /aborted/);
  void promise.catch(() => { released = true; });
  await delay(20);
  assert.equal(released, false);
  assert.deepEqual(f.child.signals, ['SIGTERM']);
  await rejected;
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(released, true);
});

test('missing close after SIGKILL has finite bounded teardown and reports unconfirmed disposal', async () => {
  const f = fake();
  f.child.kill = signal => { f.child.signals.push(signal); return true; };
  const started = performance.now();
  await assert.rejects(runRadiatorSonnet('p', { spawn: f.spawn, timeoutMs: 5 }), /timed out; termination not confirmed within bound/);
  assert.ok(performance.now() - started >= 500);
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(existsSync(f.calls[0][2].cwd as string), false);
});


test('unconfirmed real-group disposal latches off later real spawns but leaves injected fakes independent', async t => {
  const f = fake();
  const pid = 987_654_321;
  Object.assign(f.child, { pid });
  const signals: (string | number | undefined)[] = [];
  // Exercise the real-ownership branch without launching or signaling any host process.
  t.mock.method(childProcess, 'spawn', f.spawn as typeof childProcess.spawn);
  t.mock.method(process, 'kill', (target: number, signal?: string | number) => {
    assert.equal(target, -pid);
    signals.push(signal);
    return true; // Fake group survives TERM/KILL and existence probes.
  });
  syncBuiltinESMExports();
  try {
    if (process.platform === 'win32') { t.skip('POSIX process-group ownership only'); return; }
    await assert.rejects(runRadiatorSonnet('p', { timeoutMs: 5 }), /termination not confirmed within bound/);
    assert.equal(f.calls.length, 1);
    assert.ok(signals.includes('SIGTERM'));
    assert.ok(signals.includes('SIGKILL'));
    await assert.rejects(runRadiatorSonnet('p'), /disabled after unconfirmed process-group termination; restart required/);
    assert.equal(f.calls.length, 1, 'latched invocation must never spawn');
    assert.equal((await runRadiatorSonnet('p', { spawn: fake(success).spawn })).modelId, MODEL);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
