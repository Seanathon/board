import type { z, ZodType } from 'zod';

import type { DbHandle } from '../db/index.js';

// Story 3.1 — the Skill contract, the injected Ctx, and the LLMProvider seam.
//
// Every capability is a typed Skill invoked through one generic route (AD11). The
// zod in/out schemas are mandatory — they double as the future MCP tool schemas
// (FR-19), so external agent operability later is an adapter, not a rewrite.
// `run` reaches NOTHING global: db/llm/queue/logger all arrive via `ctx`, so every
// skill is mockable in-process. Skills compose by calling each other as plain
// functions — there is no event bus / scheduler (that would be a second runtime).

/** Minimal logger interface (the prototype uses `console`; no logging lib). */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * The write-serialization seam carried on ctx (Story 1.3 provides the impl; Story
 * 5.1 extends it into the job worker). Kept minimal here.
 */
export interface JobQueue {
  enqueueWrite<T>(fn: () => T | Promise<T>): Promise<T>;
}

/**
 * The canonical LLM provider interface (architecture §4.2). Epic 4 implements the
 * HTTP + CLI transports against THIS type — it does not redefine it.
 */
export interface CompletionContext {
  itemId: string;
  boardId: string;
  source: string | null;
  signal?: AbortSignal;
}

export interface LLMProvider {
  complete<T>(prompt: string, schema: ZodType<T>, context?: CompletionContext): Promise<T>;
}

/** Thrown by `disabledLlm.complete` when no provider is configured (no-AI mode). */
export class EnrichmentDisabledError extends Error {
  constructor(message = 'LLM provider is not configured (enrichment disabled).') {
    super(message);
    this.name = 'EnrichmentDisabledError';
  }
}

/**
 * The default `ctx.llm` when no provider is configured. A THROWING SENTINEL (not
 * null, not a value-returning null-object): `complete` always throws
 * `EnrichmentDisabledError`. Every caller treats that as "enrichment unavailable →
 * degrade gracefully" (Epic 7 / Story 8.5), never as a fatal error. Because it
 * implements the real interface, callers never branch on `llm == null`.
 */
export const disabledLlm: LLMProvider = {
  async complete<T>(): Promise<T> {
    throw new EnrichmentDisabledError();
  },
};

/** Injected dependencies every skill's `run` receives — nothing global. */
export interface Ctx {
  db: DbHandle;
  llm: LLMProvider;
  queue: JobQueue;
  logger: Logger;
  /** The board a skill operates on, when scoped (matches §5 item.board_id). */
  boardId?: string;
}

export interface Skill<I, O> {
  name: string;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  run(input: I, ctx: Ctx): Promise<O>;
}

/**
 * Define a skill, INFERRING the input/output TS types from the zod schemas so
 * authors never hand-write `Skill<I,O>` generics (avoids ZodType variance pain).
 */
export function defineSkill<IS extends ZodType, OS extends ZodType>(
  name: string,
  inputSchema: IS,
  outputSchema: OS,
  run: (input: z.infer<IS>, ctx: Ctx) => Promise<z.infer<OS>>,
): Skill<z.infer<IS>, z.infer<OS>> {
  return { name, inputSchema, outputSchema, run };
}

/**
 * Assemble a `ctx`. `llm` defaults to `disabledLlm` so `ctx.llm` is never null. The
 * server (Story 3.2) builds the real ctx (config-selected provider or disabledLlm);
 * tests build a mock ctx with spies.
 */
export function buildCtx(args: {
  db: DbHandle;
  queue: JobQueue;
  logger: Logger;
  llm?: LLMProvider;
  boardId?: string;
}): Ctx {
  return {
    db: args.db,
    queue: args.queue,
    logger: args.logger,
    llm: args.llm ?? disabledLlm,
    boardId: args.boardId,
  };
}
