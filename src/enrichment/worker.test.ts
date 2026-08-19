import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { eq } from 'drizzle-orm';

import { initDb } from '../db/index.js';
import { boards, items } from '../db/schema.js';
import { runItemJob, type TimeoutFn } from '../db/queue.js';
import { patchItemFields } from '../db/item-actions.js';
import { disabledLlm, type LLMProvider } from '../skills/types.js';
import { INSPIRATION_DESCRIPTOR } from '../db/seed.js';
import { buildEnrichmentSchema, buildEnrichmentPrompt, runEnrichmentForItem } from './worker.js';
import type { BoardDescriptor } from '../descriptor/types.js';

const neverFires: TimeoutFn = () => () => {};

// A descriptor with a NOVEL enrichable key (in no prototype constant) + a
// non-enrichable user field, to prove schema-FROM-descriptor + enrichable-only write.
const NOVEL_DESCRIPTOR: BoardDescriptor = {
  view: 'grid',
  ingest_mode: 'url-screenshot',
  enrichment_prompt: 'Score the thing.',
  fields: [
    { key: 'foo_score', label: 'Foo', type: 'number', enrichable: true },
    { key: 'shot', label: 'Shot', type: 'image', enrichable: true }, // image — excluded from schema
    { key: 'note_field', label: 'Note', type: 'text', enrichable: false }, // user field
  ],
};

describe('buildEnrichmentSchema (Story 7.1)', () => {
  // AC 3 — schema reflects the descriptor's enrichable fields (excluding image)
  it('builds a zod schema from enrichable fields, excluding image', () => {
    const schema = buildEnrichmentSchema(NOVEL_DESCRIPTOR);
    const shape = schema.shape;
    assert.ok('foo_score' in shape, 'enrichable field present');
    assert.ok(!('shot' in shape), 'image field excluded (not LLM-emittable)');
    assert.ok(!('note_field' in shape), 'non-enrichable field excluded');
  });

  it('reflects the Inspiration descriptor enrichable keys', () => {
    const shape = buildEnrichmentSchema(INSPIRATION_DESCRIPTOR).shape;
    assert.ok('design.design_system_score' in shape);
    assert.ok('meta.audience' in shape);
    assert.ok(!('favorite_reason' in shape), 'enrichable:false field excluded');
  });
});

describe('buildEnrichmentPrompt — per-field guidance', () => {
  it('lists enrichable fields with their label + description as fill guidance', () => {
    const descriptor: BoardDescriptor = {
      view: 'grid', ingest_mode: 'url-screenshot', enrichment_prompt: 'Analyze it.',
      fields: [
        { key: 'weight', label: 'Complexity', type: 'number', enrichable: true, description: 'BGG weight 1-5' },
        { key: 'mynote', label: 'My note', type: 'text', enrichable: false, description: 'private' },
      ],
    };
    const prompt = buildEnrichmentPrompt(descriptor, { title: 'T', source: 'https://x', fields: {} });
    assert.match(prompt, /Complexity/);
    assert.match(prompt, /BGG weight 1-5/);
    // a non-enrichable field's description must NOT be solicited (AI never fills it)
    assert.doesNotMatch(prompt, /private/);
  });

  it('asks the model to return a cleaned-up title', () => {
    const descriptor: BoardDescriptor = {
      view: 'grid', ingest_mode: 'url-screenshot', enrichment_prompt: 'Analyze it.',
      fields: [{ key: 'summary', label: 'Summary', type: 'text', enrichable: true }],
    };
    const prompt = buildEnrichmentPrompt(descriptor, { title: 'Raw | SEO junk', source: 'https://x', fields: {} });
    assert.match(prompt, /Also return "title"/);
  });
});

