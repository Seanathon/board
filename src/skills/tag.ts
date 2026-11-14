import { markManualFields } from '../db/item-lease.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { boards, items } from '../db/schema.js';
import { enqueueWrite, writeItemDirect } from '../db/queue.js';
import type { BoardDescriptor } from '../descriptor/types.js';
import { defineSkill } from './types.js';

// Story 3.4 — tag: set an item's tags and refresh the search index. Writes through
// the typed item-write helper (Story 1.4) so `search_blob`/FTS refresh — a tag
// skill that updated the field but not the index would be a silent search bug.
//
// The tags value is stored under the board descriptor's first `type:'tags'` field
// (e.g. inspiration's `meta.tags`, library's `topics`), so it's picked up by the
// descriptor-driven search-blob builder. Falls back to a generic `tags` key when
// the board declares no tags field.
export const tagSkill = defineSkill(
  'tag',
  z.object({ itemId: z.string().min(1), tags: z.array(z.string()) }),
  z.object({ itemId: z.string(), tags: z.array(z.string()) }),
  async (input, ctx) => enqueueWrite(() => {
    const item = ctx.db.db.select().from(items).where(eq(items.id, input.itemId)).get();
    if (!item) {
      throw new Error(`Cannot tag: unknown item "${input.itemId}"`);
    }
    const board = ctx.db.db.select().from(boards).where(eq(boards.id, item.boardId)).get();
    const descriptor = board?.descriptor as BoardDescriptor | undefined;
    const tagsKey = descriptor?.fields.find((f) => f.type === 'tags')?.key ?? 'tags';

    const fields = { ...((item.fields as Record<string, unknown>) ?? {}), [tagsKey]: input.tags };
    // Pass the FULL item (merged fields) so writeItem recomputes search_blob from
    // the complete row — never dropping title/notes — and re-syncs FTS atomically.
    writeItemDirect(ctx.db, { ...item, fields });
    markManualFields(ctx.db, item.id, [tagsKey]);

    return { itemId: item.id, tags: input.tags };
  }),
);
