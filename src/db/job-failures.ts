import { appendFileSync, chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Failure evidence. `cleanErrorReason` deliberately keeps the user-facing reason short
// and safe, which also made failures undiagnosable: the real exception was dropped and
// receipts exist only for SUCCESSFUL analyses. This module is the operator-side record:
// which stage failed, the scrubbed error, and (when the provider kept it) the raw model
// output. It is never shown in the UI and never throws into a job.

export interface JobFailure {
  at: string;
  itemId: string;
  jobType: string;
  /** capture | discovery | analysis | validation | write | timeout | unknown */
  stage: string;
  name: string;
  /** Scrubbed, one line, bounded. */
  message: string;
  /** The user-safe reason the item card shows. */
  category: string;
  /** Raw model output file (relative to the failure dir), when one was kept. */
  rawOutputFile?: string;
}

export interface JobFailureSink {
  record(failure: JobFailure, rawOutput?: string): void;
}

let sink: JobFailureSink | undefined;

/** Install (or clear, with undefined) the process-wide failure sink. */
export function setJobFailureSink(next: JobFailureSink | undefined): void {
  sink = next;
}

/** Never throws: evidence is best-effort and must not turn one failure into two. */
export function reportJobFailure(failure: JobFailure, rawOutput?: string): void {
  try {
    sink?.record(failure, rawOutput);
  } catch {
    /* evidence is best-effort */
  }
}

/**
 * Operator-facing description of a failure for logs and failure records (NOT shown in
 * the UI): `Name: message`, one line, bounded, with obvious credentials masked.
 */
export function describeJobError(err: unknown): string {
  const name = (err as { name?: string })?.name || 'Error';
  const message = String((err as Error)?.message ?? err)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2***')
    .trim();
  return `${name}: ${message.length > 300 ? `${message.slice(0, 300)}…` : message}`;
}

/** The stage recorded on an error by `inStage` (or by a provider), else `unknown`. */
export function failureStage(err: unknown): string {
  const stage = (err as { stage?: unknown })?.stage;
  return typeof stage === 'string' && /^[a-z-]{1,24}$/.test(stage) ? stage : 'unknown';
}

/** Raw model output a provider attached to the error (or its cause), if any. */
export function failureRawOutput(err: unknown): string | undefined {
  for (const candidate of [err, (err as { cause?: unknown })?.cause]) {
    const raw = (candidate as { rawOutput?: unknown })?.rawOutput;
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return undefined;
}

/**
 * Run `fn`, tagging any error it throws with `stage` unless a more specific stage was
 * already set deeper (the innermost stage wins). The error object is otherwise untouched.
 */
export async function inStage<T>(stage: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err === 'object' && !('stage' in err)) {
      try {
        Object.defineProperty(err, 'stage', { value: stage, enumerable: false, configurable: true });
      } catch {
        /* frozen error: leave the stage unknown */
      }
    }
    throw err;
  }
}

const MAX_RAW_BYTES = 64 * 1024;
const MAX_RAW_FILES = 200;

/** JSONL + raw-output files under `dir`, created lazily with owner-only permissions. */
export function createFileFailureSink(dir: string): JobFailureSink {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 64);
  return {
    record(failure, rawOutput) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record: JobFailure = { ...failure };
      if (rawOutput) {
        const file = `${safe(failure.itemId)}-${Date.now()}.raw.txt`;
        const clipped = Buffer.from(rawOutput).subarray(0, MAX_RAW_BYTES).toString('utf8');
        writeFileSync(path.join(dir, file), clipped, { mode: 0o600 });
        record.rawOutputFile = file;
        prune(dir);
      }
      const log = path.join(dir, 'failures.jsonl');
      appendFileSync(log, JSON.stringify(record) + '\n', { mode: 0o600 });
      chmodSync(log, 0o600);
    },
  };
}

function prune(dir: string): void {
  const raws = readdirSync(dir).filter((f) => f.endsWith('.raw.txt'));
  if (raws.length <= MAX_RAW_FILES) return;
  const aged = raws.map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const { f } of aged.slice(0, raws.length - MAX_RAW_FILES)) unlinkSync(path.join(dir, f));
}
