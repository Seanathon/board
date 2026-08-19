import { createHash } from 'node:crypto';

import { launchBrowser } from '../browser.js';
import { config } from '../config.js';
import type { DbHandle } from '../db/index.js';
import { enqueueJob, type TimeoutFn } from '../db/queue.js';
import { writeSnapshotAssetDirect, type SnapshotAssetRef, type SnapshotCapture } from '../db/snapshot-asset.js';
import { createBrowserTeardown, type TeardownBrowser } from './teardown.js';
import { assertCapturableUrl } from './net-guard.js';

// Story 16.1 — snapshot capture (self-contained HTML via SingleFile) on the EXISTING
// single-Chrome sidecar. It mirrors createUrlScreenshotAdapter's lifecycle (injectable
// launch, teardown registered around the launch PROMISE, awaited in finally) so it
// serializes on the one worker at concurrency 1 — no second Chrome.
//
// SingleFile (single-file-cli) is an AGPL OPTIONAL dependency. npm installs optional deps
// by default, so the package may be present on disk — but the DEFAULT driver below only
// LOADS it lazily (dynamic import) when an archive actually runs, and drives it against
// the browser we already launched via its CDP endpoint (no second Chrome). So board-oss
// core never *imports* AGPL code on any normal path; archival is opt-in (Epic 16.2).
// captureHtml is injectable; tests fake it, and the default's exact SingleFile wiring
// (the {initialize,capture,finish} shape + backEnd:'cdp' connecting to wsEndpoint rather
// than spawning) is verified by inspection/manual run (no real Chrome in the suite).

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8MB per-snapshot cap (footprint guardrail)
// SingleFile inlines every asset on the page, so this is strictly slower than the
// screenshot capture it mirrors — 45s under-served a heavy page and, because a failed
// snapshot is swallowed (AC4), it just silently produced no archive. Sized like the
// other capture budgets: a ceiling for a wedged job on a single-tenant box, not an SLO.
const SNAPSHOT_TIMEOUT_MS = 180_000;

export interface SnapshotBrowser extends TeardownBrowser {
  /** puppeteer Browser.wsEndpoint() — the CDP endpoint SingleFile connects to. */
  wsEndpoint?(): string;
}
export type SnapshotLaunchFn = () => Promise<SnapshotBrowser>;
export type CaptureHtmlFn = (browser: SnapshotBrowser, url: string, signal?: AbortSignal) => Promise<string>;

export interface SnapshotCtx {
  itemId: string;
  signal?: AbortSignal;
  registerTeardown?: (teardown: () => Promise<void>) => void;
}

interface SnapshotDeps {
  launch?: SnapshotLaunchFn;
  /** Drives SingleFile against the EXISTING browser, returning the self-contained HTML. */
  captureHtml?: CaptureHtmlFn;
  /** Per-snapshot byte cap; over-cap → no asset (skip). */
  maxBytes?: number;
}

/**
 * The default SingleFile driver: lazily import the optional AGPL `single-file-cli` and
 * drive it against the EXISTING browser via CDP (no second Chrome). If the package is
 * not installed, the dynamic import rejects — and runSnapshotJob swallows it (graceful
 * degradation: no asset, item untouched). Exact wiring verified manually, not in the suite.
 */
const defaultCaptureHtml: CaptureHtmlFn = async (browser, url) => {
  // Optional dependency — absent in a default install. Absence → reject → swallowed.
  const sfApi = (await import('single-file-cli' as string)) as {
    initialize: (opts: Record<string, unknown>) => Promise<{
      capture: (opts: Record<string, unknown>) => Promise<{ content?: string } | Array<{ content?: string }>>;
      finish: () => Promise<void>;
    }>;
  };
  const browserServer = typeof browser.wsEndpoint === 'function' ? browser.wsEndpoint() : undefined;
  // backEnd 'cdp' connects to the browser we already launched rather than spawning one.
  const api = await sfApi.initialize({ backEnd: 'cdp', browserServer, browserHeadless: true });
  try {
    const result = await api.capture({ url, browserServer, backEnd: 'cdp' });
    const page = Array.isArray(result) ? result[0] : result;
    const content = page?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('SingleFile produced no content');
    }
    return content;
  } finally {
    await api.finish().catch(() => {});
  }
};

