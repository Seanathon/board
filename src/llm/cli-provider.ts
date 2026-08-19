import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ZodType } from 'zod';

import { buildAnalysisCommand, parseJsonFromText, extractAnalysisPayload, toCodexOutputSchema } from '../add.js';
import type { Logger } from '../skills/types.js';
import { zodToJsonSchema } from './http-provider.js';
import { LLMSchemaError, LLMTransportError, type LLMProvider } from './provider.js';

// Story 4.3 — CliProvider: drives a coding-agent CLI (claude / codex) so users can
// enrich WITHOUT an API key (their subscription). This is a hardened PORT of the
// prototype's CLI analysis: the argv-build + output-parse helpers
// (buildAnalysisCommand / parseJsonFromText / extractAnalysisPayload /
// toCodexOutputSchema) are REUSED from add.ts (characterization-pinned, not forked).
//
// Net-new hardening over the prototype's `spawnSync` (which had maxBuffer but NO
// timeout): async `spawn` + a wall-clock timeout that kills the child, non-zero
// exit → typed error, stderr captured. `cursor` is out of v1 scope (the prototype
// only implements claude + codex).

/** A minimal child-process surface — injectable so tests use a fake (no subprocess). */
export interface CliChild {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void };
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void };
  on(event: 'close' | 'error', cb: (arg: number | Error) => void): void;
  kill(signal?: string): void;
}

export type SpawnFn = (command: string, args: string[], opts: { cwd?: string }) => CliChild;

export interface CliAgent {
  id: 'claude' | 'codex';
  model: string | null;
}

export interface CliProviderConfig {
  agent: CliAgent;
  /** Appended-system-prompt for claude / guidance; defaults to a generic instruction. */
  systemPrompt?: string;
  /** Injected for tests; defaults to node's child_process.spawn (pipe stdio). */
  spawn?: SpawnFn;
  /** Injected for tests; reads the codex result file. Defaults to fs.readFileSync. */
  readFile?: (path: string) => string;
  /** Injected for tests; writes the codex schema file. Defaults to fs.writeFileSync. */
  writeFile?: (path: string, data: string) => void;
  /** Wall-clock timeout (ms) before the child is killed. */
  timeoutMs?: number;
  logger?: Logger;
}

// Wall-clock ceiling for one agent subprocess. Generous on purpose: a self-hosted,
// single-tenant box has nobody queued behind this call, so a read that takes four
// minutes and returns beats one killed at two that leaves the item un-enriched. Sized
// to sit inside config.captureTimeoutMs alongside the capture that precedes it.
const DEFAULT_TIMEOUT_MS = 300_000;
// Bound captured output so a runaway agent can't exhaust memory on the small LXC
// (mirrors the prototype's spawnSync maxBuffer, which the async port must preserve).
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_SYSTEM_PROMPT = 'Return ONLY a JSON object matching the provided schema. No prose, no code fences.';
const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const defaultSpawn: SpawnFn = (command, args, opts) =>
  nodeSpawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as CliChild;

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a child to completion with a wall-clock timeout that kills it. */
function runProcess(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawnFn(command, args, { cwd });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new LLMTransportError(`CLI agent "${command}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const overflow = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new LLMTransportError(`CLI agent "${command}" exceeded ${MAX_OUTPUT_BYTES} bytes of output`));
    };
    child.stdout.on('data', (c) => {
      stdout += c.toString();
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) overflow();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) overflow();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LLMTransportError(`Failed to spawn "${command}": ${(err as Error).message}`, { cause: err }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr });
    });
  });
}

export class CliProvider implements LLMProvider {
  constructor(private readonly cfg: CliProviderConfig) {}

  async complete<T>(prompt: string, schema: ZodType<T>): Promise<T> {
    const { agent } = this.cfg;
    const spawnFn = this.cfg.spawn ?? defaultSpawn;
    const readFile = this.cfg.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
    const writeFile = this.cfg.writeFile ?? ((p: string, data: string) => writeFileSync(p, data));
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const logger = this.cfg.logger ?? noopLogger;
    const systemPrompt = this.cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    const jsonSchema = zodToJsonSchema(schema);
    const tempDir = mkdtempSync(join(tmpdir(), 'board-cli-'));
    const schemaFile = join(tempDir, 'schema.json');
    const resultFile = join(tempDir, 'result.json');

    try {
      // codex needs a stricter schema (additionalProperties:false, all-required).
      const outputSchema = agent.id === 'codex' ? toCodexOutputSchema(jsonSchema) : jsonSchema;
      writeFile(schemaFile, JSON.stringify(outputSchema));

      const { command, args } = buildAnalysisCommand(agent, prompt, jsonSchema as object, systemPrompt, {
        schemaFile,
        resultFile,
      });

      const { code, stdout, stderr } = await runProcess(spawnFn, command, args, tempDir, timeoutMs);
      if (code !== 0) {
        logger.error(`CLI agent "${command}" exited ${code}: ${stderr.slice(0, 500)}`);
        throw new LLMTransportError(`CLI agent "${command}" exited ${code}`);
      }

      // claude returns on stdout; codex writes to the result FILE.
      const raw = agent.id === 'codex' ? readFile(resultFile) : stdout;

      let parsed: unknown;
      try {
        parsed = extractAnalysisPayload(parseJsonFromText(raw));
      } catch (err) {
        throw new LLMSchemaError('CLI agent output was not parseable JSON', { cause: err });
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new LLMSchemaError(`CLI agent output failed schema: ${detail}`, { cause: result.error });
      }
      return result.data;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
