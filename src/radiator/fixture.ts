import assert from 'node:assert/strict';
import type { DbHandle } from '../db/index.js';
import { seed } from '../db/seed.js';
import { boards } from '../db/schema.js';
import type { BoardDescriptor } from '../descriptor/types.js';
import { RADIATOR_BOARD_ID } from './contract.js';

/** Synthetic local/demo input only. Refuses any nonempty database. */
export function seedRadiatorFixture(handle: DbHandle, ingestMode: BoardDescriptor['ingest_mode'] = 'url-readable'): void {
  assert(handle.db.select().from(boards).all().length === 0, 'Fixture requires a new empty database');
  seed(handle.db);
  const descriptor: BoardDescriptor = {
    view: 'grid', ingest_mode: ingestMode, enrichment_prompt: 'Legacy design lens, retained only as a recovery before-image.',
    empty_state: { head: 'Nothing saved yet.', body: 'Save a product to examine its relation to Radiator.' }, archive_on_promote: false,
    fields: [
      { key: 'url', label: 'URL', type: 'url', enrichable: false },
      { key: 'screenshot', label: 'Screenshot', type: 'image', enrichable: true },
      { key: 'aesthetic_tags', label: 'Aesthetic tags', type: 'tags', enrichable: true },
      { key: 'tone', label: 'Tone', type: 'tags', enrichable: true },
      { key: 'my_notes', label: 'My notes', type: 'text', enrichable: false },
      { key: 'tier', label: 'Tier', type: 'enum', values: ['reference', 'polish'], enrichable: true },
      { key: 'steal_this', label: 'Legacy design observation', type: 'text', enrichable: true },
    ],
  };
  handle.db.insert(boards).values({ id: RADIATOR_BOARD_ID, name: 'Radiator', view: 'grid', descriptor }).run();
}
