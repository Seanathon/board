import path from 'node:path';
import fs from 'node:fs';

import { z } from 'zod';

import { enqueueTransaction } from '../db/queue.js';
import { assets, items } from '../db/schema.js';
import { config } from '../config.js';
import { defineSkill } from './types.js';

// "Start from a fresh state" — the ONLY destructive path in the data feature, and the
// only skill that can lose work, so it is deliberately awkward to invoke:
//
//   - it takes a literal `confirm: 'delete'` token, so a stray or malformed POST to
//     /skills/wipe-items does nothing rather than emptying the collection,
//   - it clears ITEMS ONLY. Boards and their descriptors survive, because those encode
//     the shape the user built (fields, enrichment lens, view) and are far more costly
//     to recreate than re-capturing a URL,
//   - the UI downloads a backup before calling it.
//
// Rows and files both: leaving 100+MB of orphaned screenshots behind would make "fresh"
// a lie on a box chosen for having little disk.

export const wipeItemsSkill = defineSkill(
  'wipe-items',
  z.object({
    /** Literal 'delete'. Anything else is refused — see above. */
    confirm: z.string(),
    /** Defaults to the configured screenshots dir; injectable for tests. */
    screenshotsDir: z.string().optional(),
  }),
  z.object({
    itemsDeleted: z.number(),
    assetsDeleted: z.number(),
    filesDeleted: z.number(),
  }),
  async (input, ctx) => {
    if (input.confirm !== 'delete') {
      throw new Error('Refusing to wipe: `confirm` must be the exact string "delete".');
    }

    const shotDir = input.screenshotsDir ?? config.screenshotsDir;
    const assetRows = ctx.db.db.select().from(assets).all();
    const itemCount = ctx.db.db.select().from(items).all().length;

    // Rows first, through the single writer: if the DB write fails, the files are
    // still there and the collection is intact. Deleting files first could strand
    // rows pointing at nothing.
    await enqueueTransaction(ctx.db, () => {
      ctx.db.db.delete(assets).run();
      ctx.db.db.delete(items).run();
      ctx.db.sqlite.prepare('DELETE FROM item_fts').run();
    });

    let filesDeleted = 0;
    for (const a of assetRows) {
      if (!a.path) continue;
      // Resolve by BASENAME under the screenshots dir — never trust a stored path to
      // stay inside it (a crafted "../../etc" path must not reach unlink).
      const abs = path.join(shotDir, path.basename(a.path));
      try {
        if (fs.existsSync(abs)) { fs.rmSync(abs); filesDeleted += 1; }
      } catch (err) {
        ctx.logger.warn(`wipe-items: could not remove ${abs}: ${(err as Error).message}`);
      }
    }

    return { itemsDeleted: itemCount, assetsDeleted: assetRows.length, filesDeleted };
  },
);
