import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseJsonWithRepairs } from './json-repair.js';
import { parseJsonFromText, parseJsonFromTextWithRepairs } from './add.js';

describe('parseJsonWithRepairs', () => {
  it('returns valid JSON untouched with no repairs', () => {
    const r = parseJsonWithRepairs('{"a":"x","b":["y"]}');
    assert.deepEqual(r.value, { a: 'x', b: ['y'] });
    assert.deepEqual(r.repairs, []);
  });

  it('drops a key whose value was omitted before a comma', () => {
    const r = parseJsonWithRepairs('{\n  "a": "keep",\n  "b",\n  "c": "also keep"\n}');
    assert.deepEqual(r.value, { a: 'keep', c: 'also keep' });
    assert.deepEqual(r.repairs, [{ kind: 'dangling-key', key: 'b' }]);
  });

  it('drops a key left dangling at the end of the object, and its leading comma', () => {
    const r = parseJsonWithRepairs('{"a":"keep","b"}');
    assert.deepEqual(r.value, { a: 'keep' });
    const only = parseJsonWithRepairs('{"b"}');
    assert.deepEqual(only.value, {});
  });

  it('drops a key with a colon but no value', () => {
    assert.deepEqual(parseJsonWithRepairs('{"a":1,"b": ,"c":3}').value, { a: 1, c: 3 });
    assert.deepEqual(parseJsonWithRepairs('{"a":1,"b": }').value, { a: 1 });
  });

  it('removes trailing commas in objects and arrays', () => {
    assert.deepEqual(parseJsonWithRepairs('{"a":[1,2,],"b":"x",}').value, { a: [1, 2], b: 'x' });
  });

  it('repairs several problems in one response and reports each', () => {
    const r = parseJsonWithRepairs('{"a":"1","x","b":"2","y",}');
    assert.deepEqual(r.value, { a: '1', b: '2' });
    assert.deepEqual(r.repairs.map((x) => x.key ?? x.kind), ['x', 'y', 'trailing-comma']);
  });

  it('handles escaped quotes inside the dropped key and surrounding values', () => {
    const r = parseJsonWithRepairs('{"a":"say \\"hi\\"","we\\"ird",\n"b":"ok"}');
    assert.deepEqual(r.value, { a: 'say "hi"', b: 'ok' });
  });

  it('never alters a surviving value', () => {
    const value = 'has, commas, "quotes", and a } brace';
    const json = JSON.stringify({ k: value });
    const r = parseJsonWithRepairs(`${json.slice(0, -1)},"dangling"}`);
    assert.deepEqual(r.value, { k: value });
  });

  it('keeps model-controlled key text short and printable in the report', () => {
    const r = parseJsonWithRepairs(`{"a":1,"${'k'.repeat(200)}é",\n"b":2}`);
    const key = r.repairs[0].key!;
    assert.ok(key.length <= 80);
    assert.match(key, /^[\x20-\x7e]+$/);
    assert.deepEqual(parseJsonWithRepairs('{"é",\n"b":2}').repairs, [{ kind: 'dangling-key', key: '?' }]);
  });

  it('rethrows the ORIGINAL SyntaxError for damage it will not guess at', () => {
    for (const bad of ['{"a":"1" "b":"2"}', '{"a":', 'not json', '{"a":1,,"b":2}', '{"a":"unterminated}']) {
      assert.throws(() => parseJsonWithRepairs(bad), SyntaxError, bad);
    }
    let original: unknown;
    try { JSON.parse('{"a":"1" "b":"2"}'); } catch (e) { original = e; }
    assert.throws(() => parseJsonWithRepairs('{"a":"1" "b":"2"}'), (e: Error) => e.message === (original as Error).message);
  });

  it('is bounded: a long run of dangling keys does not loop forever', () => {
    const many = '{' + Array.from({ length: 60 }, (_, i) => `"k${i}"`).join(',') + ',"z":1}';
    assert.throws(() => parseJsonWithRepairs(many), SyntaxError);
  });
});

describe('parseJsonFromText tolerance', () => {
  it('still parses raw, fenced and wrapped JSON', () => {
    assert.deepEqual(parseJsonFromText('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonFromText('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonFromText('Here:\n{"a":1}\nDone.'), { a: 1 });
  });

  it('repairs inside a fenced block and inside prose-wrapped JSON', () => {
    assert.deepEqual(parseJsonFromText('```json\n{"a":1,"b",\n"c":3}\n```'), { a: 1, c: 3 });
    assert.deepEqual(parseJsonFromText('Here:\n{"a":1,"b",\n"c":3}\nDone.'), { a: 1, c: 3 });
  });

  it('regression: a model output that wrote one field key with no value keeps its other fields', () => {
    // A model told it may omit fields wrote `"comparison",` with no value in the middle of
    // an otherwise valid, fenced response. Strict JSON.parse rejected the whole thing and the
    // item ended as "processing failed" with every good field discarded.
    const raw = readFileSync(new URL('./fixtures/model-output-dangling-key.txt', import.meta.url), 'utf8');
    assert.throws(() => JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '')), SyntaxError);
    const { value, repairs } = parseJsonFromTextWithRepairs(raw);
    assert.deepEqual(repairs, [{ kind: 'dangling-key', key: 'comparison' }]);
    const { itemId, source, fields } = value as { itemId: string; source: string; fields: Record<string, string> };
    assert.equal(source, 'https://example.com/');
    assert.match(itemId, /^[0-9a-f-]{36}$/);
    assert.equal(fields.category, 'reference');
    assert.equal(Object.keys(fields).length, 11);
    assert.ok(!('comparison' in fields), 'the field the model dropped stays absent, not invented');
    for (const v of Object.values(fields)) assert.equal(typeof v, 'string');
  });
});
