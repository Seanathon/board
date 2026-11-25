import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { runProviderConformance } from './conformance.js';
import {
  parseStructuredOutput,
  LLMSchemaError,
  LLMTransportError,
  type LLMProvider,
} from './provider.js';

// The reference seam: a provider whose "backend" emits the given raw model output
// string. 4.2 (HTTP) and 4.3 (CLI) mirror this by wrapping `raw` into a fake fetch
// body / fake spawner stdout — but all of them end in `parseStructuredOutput`.
const makeProviderReturning = (raw: string): LLMProvider => ({
  complete: async (_prompt, schema) => parseStructuredOutput(raw, schema),
});

// AC 1/2/3/4 — the single shared contract, run against the FakeProvider seam.
runProviderConformance({ label: 'FakeProvider', makeProviderReturning });

describe('LLM typed errors (Story 4.1)', () => {
  it('LLMSchemaError and LLMTransportError are distinct, named, instanceof-able', () => {
    const s = new LLMSchemaError('x');
    const t = new LLMTransportError('y');
    assert.ok(s instanceof LLMSchemaError);
    assert.ok(s instanceof Error);
    assert.equal(s.name, 'LLMSchemaError');
    assert.ok(t instanceof LLMTransportError);
    assert.equal(t.name, 'LLMTransportError');
    assert.ok(!(t instanceof LLMSchemaError), 'transport error must be distinct from schema error');
  });

  it('parseStructuredOutput throws LLMSchemaError on non-JSON output', () => {
    assert.throws(
      () => parseStructuredOutput('not json at all', z.object({})),
      (e: unknown) => e instanceof LLMSchemaError,
    );
  });

  it('parseStructuredOutput returns the parsed object on valid output', () => {
    const out = parseStructuredOutput('{"a":1}', z.object({ a: z.number() }));
    assert.deepEqual(out, { a: 1 });
  });
});

describe('LLMSchemaError keeps the raw model output for failure evidence', () => {
  const schema = z.object({ a: z.string() });
  it('on non-JSON output', () => {
    assert.throws(() => parseStructuredOutput('not json', schema), (e: LLMSchemaError) => e.rawOutput === 'not json');
  });
  it('on a schema violation', () => {
    assert.throws(() => parseStructuredOutput('{"a":1}', schema), (e: LLMSchemaError) => e.rawOutput === '{"a":1}');
  });
});
