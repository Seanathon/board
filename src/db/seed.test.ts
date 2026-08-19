import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import { initDb } from './index.js';
import { boards } from './schema.js';
import {
  seed,
  INSPIRATION_BOARD_ID,
  LIBRARY_BOARD_ID,
  INSPIRATION_DESCRIPTOR,
  LIBRARY_DESCRIPTOR,
} from './seed.js';
import { validateDescriptor, enrichableTargets, type Field } from '../descriptor/types.js';

function field(d: { fields: Field[] }, key: string): Field {
  const f = d.fields.find((x) => x.key === key);
  assert.ok(f, `descriptor missing field ${key}`);
  return f;
}

describe('board seed (Story 1.2)', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-seed-'));
    handle = initDb(join(dir, 'seed.db'));
  });
  after(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // AC 3 — two boards seeded as descriptors
  it('seeds Inspiration (grid/url-screenshot) and Library (list/url-readable)', () => {
    seed(handle.db);
    const insp = handle.db.select().from(boards).where(eq(boards.id, INSPIRATION_BOARD_ID)).get();
    const lib = handle.db.select().from(boards).where(eq(boards.id, LIBRARY_BOARD_ID)).get();

    assert.equal(insp?.name, 'Inspiration');
    assert.equal(insp?.view, 'grid');
    assert.equal((insp?.descriptor as { ingest_mode: string }).ingest_mode, 'url-screenshot');

    assert.equal(lib?.name, 'Library');
    assert.equal(lib?.view, 'list');
    assert.equal((lib?.descriptor as { ingest_mode: string }).ingest_mode, 'url-readable');
  });

  // AC 4 — idempotent (3 seed boards since Story 13.1 added the Inbox)
  it('is idempotent — re-running does not duplicate boards', () => {
    seed(handle.db);
    seed(handle.db);
    const all = handle.db.select().from(boards).all();
    assert.equal(all.length, 3); // Inspiration + Library + Inbox (13.1)
  });

  // AC 3 — stored descriptors are valid
  it('seeds only valid descriptors', () => {
    const all = handle.db.select().from(boards).all();
    for (const b of all) {
      assert.doesNotThrow(() => validateDescriptor(b.descriptor));
    }
  });
});

// AC 5 — concrete, named assertions on the two descriptors (not a field count)
describe('seeded descriptor field contracts (Story 1.2)', () => {
  it('Inspiration descriptor matches the prototype field set with correct types', () => {
    const d = validateDescriptor(INSPIRATION_DESCRIPTOR);
    assert.equal(d.view, 'grid');
    assert.equal(d.ingest_mode, 'url-screenshot');

    // meta.audience is enum carrying the taxonomy audience vocabulary
    const audience = field(d, 'meta.audience');
    assert.equal(audience.type, 'enum');
    assert.deepEqual(audience.values, ['b2b', 'enterprise', 'consumer', 'developer', 'prosumer']);

    // meta.form / meta.domain are OPEN text (not enum) — enrichment must emit novel values
    assert.equal(field(d, 'meta.form').type, 'text');
    assert.equal(field(d, 'meta.domain').type, 'text');

    // meta.tier is enum; tone & tags are tags
    assert.equal(field(d, 'meta.tier').type, 'enum');
    assert.deepEqual(field(d, 'meta.tier').values, ['reference', 'polish', 'structural']);
    assert.equal(field(d, 'meta.tone').type, 'tags');
    assert.equal(field(d, 'meta.tags').type, 'tags');

    // design.design_system_score is enum; the rest of design is text
    const dss = field(d, 'design.design_system_score');
    assert.equal(dss.type, 'enum');
    assert.deepEqual(dss.values, ['systematic', 'semi-systematic', 'bespoke']);
    assert.equal(field(d, 'design.steal_this').type, 'text');
    assert.equal(field(d, 'design.color_story').type, 'text');

    // reflection fields are text
    assert.equal(field(d, 'reflection.five_second_message').type, 'text');
    assert.equal(field(d, 'reflection.apply_to_your_work').type, 'text');

    // A fresh install must not be seeded with traces of the author's own project.
    // The board ships to strangers; a field called "Apply to <someone's product>"
    // is dead weight to every one of them.
    const serialized = JSON.stringify(INSPIRATION_DESCRIPTOR).toLowerCase();
    assert.ok(!serialized.includes('naruki'), 'seeded descriptor must not name a personal project');

    // favorite_reason is a non-system user field → enrichable:false
    assert.equal(field(d, 'favorite_reason').enrichable, false);

    // favorite / notes / title are SYSTEM COLUMNS — never descriptor fields
    for (const sys of ['favorite', 'notes', 'title']) {
      assert.equal(d.fields.find((f) => f.key === sys), undefined, `${sys} must not be a descriptor field`);
    }

    // enrichment never targets the user/system fields
    const targets = enrichableTargets(d);
    assert.ok(targets.includes('meta.audience'));
    assert.ok(targets.includes('design.design_system_score'));
    assert.ok(!targets.includes('favorite_reason'));
    assert.ok(!targets.includes('favorite'));
    assert.ok(!targets.includes('notes'));
  });

  it('Library descriptor matches the prototype field set with correct types', () => {
    const d = validateDescriptor(LIBRARY_DESCRIPTOR);
    assert.equal(d.view, 'list');
    assert.equal(d.ingest_mode, 'url-readable');

    assert.equal(field(d, 'summary').type, 'text');
    assert.equal(field(d, 'author').type, 'text');
    assert.equal(field(d, 'topics').type, 'tags');

    const type = field(d, 'type');
    assert.equal(type.type, 'enum');
    assert.deepEqual(type.values, ['article', 'doc', 'paper', 'repo', 'video']);

    // key_points are PROSE takeaways → text (not tags)
    assert.equal(field(d, 'key_points').type, 'text');

    // notes / title are SYSTEM COLUMNS — never descriptor fields; enrichment skips them
    for (const sys of ['notes', 'title']) {
      assert.equal(d.fields.find((f) => f.key === sys), undefined, `${sys} must not be a descriptor field`);
    }
    const targets = enrichableTargets(d);
    assert.ok(!targets.includes('notes'));
    assert.ok(targets.includes('summary'));
  });
});
