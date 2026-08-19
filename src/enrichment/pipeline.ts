import { runItemJob, type JobResult, type TimeoutFn } from '../db/queue.js';
import { runCaptureForItem, type CaptureRegistry, type CaptureSource } from '../capture/adapter.js';
import { runEnrichmentForItem } from './worker.js';
import type { LLMProvider } from '../skills/types.js';
import type { DbHandle } from '../db/index.js';
import { config } from '../config.js';

// Story 7.1/7.3 — the shared capture→enrich pipeline as ONE worker job, so the item
// holds a single `processing` state until enriched (Story 5.3 contract). Used by
// add-item (hop 1+2 for a new item) and refetch (re-run for an existing item).
// Preservation is by construction: capture merges captured fields + lifts system
// columns; enrichment writes ONLY enrichable schema keys — so notes/favorite and
// enrichable:false fields survive.

// Budget for capture + the LLM read together lives in config (CAPTURE_TIMEOUT_MS) so a
// slow local model can be given room; the old fixed 60s failed ordinary CLI reads. Read
// per-call, not at module load, so importing this module never depends on boot order.

export interface CaptureEnrichArgs {
  itemId: string;
  boardId: string;
  /** URL/upload source for capture; omit to skip capture (enrich only). */
  source?: CaptureSource | null;
  llm: LLMProvider;
  registry: CaptureRegistry;
  ingestMode?: string;
  screenshotsDir?: string;
  timeoutMs?: number;
  timeoutFn?: TimeoutFn;
  /**
   * Story 13.1 — enrichment tier. 'earned' (default) runs the expensive descriptor
   * -driven AI takeaway (existing behavior — every current board keeps it). 'cheap'
   * runs capture ONLY and skips the enrich hop, so `llm.complete` is never reached
   * (the Inbox path; the takeaway is earned on assignment, Epic 14). Defaulting to
   * 'earned' keeps every existing board byte-for-byte unchanged (NFR-BC). Epic 14.1
   * generalizes this tier selection.
   */
  tier?: 'cheap' | 'earned';
}

/**
 * Enqueue a single worker job that runs capture (when a source + a registered adapter
 * exist and the board isn't manual-upload) then enrichment. Returns the job result.
 * Capture's browser teardown is awaited by the worker before the next capture (6.5).
 */
export function runCaptureEnrichJob(handle: DbHandle, args: CaptureEnrichArgs): Promise<JobResult> {
  let captureTeardown: (() => Promise<void>) | undefined;
  const canCapture =
    !!args.source &&
    args.ingestMode !== 'manual-upload' &&
    !!args.ingestMode &&
    args.registry.has(args.ingestMode);

  return runItemJob(handle, {
    itemId: args.itemId,
    type: 'capture',
    timeoutMs: args.timeoutMs ?? config.captureTimeoutMs,
    timeoutFn: args.timeoutFn,
    work: async (signal) => {
      if (canCapture) {
        await runCaptureForItem(handle, args.registry, {
          itemId: args.itemId,
          boardId: args.boardId,
          source: args.source as CaptureSource,
          signal,
          screenshotsDir: args.screenshotsDir,
          registerTeardown: (fn) => { captureTeardown = fn; },
        });
      }
      // Cheap tier (Inbox): skip the enrich hop entirely so llm.complete is never
      // reached — the AI takeaway is earned on assignment (Epic 14), not on capture.
      if (args.tier !== 'cheap') {
        await runEnrichmentForItem(handle, { itemId: args.itemId, llm: args.llm, signal });
      }
    },
    teardown: async () => { if (captureTeardown) await captureTeardown(); },
  });
}
