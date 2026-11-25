import { z, type ZodType } from 'zod';

import type { Logger, CompletionContext } from '../skills/types.js';
import { LLMSchemaError, LLMTransportError, parseStructuredOutput, type LLMProvider } from './provider.js';

// Story 4.2 — OpenAI-compatible HTTP provider. ONE class for cloud (API key) AND
// local open models (Ollama/LM-Studio) — they differ only by base-URL, never a
// subclass (FR-8). Uses native JSON-schema structured output, then STILL
// revalidates with `parseStructuredOutput` (models lie).

export interface HttpProviderConfig {
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected logger; the API key is NEVER passed to it (NFR-3). */
  logger?: Logger;
}

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Minimal zod → JSON-schema converter for the closed field-type subset board-oss
 * uses (objects of string/number/boolean/array/enum, optional/nullable). It only
 * GUIDES the model — the hard guarantee is `parseStructuredOutput` revalidating the
 * response — so best-effort coverage is fine (unknown nodes fall back to permissive).
 */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, ZodType>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(child);
      if (!(child instanceof z.ZodOptional)) required.push(key);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema((schema as z.ZodArray<ZodType>).element) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: (schema as z.ZodEnum<[string, ...string[]]>).options };
  }
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap() as ZodType);
  if (schema instanceof z.ZodNullable) {
    const inner = zodToJsonSchema(schema.unwrap() as ZodType);
    const t = inner.type;
    return { ...inner, type: Array.isArray(t) ? [...t, 'null'] : [t, 'null'] };
  }
  return {}; // permissive fallback — revalidation still enforces the real schema
}

export class HttpProvider implements LLMProvider {
  constructor(private readonly cfg: HttpProviderConfig) {}

  async complete<T>(prompt: string, schema: ZodType<T>, context?: CompletionContext): Promise<T> {
    context?.signal?.throwIfAborted();
    const fetchImpl = this.cfg.fetchImpl ?? globalThis.fetch;
    const logger = this.cfg.logger ?? noopLogger;
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`; // key lives here ONLY

    const body = JSON.stringify({
      model: this.cfg.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: {
        // NOT strict: OpenAI strict mode requires EVERY property in `required`
        // (optionals modeled as nullable), but a zod `.optional()` field rejects an
        // explicit null on revalidation — so strict + optional fields → a 400.
        // The schema still guides the model; `parseStructuredOutput` is the real
        // guarantee, so non-strict is both safe and broadly compatible (incl. local
        // models that ignore json_schema entirely).
        type: 'json_schema',
        json_schema: { name: 'result', schema: zodToJsonSchema(schema), strict: false },
      },
    });

    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body, signal: context?.signal });
    } catch (err) {
      logger.error(`HttpProvider request to ${url} failed: ${(err as Error).message}`);
      throw new LLMTransportError(`HTTP request to provider failed`, { cause: err });
    }
    if (!res.ok) {
      logger.error(`HttpProvider got HTTP ${res.status} from ${url}`);
      throw new LLMTransportError(`Provider returned HTTP ${res.status}`);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (err) {
      throw new LLMTransportError('Provider returned a non-JSON HTTP body', { cause: err });
    }

    const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
      ?.content;
    if (typeof content !== 'string') {
      throw new LLMSchemaError('Provider response had no message content');
    }
    context?.signal?.throwIfAborted();
    return parseStructuredOutput(content, schema);
  }
}
