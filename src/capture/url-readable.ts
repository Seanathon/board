import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { config } from '../config.js';
import { captureLibrary } from '../processor-library.js';
import type { AssetSpec, CaptureAdapter, CaptureCtx, CaptureResult, CaptureSource } from './adapter.js';
import { assertCapturableUrl } from './net-guard.js';

// Story 6.3 — url-readable adapter (Library). A thin wrapper over the prototype's
// proven Library capture (`captureLibrary`: plain fetch → Readability + turndown →
// markdown, with a headless-render SPA fallback when the text is too thin, and a
// clear "no readable text" error otherwise). REUSED from processor-library.ts (not
// forked) — the logic is sound and already injectable/tested. Decoupled from
// analysis (Library enrichment is Epic 7).
//
// Readable captures take no screenshot, so a card had no picture. We now also pull the
// page's og:image (extracted by captureLibrary) and download it as the item's `image`
// asset — so product/wish-list cards get a hero image. Best-effort: any failure (no
// image, blocked URL, non-image type, oversize, network) leaves the capture successful
// with no asset, and the UI shows its honest "no image" placeholder instead of failing.

/** Pull the title from the markdown's leading `# ` line (extractReadableMarkdown). */
function titleFromMarkdown(markdown: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m ? m[1].trim() : undefined;
}

// Only types the screenshot route serves with an image content-type (server.ts).
const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // a hero image over ~12MB is almost certainly wrong
// A hero image can be several MB; 8s dropped it on any slow link, and the card then
// fell back to its no-image placeholder with no sign anything had gone wrong.
const IMAGE_TIMEOUT_MS = 30_000;

interface Deps {
  fetchImpl?: typeof fetch;
  renderImpl?: (url: string) => Promise<string>;
  /** Injectable SSRF guard (tests avoid real DNS); defaults to assertCapturableUrl. */
  assertUrl?: (url: string) => Promise<void>;
}

/**
 * Download the hero image as the item's `image` asset. Best-effort: returns undefined
 * (NOT throw) on a blocked URL, non-image content-type, oversize body, or any network
 * error — capture must still succeed with its text. SSRF-guarded; size/type/time-capped.
 */
async function downloadHeroImage(
  imageUrl: string,
  ctx: CaptureCtx,
  deps: Deps,
): Promise<AssetSpec | undefined> {
  const fetchFn = deps.fetchImpl ?? globalThis.fetch;
  const assertUrl = deps.assertUrl ?? assertCapturableUrl;
  try {
    await assertUrl(imageUrl); // SSRF: the og:image URL is also user-influenced data
  } catch {
    return undefined; // blocked (private/loopback/bad scheme) → honest fallback
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchFn(imageUrl, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return undefined;
    const ctype = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_EXT[ctype];
    if (!ext) return undefined; // not a renderable image type
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return undefined;

    const screenshotsDir = ctx.screenshotsDir ?? config.screenshotsDir;
    const filename = `${ctx.itemId}-og.${ext}`;
    const abs = join(screenshotsDir, filename);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    return {
      kind: 'image',
      path: `screenshots/${filename}`, // relative form (Story 2.2), served at /screenshots/
      hash: createHash('sha256').update(buf).digest('hex'),
    };
  } catch {
    return undefined; // timeout / network / decode → honest fallback
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
}

export function createUrlReadableAdapter(deps: Deps = {}): CaptureAdapter {
  return {
    ingestMode: 'url-readable',
    async fetch(source: CaptureSource, ctx: CaptureCtx): Promise<CaptureResult> {
      if (typeof source !== 'string') {
        throw new Error('url-readable adapter requires a URL source');
      }
      const url = source;
      // captureLibrary throws a clear "No readable text…" error if both the direct
      // fetch and the render fallback yield too little (→ Story 5.2 marks `error`).
      // The render fallback launches Chrome via renderPageText, which closes in
      // `finally` (browser.ts); Story 6.5 adds the abort-signal force-close.
      void ctx.signal; // (6.5 wires cooperative cancellation into the render fallback)
      const captured = await captureLibrary(url, { fetchImpl: deps.fetchImpl, renderImpl: deps.renderImpl });

      const text = captured.text;
      const title = titleFromMarkdown(text);
      // Only include title when extracted — an undefined title must not overwrite an
      // existing item.title on re-capture (runCaptureForItem lifts title → column).
      const fields: Record<string, unknown> = { text, url };
      if (title) fields.title = title;

      // Best-effort hero image (og:image). Never fails the capture.
      const assets: AssetSpec[] = [];
      if (captured.imageUrl) {
        const asset = await downloadHeroImage(captured.imageUrl, ctx, deps);
        if (asset) assets.push(asset);
      }
      return { fields, assets };
    },
  };
}
