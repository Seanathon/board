import { eq } from 'drizzle-orm';

import { boards, items } from '../db/schema.js';
import { enqueueWrite, writeItemDirect, type TimeoutFn } from '../db/queue.js';
import { runCaptureEnrichJob } from './pipeline.js';
import { runSnapshotJob } from '../capture/url-snapshot.js';
import { archivesOnPromote, type BoardDescriptor } from '../descriptor/types.js';
import type { CaptureRegistry } from '../capture/adapter.js';
import type { LLMProvider } from '../skills/types.js';
import type { DbHandle } from '../db/index.js';

// Story 14.2 — the ONE assign verb. `assignItems` is the single code path that both
// the REST route (POST /api/v1/items/assign) and the composer (15.2) call — there is
// no second assign implementation. For each item it does a single-FK MOVE of
// `item.board_id` (never m2m / no join table, D12) THEN fires the earned-tier
// enrich-only job (14.1) against the TARGET board's descriptor.
//
// Load-bearing ordering: move FIRST, then enrich — `runEnrichmentForItem` derives the
// descriptor from `item.board_id` (enrichment/worker.ts), so the FK must already point
// at the target before enrichment reads it. Field preservation is by construction (the
// move keeps `fields`/assets untouched; the enrich merge `{...existing, ...enriched}`
// never deletes keys). Assigning back to the typeless Inbox early-returns in the worker
// (zero enrichable keys), so it's a safe no-op — no special revert path.

export interface AssignArgs {
  itemIds: string[];
  boardId: string;
  llm: LLMProvider;
  registry: CaptureRegistry;
  timeoutFn?: TimeoutFn;
  /**
   * Story 16.2 — injectable archival enqueue (tests pass a spy so no Chrome runs).
   * Called once per moved item ONLY when the target board archives-on-promote. Default:
   * fire-and-forget the 16.1 snapshot job on the single worker (status-neutral, graceful).
   */
  enqueueSnapshot?: (args: { itemId: string; url: string | null }) => void;
}

export interface AssignResult {
  /** ids moved to the target (board_id changed) — an earned-enrich job was fired for each. */
  assigned: string[];
  /** ids already on the target — skipped (no move, no LLM churn). */
  skipped: string[];
  /** ids that don't exist. */
  notFound: string[];
  /** ids whose FK move threw — recorded, never aborting the rest of the batch. */
  failed: string[];
  /** resolves when all fired earned-enrich jobs settle (callers may ignore for optimistic UX). */
  settled: Promise<unknown>;
}

export async function assignItems(handle: DbHandle, args: AssignArgs): Promise<AssignResult> {
  // Validate the target board ONCE, before any move (so an unknown board moves nothing).
  const target = handle.db.select().from(boards).where(eq(boards.id, args.boardId)).get();
  if (!target) throw new Error(`Cannot assign: unknown board "${args.boardId}"`);

  const assigned: string[] = [];
  const skipped: string[] = [];
  const notFound: string[] = [];
  const failed: string[] = [];
  const sources = new Map<string, string | null>(); // moved id → its source URL (for archival)

  // PHASE 1 — all moves first. Fast serial single-FK writes that do NOT interleave
  // with the (slow) earned-enrich jobs, so a batch isn't paced by N LLM round-trips
  // mid-loop. Each move is guarded so one failure (DB constraint, etc.) records the id
  // and continues the batch rather than aborting it. Ids are de-duped so the same id
  // can't land in two result buckets. Same-board ids are skipped (no churn, AC5).
  for (const id of [...new Set(args.itemIds)]) {
    try {
      await enqueueWrite(() => {
        const item = handle.db.select().from(items).where(eq(items.id, id)).get();
        if (!item) { notFound.push(id); return; }
        if (item.boardId === args.boardId) { skipped.push(id); return; }
        writeItemDirect(handle, { ...item, boardId: args.boardId, updatedAt: Math.floor(Date.now() / 1000) });
        assigned.push(id);
        sources.set(id, item.source ?? null);
      });
    } catch { failed.push(id); }
  }

  // PHASE 2 — fire the earned-tier enrich-only job for every moved item (source omitted
  // → no re-capture; the cheap capture already ran in the Inbox). Every item's board_id
  // already points at the target, so enrichment reads the TARGET descriptor (AC3). Each
  // job's per-item failure becomes status=error via runItemJob and never aborts the
  // batch (allSettled + .catch). Not awaited here — callers wait on `settled` if they
  // want the enriched result (the manual route does; the bulk composer fire-and-forgets).
  const jobs = assigned.map((id) =>
    runCaptureEnrichJob(handle, {
      itemId: id,
      boardId: args.boardId,
      source: undefined,
      tier: 'earned',
      llm: args.llm,
      registry: args.registry,
      timeoutFn: args.timeoutFn,
    }).catch((e) => e),
  );

  // Story 16.2 — opt-in archival: if the TARGET board archives-on-promote, enqueue a
  // snapshot (16.1) for each MOVED item (never for skipped same-board items). The
  // snapshot job is fire-and-forget on the same concurrency-1 worker (it serializes
  // behind the earned-enrich jobs queued above) and degrades gracefully (16.1 AC4) — we
  // never block the assign response on it. Default-off: unflagged boards enqueue nothing.
  if (archivesOnPromote(target.descriptor as BoardDescriptor | undefined)) {
    const enqueueSnapshot =
      args.enqueueSnapshot ??
      ((a: { itemId: string; url: string | null }) => {
        if (a.url) void runSnapshotJob(handle, { itemId: a.itemId, url: a.url });
      });
    for (const id of assigned) enqueueSnapshot({ itemId: id, url: sources.get(id) ?? null });
  }

  return { assigned, skipped, notFound, failed, settled: Promise.allSettled(jobs) };
}