export function createUrlSnapshotCapture(deps: SnapshotDeps = {}) {
  const launch = deps.launch ?? (async () => (await launchBrowser()) as unknown as SnapshotBrowser);
  const captureHtml = deps.captureHtml ?? defaultCaptureHtml;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    /**
     * Capture the page as self-contained HTML. Returns the bytes + sha256, or `null`
     * when over the byte cap (skip — no file is written by capture; persistence is
     * writeSnapshotAsset's job). Teardown is registered around the launch promise and
     * ALWAYS awaited (memoized) — a timeout during launch still tears Chrome down.
     */
    async capture(url: string, ctx: SnapshotCtx): Promise<SnapshotCapture | null> {
      // SSRF guard before launching Chrome — archival must not snapshot an internal target.
      await assertCapturableUrl(url);
      const launchP = launch();
      const teardown = createBrowserTeardown(launchP as unknown as Promise<TeardownBrowser>, ctx.signal);
      ctx.registerTeardown?.(teardown);
      const onAbort = () => { void teardown(); };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const browser = await launchP;
        const html = await captureHtml(browser, url, ctx.signal);
        const buf = Buffer.from(html, 'utf8');
        if (buf.byteLength > maxBytes) return null; // over-cap → skip, no asset
        const hash = createHash('sha256').update(buf).digest('hex');
        return { buf, hash, bytes: buf.byteLength };
      } finally {
        ctx.signal?.removeEventListener('abort', onAbort);
        await teardown();
      }
    },
  };
}

export interface RunSnapshotJobOpts {
  itemId: string;
  url: string;
  /** The capture instance (injectable for tests). Defaults to a real one. */
  capture?: ReturnType<typeof createUrlSnapshotCapture>;
  snapshotsDir?: string;
  timeoutMs?: number;
  timeoutFn?: TimeoutFn;
  /** Injectable file writer (forwarded to writeSnapshotAsset; tests spy on it). */
  writeFile?: (absPath: string, buf: Buffer) => void;
}

export type SnapshotOutcome =
  | { status: 'written'; asset: SnapshotAssetRef }
  | { status: 'deduped' }
  | { status: 'skipped' } // over byte cap
  | { status: 'failed' }; // timeout / OOM / throw / module-absent — item left untouched

/**
 * Run a snapshot as a STATUS-NEUTRAL job on the single worker (enqueueJob, concurrency
 * 1), NOT runItemJob — an already-curated `done` item must NEVER flip to `error` because
 * an archival snapshot failed (Story 16.1 AC4). On timeout/OOM/throw/module-absence the
 * failure is swallowed: no asset, no status change, no error surfaced.
 */
export async function runSnapshotJob(handle: DbHandle, opts: RunSnapshotJobOpts): Promise<SnapshotOutcome> {
  const capture = opts.capture ?? createUrlSnapshotCapture();
  const snapshotsDir = opts.snapshotsDir ?? config.snapshotsDir;
  let outcome: SnapshotOutcome = { status: 'failed' };
  let captureTeardown: (() => Promise<void>) | undefined;

  const result = await enqueueJob(
    {
      type: 'snapshot',
      timeoutMs: opts.timeoutMs ?? SNAPSHOT_TIMEOUT_MS,
      run: async (signal) => {
        const cap = await capture.capture(opts.url, {
          itemId: opts.itemId,
          signal,
          registerTeardown: (fn) => { captureTeardown = fn; },
        });
        if (!cap) {
          outcome = { status: 'skipped' }; // over the byte cap
          return;
        }
        // DIRECT (no enqueue): we already hold the single-writer slot inside this job;
        // the enqueued writeSnapshotAsset here would deadlock (inner enqueue waits on
        // the outer slot, which awaits the inner) — the writeItemDirect trap.
        const { written, asset } = writeSnapshotAssetDirect(handle, opts.itemId, cap, {
          snapshotsDir,
          writeFile: opts.writeFile,
        });
        outcome = written && asset ? { status: 'written', asset } : { status: 'deduped' };
      },
      // On timeout the worker awaits this before releasing the slot, so the capture's
      // browser is SIGKILL-ed (memoized teardown) before the next job can launch — two
      // Chromiums never coexist (NFR-1).
      teardown: async () => { if (captureTeardown) await captureTeardown(); },
    },
    { timeoutFn: opts.timeoutFn },
  );

  // A failed/timed-out job leaves `outcome` as 'failed' — item status is never touched.
  if (!result.ok) return { status: 'failed' };
  return outcome;
}
