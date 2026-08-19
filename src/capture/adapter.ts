import { eq } from 'drizzle-orm';

import { boards, items, type NewAsset } from '../db/schema.js';
import { writeItemDirect } from '../db/queue.js';
import { statusHub } from '../sse.js';
import { createUrlScreenshotAdapter } from './url-screenshot.js';
import { createUrlReadableAdapter } from './url-readable.js';
import { assertCapturableUrl } from './net-guard.js';
import { SYSTEM_COLUMNS, type BoardDescriptor } from '../descriptor/types.js';
import type { DbHandle } from '../db/index.js';

// Story 6.1 — the CaptureAdapter seam. Capture is generalized into adapters keyed by
// a board's `ingest_mode` (descriptor, Story 1.2), decoupled from analysis (which is
// the LLMProvider/enrichment seam). An item is `{ fields, assets }` — NOT "a URL +
// a screenshot" — so non-URL sources (manual upload) and future adapters fit without
// reworking the item model (FR-6). Concrete adapters: url-screenshot (6.2),
// url-readable (6.3), manual-upload (6.4). Concurrency 1 + timeout/teardown: 6.5.
//
// ── DESIGNED-NOT-EXTRACTED sidecar contract (AD4/C2, v1 NOT wired) ──────────────
// In v1 capture runs IN-PROCESS as a worker job (a plain function call — there is no
// network surface to authenticate, so "implementing token-auth" on it would be
// theater). The would-be offloadable capture *service* contract is designed now so
// v2 can lift it out without a rewrite:
//   POST {SIDECAR_URL}/capture
//   Headers: Authorization: Bearer <CAPTURE_TOKEN>   (token-authed even on localhost)
//   Body:    { ingestMode, source, itemId, boardId, idempotencyKey: itemId }
//   200:     { fields: Record<string,unknown>, assets: AssetSpec[] }  (idempotent on retry by itemId)
//   4xx/5xx: { error } → mapped to the job's typed failure
// In-process attach point: `runCaptureForItem` below is the single call site a future
// HTTP client would replace. Idempotency-on-retry is REAL in v1 (keyed to item id via
// writeItem's asset replacement); the token/endpoint are design-only.

/** A captured asset. URL adapters write a file and return `path`; upload adapters
 *  may carry a `buffer` the caller persists (6.4). */
export interface AssetSpec {
  kind: string;
  path?: string;
  buffer?: Buffer;
  width?: number;
  height?: number;
  hash?: string;
}

/** A capture source: a URL string, or an upload payload (non-URL). */
export type CaptureSource = string | { buffer: Buffer; filename?: string; mimeType?: string };

export interface CaptureResult {
  fields: Record<string, unknown>;
  assets: AssetSpec[];
}

export interface CaptureCtx {
  itemId: string;
  boardId: string;
  /** Honored for cooperative cancellation on timeout (Story 5.1/6.5). */
  signal?: AbortSignal;
  /** Where url adapters write screenshot/asset files (Story 2.2). */
  screenshotsDir?: string;
  /**
   * Story 6.5: an adapter that launches a browser registers its memoized teardown
   * here so the capture JOB can await it before the worker launches the next capture
   * (the 5.1↔6.5 gate — two Chromiums never coexist).
   */
  registerTeardown?: (teardown: () => Promise<void>) => void;
}

export interface CaptureAdapter {
  ingestMode: string;
  fetch(source: CaptureSource, ctx: CaptureCtx): Promise<CaptureResult>;
}

export interface CaptureRegistry {
  register(adapter: CaptureAdapter): void;
  get(ingestMode: string): CaptureAdapter | undefined;
  has(ingestMode: string): boolean;
}

export function createCaptureRegistry(): CaptureRegistry {
  const adapters = new Map<string, CaptureAdapter>();
  return {
    register(adapter) {
      if (adapters.has(adapter.ingestMode)) {
        throw new Error(`Capture adapter for ingest_mode "${adapter.ingestMode}" is already registered`);
      }
      adapters.set(adapter.ingestMode, adapter);
    },
    get: (mode) => adapters.get(mode),
    has: (mode) => adapters.has(mode),
  };
}

/** Process-wide registry; 6.2–6.4 register into it at boot via registerAllCaptureAdapters. */
export const captureRegistry = createCaptureRegistry();

