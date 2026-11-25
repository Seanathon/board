import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { runProviderConformance } from './conformance.js';
import { LLMSchemaError, LLMTransportError } from './provider.js';
import { HttpProvider } from './http-provider.js';

// A fake OpenAI-compatible Response carrying the model output as message content.
function okResponse(modelOutput: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: modelOutput } }] }),
  } as unknown as Response;
}

describe('HttpProvider (Story 4.2)', () => {
  const schema = z.object({ title: z.string(), n: z.number() });

  // AC 4 — request shape (URL, auth header, JSON body incl. schema + model) + parse
  it('issues an OpenAI-compatible request with the schema and parses the response', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return okResponse('{"title":"hi","n":7}');
    }) as unknown as typeof fetch;

    const provider = new HttpProvider({ baseUrl: 'http://localhost:1234/v1', apiKey: 'testkey', model: 'm', fetchImpl });
    const out = await provider.complete('do it', schema);
    assert.deepEqual(out, { title: 'hi', n: 7 });

    assert.equal(captured?.url, 'http://localhost:1234/v1/chat/completions');
    const headers = captured?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer testkey');
    const body = JSON.parse(captured?.init.body as string);
    assert.equal(body.model, 'm');
    assert.ok(body.messages?.some((m: { content: string }) => m.content === 'do it'));
    // the zod schema is embedded as a JSON schema
    const js = body.response_format?.json_schema?.schema;
    assert.ok(js?.properties?.title && js?.properties?.n, 'schema must be embedded in the request');
  });

  // Regression: a schema with an OPTIONAL field must not use strict mode (strict +
  // optionals → 400 from real OpenAI) and must still parse when the field is absent.
  it('handles schemas with optional fields without strict mode', async () => {
    let body: { response_format?: { json_schema?: { strict?: boolean } } } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return okResponse('{"title":"x"}'); // optional `n` omitted
    }) as unknown as typeof fetch;
    const optSchema = z.object({ title: z.string(), n: z.number().optional() });
    const provider = new HttpProvider({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetchImpl });
    const out = await provider.complete('p', optSchema);
    assert.deepEqual(out, { title: 'x' });
    assert.equal(body?.response_format?.json_schema?.strict, false, 'strict must be false');
  });

  // AC 2 — open model is the same class with a different base-URL (no key needed)
  it('works against a keyless local base-URL (no Authorization header)', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return okResponse('{"title":"x","n":1}');
    }) as unknown as typeof fetch;
    const provider = new HttpProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: null, model: 'llama', fetchImpl });
    await provider.complete('p', schema);
    assert.equal(headers.authorization, undefined, 'no auth header when no key');
  });

  // AC 1/4 — schema-violating response → typed LLMSchemaError
  it('throws LLMSchemaError on a schema-violating response', async () => {
    const fetchImpl = (async () => okResponse('{"title":"x","n":"bad"}')) as unknown as typeof fetch;
    const provider = new HttpProvider({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetchImpl });
    await assert.rejects(() => provider.complete('p', schema), (e: unknown) => e instanceof LLMSchemaError);
  });

  // AC 5 — the API key never appears in logs on the error path
  it('never logs the API key (transport failure path)', async () => {
    const logged: string[] = [];
    const logger = { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) };
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const provider = new HttpProvider({ baseUrl: 'http://x/v1', apiKey: 'super-secret-key-xyz', model: 'm', fetchImpl, logger });
    await assert.rejects(() => provider.complete('p', schema), (e: unknown) => e instanceof LLMTransportError);
    assert.ok(logged.length > 0, 'the error path should log something');
    for (const line of logged) assert.doesNotMatch(line, /super-secret-key-xyz/, 'key must never be logged');
  });

  // AC 3 — passes the shared conformance suite via the fake-fetch seam
  runProviderConformance({
    label: 'HttpProvider',
    makeProviderReturning: (raw) =>
      new HttpProvider({
        baseUrl: 'http://x/v1',
        apiKey: 'k',
        model: 'm',
        fetchImpl: (async () => okResponse(raw)) as unknown as typeof fetch,
      }),
  });
});

it('HTTP completion propagates scoped cancellation and refuses already-aborted work', async () => {
  const controller = new AbortController(); let calls = 0;
  const provider = new HttpProvider({ baseUrl: 'http://provider.invalid', model: 'configured-model', fetchImpl: (async (_url, init) => {
    calls++; assert.equal(init?.signal, controller.signal);
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  }) as typeof fetch });
  const context = { itemId: 'i', boardId: 'b', source: null, signal: controller.signal, purpose: 'discovery' as const };
  const work = provider.complete('p', z.object({ action: z.string() }), context);
  controller.abort(); await assert.rejects(work, /HTTP request/);
  await assert.rejects(provider.complete('p', z.object({}), context)); assert.equal(calls, 1);
});
