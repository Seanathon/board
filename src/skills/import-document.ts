import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { importRecords } from '../db/importer.js';
import { boards } from '../db/schema.js';
import { defineSkill } from './types.js';

// The other half of `export`. exportJson emits a whole document — boards, per-board
// item records, asset rows — and until now nothing could read one back: import-bookmarks
// targets ONE existing board, and no code path recreated a board from a document. So an
// export was a dead end for every composed board.
//
// Non-destructive by construction, at both levels:
//   - a board that already exists is left completely alone (name, view and descriptor
//     are never rewritten from the document — importing someone else's file must not
//     silently reshape the boards you already have),
//   - items dedupe on the preserved id inside importRecords, which SKIPS rather than
//     overwrites, so your own edits survive re-importing your own backup.
// Wiping is a separate, explicit action; it is never a side effect of importing.
//
// Asset BYTES are not handled here — the document carries paths, and the archive route
// restores the files. This skill is pure metadata over the single writer.

const exportBoardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  view: z.string().min(1),
  descriptor: z.unknown(),
});

export const importDocumentSkill = defineSkill(
  'import-document',
  z.object({
    document: z.object({
      version: z.literal(1),
      boards: z.array(exportBoardSchema).default([]),
      // Freeform, descriptor-shaped records — z.record(z.unknown()), never z.any() (FR-19).
      items: z.record(z.array(z.record(z.unknown()))).default({}),
      // Asset ROWS are recreated from each record's `screenshot` path inside
      // importRecords; the archive route restores the bytes. Accepted but unread here,
      // so the shape stays permissive rather than duplicating export's interface.
      assets: z.array(z.unknown()).default([]),
    }),
  }),
  z.object({
    boardsCreated: z.number(),
    boardsSkipped: z.number(),
    itemsCreated: z.number(),
    itemsSkipped: z.number(),
  }),
  async (input, ctx) => {
    const doc = input.document;
    let boardsCreated = 0;
    let boardsSkipped = 0;

    for (const b of doc.boards) {
      const existing = ctx.db.db.select().from(boards).where(eq(boards.id, b.id)).get();
      if (existing) { boardsSkipped += 1; continue; }
      ctx.db.db.insert(boards).values({
        id: b.id,
        name: b.name,
        view: b.view,
        descriptor: b.descriptor as never,
      }).run();
      boardsCreated += 1;
    }

    let itemsCreated = 0;
    let itemsSkipped = 0;
    for (const [boardId, records] of Object.entries(doc.items)) {
      // Items for a board that neither exists nor is described in the document have
      // nowhere to live; skip them rather than inventing a board with no descriptor.
      const board = ctx.db.db.select().from(boards).where(eq(boards.id, boardId)).get();
      if (!board) { itemsSkipped += records.length; continue; }
      const res = await importRecords({ handle: ctx.db, boardId, records });
      itemsCreated += res.created;
      itemsSkipped += res.skipped;
    }

    return { boardsCreated, boardsSkipped, itemsCreated, itemsSkipped };
  },
);
