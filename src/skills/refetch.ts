import { z } from 'zod';

import { captureRegistry } from '../capture/adapter.js';
import { refetchItem } from '../enrichment/refetch.js';
import { config } from '../config.js';
import { defineSkill } from './types.js';

// Story 7.3 — refetch an existing item: re-run capture + enrichment to refresh
// analysis without losing user-authored fields (preservation is by construction in
// the pipeline). Fire-and-forget — returns immediately with `processing`; live
// progress streams over SSE. Also the "Retry analysis" path for a status=error item.
export const refetchSkill = defineSkill(
  'refetch',
  z.object({ itemId: z.string().min(1) }),
  z.object({ itemId: z.string(), status: z.string() }),
  async (input, ctx) => {
    // Don't await — capture (Chrome) + enrich (LLM) run on the worker. Guard the
    // fire-and-forget: refetchItem rejects (unknown/deleted item) BEFORE the worker's
    // error-swallowing layer, so an uncaught rejection here would crash the worker.
    void refetchItem(ctx.db, {
      itemId: input.itemId,
      registry: captureRegistry,
      llm: ctx.llm,
        radiator: ctx.radiator,
      screenshotsDir: config.screenshotsDir,
    }).catch((err) => ctx.logger.error(`refetch "${input.itemId}" failed to start: ${(err as Error).message}`));
    return { itemId: input.itemId, status: 'processing' };
  },
);
