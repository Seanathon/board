import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RADIATOR_SONNET_MODEL = 'claude-sonnet-5-5' as const;
const MAX_PROMPT_BYTES = 100_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 240_000;
const KILL_GRACE_MS = 250;
const MAX_INPUT_TOKENS = 40_000;
const MAX_OUTPUT_TOKENS = 8_000;
// A possibly surviving real process group must not overlap the next serial job.
let realTerminationUnconfirmed = false;

export type RadiatorSpawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export interface RadiatorSonnetOptions {
  signal?: AbortSignal;
  /** Trusted local CLI configuration, never supplied by a saved page or prompt. */
  settingsFile?: string;
  spawn?: RadiatorSpawn;
  timeoutMs?: number;
  /** Trusted local executable, not a shell command. */
  command?: string;
}
export interface RadiatorSonnetResult {
  text: string;
  modelId: typeof RADIATOR_SONNET_MODEL;
  sessionId: string;
  usage: Record<string, unknown> & { input_tokens: number; output_tokens: number };
  elapsedMs: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function tokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function parseResult(raw: string, elapsedMs: number): RadiatorSonnetResult {
  let result: unknown;
  try { result = JSON.parse(raw); } catch { throw new Error('Radiator CLI returned malformed JSON'); }
  if (!object(result) || result.is_error || result.type !== 'result' || result.subtype !== 'success') {
    throw new Error('Radiator CLI did not return a successful result');
  }
  const models = result.modelUsage;
  if (!object(models) || Object.keys(models).length !== 1 || !Object.hasOwn(models, RADIATOR_SONNET_MODEL)) {
    throw new Error('Radiator CLI effective model mismatch or missing model usage');
  }
  const modelUsage = models[RADIATOR_SONNET_MODEL];
  const usage = result.usage;
  if (!object(modelUsage) || !object(usage)) throw new Error('Radiator CLI missing actual usage');
  for (const [counters, inputKey, outputKey, cacheKeys] of [
    [usage, 'input_tokens', 'output_tokens', ['cache_read_input_tokens', 'cache_creation_input_tokens']],
    [modelUsage, 'inputTokens', 'outputTokens', ['cacheReadInputTokens', 'cacheCreationInputTokens']],
  ] as const) {
    const input = counters[inputKey];
    const output = counters[outputKey];
    if (!tokens(input) || !tokens(output) || output === 0 || cacheKeys.some(key => key in counters && !tokens(counters[key]))) {
      throw new Error('Radiator CLI missing actual usage');
    }
    const totalInput = input + cacheKeys.reduce((sum, key) => sum + (counters[key] as number ?? 0), 0);
    if (totalInput > MAX_INPUT_TOKENS || output > MAX_OUTPUT_TOKENS) throw new Error('Radiator CLI usage exceeds token bound');
  }
  if (typeof result.session_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.session_id)) {
    throw new Error('Radiator CLI missing valid session ID');
  }
  if (typeof result.result !== 'string' || !result.result.trim() || Buffer.byteLength(result.result) > 32_768) {
    throw new Error('Radiator CLI returned empty or oversized text');
  }
  return {
    text: result.result, modelId: RADIATOR_SONNET_MODEL, sessionId: result.session_id,
    usage: usage as RadiatorSonnetResult['usage'], elapsedMs,
  };
}

