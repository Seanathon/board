import type { ZodType } from 'zod';

// Story 4.1 — the LLM provider seam's shared error types + parse helper.
//
// The `LLMProvider` interface itself is owned by Story 3.1 (skills/types.ts) so
// `ctx.llm` has a type; we RE-EXPORT it here for cohesion, never redefine it.
// (Architecture §6's "llm/provider.ts # interface + conformance" comment is stale —
// 3.1 took the interface.)
export type { LLMProvider } from '../skills/types.js';
export { EnrichmentDisabledError } from '../skills/types.js';

/**
 * The model produced output that isn't valid for the requested schema (malformed
 * JSON or a schema violation). Distinct from a transport failure so callers
 * (4.4 selection, 7.1 enrichment, 8.5 degrade) can tell "bad output" from
 * "backend unreachable".
 */
export class LLMSchemaError extends Error {
  /** The model's raw output, kept for operator-side failure evidence (never shown in the UI). */
  readonly rawOutput?: string;
  constructor(message: string, options?: { cause?: unknown; rawOutput?: string }) {
    super(message, options);
    this.name = 'LLMSchemaError';
    if (options?.rawOutput !== undefined) this.rawOutput = options.rawOutput;
  }
}

/** The backend was unreachable / returned a non-success status / exited non-zero. */
export class LLMTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LLMTransportError';
  }
}

/**
 * Parse a raw model-output string into a schema-valid `T`. The single reference
 * implementation every transport reuses: JSON.parse the model's text, then
 * revalidate against the caller's zod schema. A parse/validation failure is a
 * `LLMSchemaError` (the model's fault), NOT a transport error.
 */
export function parseStructuredOutput<T>(raw: string, schema: ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new LLMSchemaError('Provider returned non-JSON output', { cause: err, rawOutput: raw });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new LLMSchemaError(`Provider output failed schema: ${detail}`, { cause: result.error, rawOutput: raw });
  }
  return result.data;
}