/** Populate a registry with the v1 capture adapters (6.2–6.4 add here). */
export function registerAllCaptureAdapters(registry: CaptureRegistry): void {
  registry.register(createUrlScreenshotAdapter()); // Story 6.2 (url-screenshot)
  registry.register(createUrlReadableAdapter()); // Story 6.3 (url-readable)
  // manual-upload (6.4) registers here.
}

/** Resolve the adapter for an ingest_mode and run it. Unknown mode → clear error. */
export async function dispatchCapture(
  registry: CaptureRegistry,
  ingestMode: string,
  source: CaptureSource,
  ctx: CaptureCtx,
): Promise<CaptureResult> {
  const adapter = registry.get(ingestMode);
  if (!adapter) {
    throw new Error(`No capture adapter registered for ingest_mode "${ingestMode}"`);
  }
  // SSRF guard: every URL adapter (url-screenshot, url-readable) fetches a user-supplied
  // URL here — block private/loopback/link-local targets BEFORE the fetch. Buffer sources
  // (manual-upload) carry no URL and fall through. Reached by create/share/assign/refetch.
  if (typeof source === 'string') await assertCapturableUrl(source);
  return adapter.fetch(source, ctx);
}

/**
 * Capture for an existing item and persist the result through the typed item-write
 * helper — which REPLACES the item's assets (Story 1.5), so re-capture is idempotent
 * by item id (no duplicate asset, no duplicate item). Captured `fields` are merged
 * over the item's existing fields.
 */
export async function runCaptureForItem(
  handle: DbHandle,
  registry: CaptureRegistry,
  args: {
    itemId: string;
    boardId: string;
    source: CaptureSource;
    signal?: AbortSignal;
    screenshotsDir?: string;
    registerTeardown?: (teardown: () => Promise<void>) => void;
  },
): Promise<void> {
  const board = handle.db.select().from(boards).where(eq(boards.id, args.boardId)).get();
  const descriptor = board?.descriptor as BoardDescriptor | undefined;
  const ingestMode = descriptor?.ingest_mode;
  if (!ingestMode) throw new Error(`Board "${args.boardId}" has no ingest_mode`);

  const result = await dispatchCapture(registry, ingestMode, args.source, {
    itemId: args.itemId,
    boardId: args.boardId,
    signal: args.signal,
    screenshotsDir: args.screenshotsDir,
    registerTeardown: args.registerTeardown,
  });

  const item = handle.db.select().from(items).where(eq(items.id, args.itemId)).get();

  // Captured keys that are SYSTEM COLUMNS (e.g. `title`) belong on the column, not in
  // the `item.fields` JSON bag (the descriptor contract: title/notes/favorite are
  // system columns). Lift those out; merge the rest into fields. Without this, a
  // URL-only capture would render title-less (the title would hide in fields.title).
  const systemUpdates: Record<string, unknown> = {};
  const capturedFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result.fields)) {
    if (SYSTEM_COLUMNS.has(k)) systemUpdates[k] = v;
    else capturedFields[k] = v;
  }
  const mergedFields = { ...((item?.fields as Record<string, unknown>) ?? {}), ...capturedFields };
  const assetRows: NewAsset[] = result.assets.map((a, i) => ({
    id: `${args.itemId}-${a.kind}-${i}`,
    itemId: args.itemId,
    kind: a.kind,
    path: a.path ?? '',
    width: a.width ?? null,
    height: a.height ?? null,
    hash: a.hash ?? null,
  }));

  // Capture runs INSIDE the worker job (slot held) → use the DIRECT write (calling
  // the enqueueing writeItem here would deadlock). Replaces the item's assets
  // (delete-then-insert) → idempotent re-capture.
  writeItemDirect(
    handle,
    { ...item, ...systemUpdates, id: args.itemId, boardId: args.boardId, fields: mergedFields },
    assetRows,
  );

  // Progressive reveal: the row now holds the page (title + image) but the AI read is
  // still outstanding, and the item's DB status stays `processing` throughout. Announce
  // the partial fill so the card shows the real page instead of a skeleton while the
  // LLM runs. Distinct from a status transition — nothing in the DB changed state.
  const shot = assetRows.find((a) => a.kind === 'screenshot') ?? assetRows.find((a) => a.kind === 'image');
  statusHub.publish({
    itemId: args.itemId,
    boardId: args.boardId,
    status: 'captured',
    title: (systemUpdates as { title?: string }).title ?? item?.title ?? undefined,
    screenshot: shot?.path || undefined,
  });
}
