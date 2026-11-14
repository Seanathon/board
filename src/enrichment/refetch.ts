import { isRadiatorBoardActive } from '../radiator/profile.js';
import type { RadiatorRuntimeOptions } from '../radiator/runtime.js';
import { eq } from 'drizzle-orm';

import { assets, boards, items } from '../db/schema.js';
import { runCaptureEnrichJob } from './pipeline.js';
import type { CaptureRegistry } from '../capture/adapter.js';
import type { BoardDescriptor } from '../descriptor/types.js';
import type { LLMProvider } from '../skills/types.js';
import type { JobResult, TimeoutFn } from '../db/queue.js';
import type { DbHandle } from '../db/index.js';

// Story 7.3 — refetch: re-run capture + enrichment for an EXISTING item to refresh
// analysis, WITHOUT losing user-authored fields. Preservation is by construction —
// the capture+enrich pipeline merges captured fields and writes only enrichable
// schema keys, so notes/favorite (columns) and enrichable:false fields survive; the
// item id is unchanged and the asset is replaced (idempotent capture, Story 6.1).
// This is also the "Retry analysis" path for a status=error item (Story 8.5).
export async function refetchItem(
  handle: DbHandle,
  args: { itemId: string; registry: CaptureRegistry; llm: LLMProvider; screenshotsDir?: string; timeoutFn?: TimeoutFn; radiator?: RadiatorRuntimeOptions },
): Promise<JobResult> {
  const item = handle.db.select().from(items).where(eq(items.id, args.itemId)).get();
  if (!item) throw new Error(`Cannot refetch: unknown item "${args.itemId}"`);
  const board = handle.db.select().from(boards).where(eq(boards.id, item.boardId)).get();
  const ingestMode = (board?.descriptor as BoardDescriptor | undefined)?.ingest_mode;

  return runCaptureEnrichJob(handle, {
    itemId: item.id,
    boardId: item.boardId,
    source: isRadiatorBoardActive(handle, item.boardId) && (handle.db.select().from(assets).where(eq(assets.itemId, item.id)).get() || (item.fields as Record<string, unknown> | null)?.text) ? undefined : item.source ?? undefined,
    ingestMode,
    llm: args.llm,
      radiator: args.radiator,
    registry: args.registry,
    screenshotsDir: args.screenshotsDir,
    timeoutFn: args.timeoutFn,
  });
}

/**
 * Batch RE-ENRICH every item on a board (the "Re-run AI on all items" action after
 * editing a board's fields). Enrich-ONLY — no re-capture (source omitted → the
 * pipeline skips capture and re-runs enrichment over the already-captured content),
 * so it's light and won't churn screenshots. Each item becomes its own queued job
 * (status processing→done/error + SSE); user/non-enrichable fields survive by
 * construction. Fire-and-forget for callers; `settled` is exposed for tests.
 */
export function reenrichBoardItems(
  handle: DbHandle,
  args: { boardId: string; llm: LLMProvider; registry: CaptureRegistry; timeoutFn?: TimeoutFn; radiator?: RadiatorRuntimeOptions },
): { queued: number; settled: Promise<unknown> } {
  const rows = handle.db.select().from(items).where(eq(items.boardId, args.boardId)).all();
  const jobs = rows.map((it) =>
    runCaptureEnrichJob(handle, {
      itemId: it.id,
      boardId: it.boardId,
      source: undefined, // enrich-only (no re-capture)
      llm: args.llm,
      radiator: args.radiator,
      registry: args.registry,
      timeoutFn: args.timeoutFn,
    }).catch((e) => e), // per-item failure is recorded as status=error by the job
  );
  return { queued: rows.length, settled: Promise.allSettled(jobs) };
}