describe('runEnrichmentForItem (Story 7.1)', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-enrich-'));
    handle = initDb(join(dir, 'e.db'));
    handle.db.insert(boards).values({ id: 'nb', name: 'Novel', view: 'grid', descriptor: NOVEL_DESCRIPTOR }).run();
  });
  after(() => { handle.sqlite.close(); rmSync(dir, { recursive: true, force: true }); });

  // AC 1/5a — schema passed to complete is built FROM the descriptor (not hardcoded)
  it('passes a descriptor-derived schema to complete and writes enrichable-only', async () => {
    handle.db.insert(items).values({ id: 'e1', boardId: 'nb', source: 'x', notes: 'USER NOTE', fields: {} }).run();
    let capturedSchema: z.ZodType | undefined;
    const mock: LLMProvider = {
      complete: async (_prompt, schema) => {
        capturedSchema = schema as z.ZodType;
        // returns EXTRA keys incl. a user field — must be filtered out
        return { foo_score: 5, note_field: 'INJECTED', notes: 'INJECTED' } as never;
      },
    };

    await runEnrichmentForItem(handle, { itemId: 'e1', llm: mock });

    // AC 5a — the schema reflects the descriptor's enrichable field, not prototype keys
    const shape = (capturedSchema as z.ZodObject<never>).shape as Record<string, unknown>;
    assert.ok('foo_score' in shape, 'schema derived from descriptor');
    assert.ok(!('meta.audience' in shape), 'not a hardcoded INSPIRATION schema');

    const row = handle.db.select().from(items).where(eq(items.id, 'e1')).get();
    const f = row?.fields as Record<string, unknown>;
    assert.equal(f.foo_score, 5, 'enrichable field written');
    assert.equal(f.note_field, undefined, 'non-enrichable field NOT written from enrichment');
    assert.equal(f.notes, undefined, 'system/user field not smuggled into fields');
    assert.equal(row?.notes, 'USER NOTE', 'user notes column untouched');
  });

  // Enrichment reads the item, awaits the LLM (tens of seconds), then writes the row
  // back. Jobs and writes now run on separate lanes, so an interactive edit can land
  // INSIDE that window — and a write assembled from the pre-LLM snapshot would silently
  // revert it. The row is re-read inside the write op so the merge is against fresh
  // state. (Under the old single lane this was impossible: the job held the write lane.)
  it('does not clobber a user edit that lands while the LLM is running', async () => {
    handle.db.insert(items).values({ id: 'e-race', boardId: 'nb', source: 'x', notes: 'before', fields: {} }).run();
    const mock: LLMProvider = {
      complete: async () => {
        // the user edits notes + a user-owned field mid-flight, through the write lane
        await patchItemFields(handle, 'e-race', { notes: 'EDITED MID-FLIGHT', note_field: 'USER VALUE' });
        return { foo_score: 7 } as never;
      },
    };

    await runEnrichmentForItem(handle, { itemId: 'e-race', llm: mock });

    const row = handle.db.select().from(items).where(eq(items.id, 'e-race')).get();
    const f = row?.fields as Record<string, unknown>;
    assert.equal(row?.notes, 'EDITED MID-FLIGHT', 'a user edit during the LLM call must survive');
    assert.equal(f.note_field, 'USER VALUE', 'a user field written mid-flight must survive');
    assert.equal(f.foo_score, 7, 'and the enrichment result still lands');
  });

  // Title refinement: the LLM may return a `title`, written to the title COLUMN
  // (not fields) so a cluttered/wrong captured title gets cleaned up on add/refetch.
  it('writes an LLM-refined title to the item title column', async () => {
    handle.db.insert(items).values({ id: 'e5', boardId: 'nb', source: 'x', title: 'Raw | junk - SEO', fields: {} }).run();
    const mock: LLMProvider = { complete: async () => ({ foo_score: 1, title: 'Clean Title' }) as never };
    await runEnrichmentForItem(handle, { itemId: 'e5', llm: mock });
    const row = handle.db.select().from(items).where(eq(items.id, 'e5')).get();
    assert.equal(row?.title, 'Clean Title', 'LLM title refines the column');
    const f = row?.fields as Record<string, unknown>;
    assert.equal(f.title, undefined, 'title is a column, never smuggled into fields');
    assert.equal(f.foo_score, 1, 'enrichable field still written');
  });

  it('leaves the title unchanged when the LLM omits it', async () => {
    handle.db.insert(items).values({ id: 'e6', boardId: 'nb', source: 'x', title: 'Keep Me', fields: {} }).run();
    const mock: LLMProvider = { complete: async () => ({ foo_score: 2 }) as never };
    await runEnrichmentForItem(handle, { itemId: 'e6', llm: mock });
    const row = handle.db.select().from(items).where(eq(items.id, 'e6')).get();
    assert.equal(row?.title, 'Keep Me', 'an omitted title must not blank the column');
  });

  // AC 2 — enrichment refreshes search_blob/FTS
  it('refreshes search_blob so enriched fields are searchable', async () => {
    handle.db.insert(items).values({ id: 'e2', boardId: 'nb', source: 'x', fields: {} }).run();
    const mock: LLMProvider = { complete: async () => ({ foo_score: 42 }) as never };
    await runEnrichmentForItem(handle, { itemId: 'e2', llm: mock });
    const blob = handle.sqlite.prepare('SELECT search_blob FROM item WHERE id=?').get('e2') as { search_blob: string };
    // foo_score is a number → not in the blob, but the write path ran; verify a text enrichment IS searchable
    handle.db.insert(boards).values({ id: 'tb2', name: 'T', view: 'grid', descriptor: { ...NOVEL_DESCRIPTOR, fields: [{ key: 'body', label: 'B', type: 'text', enrichable: true }] } }).run();
    handle.db.insert(items).values({ id: 'e3', boardId: 'tb2', source: 'x', fields: {} }).run();
    const mock2: LLMProvider = { complete: async () => ({ body: 'zqxwvterm here' }) as never };
    await runEnrichmentForItem(handle, { itemId: 'e3', llm: mock2 });
    const hit = handle.sqlite.prepare("SELECT item_id FROM item_fts WHERE item_fts MATCH 'zqxwvterm'").all() as Array<{ item_id: string }>;
    assert.deepEqual(hit.map((r) => r.item_id), ['e3']);
    assert.ok(typeof blob.search_blob !== 'undefined');
  });

  // AC 4 — disabled provider propagates EnrichmentDisabledError → 5.2 classifies done
  it('disabled provider → item done (not error) via the worker classifier', async () => {
    handle.db.insert(items).values({ id: 'e4', boardId: 'nb', source: 'x', fields: {} }).run();
    await runItemJob(handle, {
      itemId: 'e4',
      type: 'enrich',
      timeoutMs: 60_000,
      timeoutFn: neverFires,
      work: (signal) => runEnrichmentForItem(handle, { itemId: 'e4', llm: disabledLlm, signal }),
    });
    const row = handle.db.select().from(items).where(eq(items.id, 'e4')).get();
    assert.equal(row?.status, 'done', 'no-AI enrichment must resolve done, not error');
    assert.equal(row?.errorReason, null);
  });
});
