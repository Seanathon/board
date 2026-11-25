import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildEnrichmentSchema } from '../enrichment/worker.js';
import { CliProvider, type CliChild, type SpawnFn } from './cli-provider.js';
import { LLMSchemaError } from './provider.js';
import type { BoardDescriptor } from '../descriptor/types.js';

// Contract: how realistic model-output variants behave end to end through the real
// CliProvider (parse -> repair -> schema), against a descriptor with every field type
// the model can emit. Pinned so a change in tolerance is a deliberate decision.

const descriptor = {
  view: 'grid',
  ingest_mode: 'test',
  enrichment_prompt: 'x',
  fields: [
    { key: 'summary', label: 'Summary', type: 'text', enrichable: true },
    { key: 'relevance', label: 'Relevance', type: 'enum', enrichable: true, values: ['direct-competitor', 'adjacent', 'unclassified'] },
    { key: 'tags', label: 'Tags', type: 'tags', enrichable: true },
    { key: 'score', label: 'Score', type: 'number', enrichable: true },
    { key: 'screenshot', label: 'Shot', type: 'image', enrichable: true },
    { key: 'my_notes', label: 'Notes', type: 'text', enrichable: false },
  ],
} as unknown as BoardDescriptor;
const schema = buildEnrichmentSchema(descriptor);

function run(stdout: string) {
  const spawn: SpawnFn = () => ({
    stdout: { on: (ev, cb) => { if (ev === 'data') queueMicrotask(() => cb(Buffer.from(stdout))); } },
    stderr: { on: () => {} },
    on: (ev, cb) => { if (ev === 'close') queueMicrotask(() => (cb as (c: number) => void)(0)); },
    kill: () => {},
  } as CliChild);
  return new CliProvider({ agent: { id: 'claude', model: null }, spawn, timeoutMs: 1000, retryDelayMs: 0 }).complete('p', schema);
}

const good = { summary: 'A product.', relevance: 'adjacent', tags: ['a', 'b'], score: 3 };
const goodJson = JSON.stringify(good, null, 2);

describe('model output contract: accepted variants keep every good field', () => {
  const accepted: Array<[string, string, Record<string, unknown>]> = [
    ['plain JSON', goodJson, good],
    ['fenced ```json block', '```json\n' + goodJson + '\n```', good],
    ['fenced block without language', '```\n' + goodJson + '\n```', good],
    ['prose before and after', 'Here is the analysis:\n' + goodJson + '\nLet me know if you need more.', good],
    ['trailing comma', goodJson.replace(/\n\}$/, ',\n}'), good],
    ['last field written with no value (the dropped-value failure shape)', goodJson.replace('"score": 3', '"score"'), { summary: 'A product.', relevance: 'adjacent', tags: ['a', 'b'] }],
    ['dangling key in the middle', goodJson.replace('"relevance": "adjacent",', '"relevance",'), { summary: 'A product.', tags: ['a', 'b'], score: 3 }],
    ['unknown extra field is dropped, not an error', JSON.stringify({ ...good, confidence: 0.9 }), good],
    ['optional fields omitted', JSON.stringify({ summary: 'only this' }), { summary: 'only this' }],
    ['enrichable:false and image fields are not model-emittable and are dropped', JSON.stringify({ ...good, my_notes: 'hijack', screenshot: 'x.png' }), good],
  ];
  for (const [name, raw, expected] of accepted) {
    it(name, async () => assert.deepEqual(await run(raw), expected));
  }
});

describe('model output contract: rejected variants fail as LLMSchemaError and keep the raw output', () => {
  const rejected: Array<[string, string]> = [
    ['empty output', ''],
    ['prose with no JSON', 'I could not analyse this page.'],
    ['truncated JSON', goodJson.slice(0, goodJson.length - 12)],
    ['enum value outside the declared set', JSON.stringify({ ...good, relevance: 'competitor' })],
    ['enum with different casing (strict; coercion is a validator-level decision)', JSON.stringify({ ...good, relevance: 'Adjacent' })],
    ['number given as a string', JSON.stringify({ ...good, score: '3' })],
    ['tags given as one string', JSON.stringify({ ...good, tags: 'a, b' })],
    ['two values glued without a colon (not guessed at)', '{"summary":"a" "relevance":"adjacent"}'],
  ];
  for (const [name, raw] of rejected) {
    it(name, async () => {
      await assert.rejects(run(raw), (e: unknown) => e instanceof LLMSchemaError && (raw === '' || (e as LLMSchemaError).rawOutput === raw));
    });
  }
});