/** Subscription CLI only: no generic provider fallback, SDK, tools, or inference HTTP. */
export async function runRadiatorSonnet(prompt: string, options: RadiatorSonnetOptions = {}): Promise<RadiatorSonnetResult> {
  const started = performance.now();
  if (!options.spawn && realTerminationUnconfirmed) {
    throw new Error('Radiator CLI disabled after unconfirmed process-group termination; restart required');
  }
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    throw new Error('Radiator prompt is empty or exceeds 100000 bytes');
  }
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new Error('Invalid Radiator timeout');
  const command = options.command ?? 'claude';
  if (!command || command.includes('\0')) throw new Error('Invalid Radiator executable');
  if (options.signal?.aborted) throw new Error('Radiator CLI aborted');

  // A private cwd also prevents repository instructions/settings from entering this data-only run.
  const directory = mkdtempSync(join(tmpdir(), 'board-radiator-'));
  try {
    let settings: Record<string, unknown> = {};
    const settingsFile = options.settingsFile ?? process.env.RADIATOR_CLAUDE_SETTINGS_FILE;
    if (settingsFile !== undefined) {
      try {
        const fd = openSync(settingsFile, 'r');
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error();
          const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
          // Bounded even if the trusted file grows after fstat.
          const size = readSync(fd, bytes, 0, bytes.length, 0);
          if (size > MAX_SETTINGS_BYTES) throw new Error();
          const parsed: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
          if (!object(parsed)) throw new Error();
          settings = parsed;
        } finally { closeSync(fd); }
      } catch { throw new Error('Invalid Radiator local settings file'); }
    }
    const pluginConfigs = object(settings.pluginConfigs) ? { ...settings.pluginConfigs } : {};
    const enabledPlugins = object(settings.enabledPlugins) ? { ...settings.enabledPlugins } : {};
    for (const namespace of ['jev-model-router', 'jev-model-router@inline']) {
      const config = object(pluginConfigs[namespace]) ? pluginConfigs[namespace] : {};
      pluginConfigs[namespace] = { ...config, options: {
        ...(object(config.options) ? config.options : {}), enabled: false, routeMainModel: false,
        routeMainEffort: false, routeSubagentModel: false, classifyTurns: false,
      } };
      enabledPlugins[namespace] = false;
    }
    const localSettings = join(directory, 'settings.json');
    writeFileSync(localSettings, JSON.stringify({ ...settings, pluginConfigs, enabledPlugins, disableAllHooks: true }), { mode: 0o600 });
    const args = ['--bare', '--settings', localSettings, '--model', RADIATOR_SONNET_MODEL,
      '--effort', 'medium', '--tools', '', '--print', '--output-format', 'json',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    return await new Promise<RadiatorSonnetResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      let settled = false;
      let closed = false;
      let failure: Error | undefined;
      let outputBytes = 0;
      let stderrBytes = 0;
      const chunks: Buffer[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;
      let disposalTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => fail('Radiator CLI aborted');
      const finish = (error?: Error, result?: RadiatorSonnetResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(escalationTimer);
        clearTimeout(disposalTimer);
        options.signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result!);
      };
      const ownsGroup = () => !options.spawn && process.platform !== 'win32' && child.pid !== undefined;
      const disposed = () => {
        if (!ownsGroup()) return closed;
        try { process.kill(-child.pid!, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      };
      const finishDisposal = () => {
        if (!disposed()) return false;
        finish(failure);
        return true;
      };
      const kill = (signal: NodeJS.Signals) => {
        try {
          // Only real detached children have a process group we own. Injected fakes never signal host PIDs.
          if (ownsGroup()) process.kill(-child.pid!, signal);
          else child.kill(signal);
        } catch { /* Check disappearance separately; a signal attempt alone is not disposal. */ }
      };
      function fail(message: string) {
        if (settled || failure) return;
        // Lock out late success immediately, but keep the caller's serial lane until teardown completes.
        failure = new Error(message);
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (!child) { finish(failure); return; }
        if (finishDisposal()) return;
        kill('SIGTERM');
        if (settled || finishDisposal()) return;
        escalationTimer = setTimeout(() => {
          kill('SIGKILL');
          if (settled || finishDisposal()) return;
          disposalTimer = setTimeout(() => {
            if (!finishDisposal()) {
              if (ownsGroup()) realTerminationUnconfirmed = true;
              finish(new Error(`${failure!.message}; termination not confirmed within bound`));
            }
          }, KILL_GRACE_MS);
        }, KILL_GRACE_MS);
      }
      if (options.signal?.aborted) { fail('Radiator CLI aborted'); return; }
      try {
        child = (options.spawn ?? nodeSpawn)(command, args, { cwd: directory, shell: false, detached: process.platform !== 'win32', stdio: 'pipe' });
      } catch { fail('Radiator CLI failed to spawn'); return; }
      child.on('error', () => fail('Radiator CLI process error'));
      child.stdin.on('error', () => fail('Radiator CLI input error'));
      child.stdout.on('error', () => fail('Radiator CLI output error'));
      child.stderr.on('error', () => fail('Radiator CLI stderr error'));
      child.stdout.on('data', (chunk: Buffer | string) => {
        if (settled || failure) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += bytes.length;
        if (outputBytes > MAX_OUTPUT_BYTES) { fail('Radiator CLI output exceeds bound'); return; }
        chunks.push(bytes);
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        if (settled || failure) return;
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_STDERR_BYTES) fail('Radiator CLI stderr exceeds bound');
      });
      child.on('close', (code: number | null) => {
        closed = true;
        if (settled) return;
        if (failure) { finishDisposal(); return; }
        if (options.signal?.aborted) { fail('Radiator CLI aborted'); return; }
        if (code !== 0) { fail('Radiator CLI exited unsuccessfully'); return; }
        try { finish(undefined, parseResult(Buffer.concat(chunks).toString('utf8'), performance.now() - started)); }
        catch (error) { fail((error as Error).message); }
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => fail('Radiator CLI timed out'), timeoutMs);
      if (options.signal?.aborted) { abort(); return; }
      try { child.stdin.end(prompt); } catch { fail('Radiator CLI input error'); }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
