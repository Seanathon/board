import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { launchBrowser } from '../browser.js';
import { config } from '../config.js';
import { createBrowserTeardown, type TeardownBrowser } from './teardown.js';
import type { AssetSpec, CaptureAdapter, CaptureCtx, CaptureResult, CaptureSource } from './adapter.js';

// Story 6.2 — url-screenshot adapter (Inspiration). Ports the prototype's full-page
// screenshot flow (add.ts screenshot/dismissOverlays) behind the CaptureAdapter
// seam, decoupled from analysis (enrichment is Epic 7). Net-new vs the prototype:
// the launcher is INJECTABLE (the prototype hardcoded puppeteer.launch), and errors
// PROPAGATE (the prototype swallowed them → ""), so Story 5.2 can mark the item
// `error`. Teardown (`close()`) is guaranteed in `finally` and on abort (timeout).

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1.5 };
// Budget for reaching `domcontentloaded` — a REAL failure if it expires (no document,
// nothing to shoot). 30s was inherited from when this timeout ALSO had to absorb the
// wait for a quiet network; the settle is separate and best-effort now, so the two
// budgets are sized independently.
//
// These are deliberately generous. board-oss is single-tenant and self-hosted: nobody
// is queued behind you competing for a shared worker, so a capture that takes two
// minutes and SUCCEEDS beats one that fails fast at 30s and leaves you re-adding the
// link by hand. A heavy page on a slow link needs well over 30s just to parse — under
// CDP throttling twenty.com missed the old budget at 30.9s and the item died with
// "Timed out." Timeouts here exist to stop a genuinely wedged capture, not to enforce
// a latency SLO.
const GOTO_TIMEOUT_MS = 120_000;
// How long to let the network go quiet AFTER the document is ready. Best-effort: when
// it expires we shoot anyway. See the note on the goto strategy below.
const SETTLE_TIMEOUT_MS = 30_000;

// Minimal puppeteer-ish surfaces so the launcher is injectable (real Browser fits).
export interface CapturePage {
  setViewport(vp: { width: number; height: number; deviceScaleFactor: number }): Promise<unknown>;
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  /**
   * Optional ONLY so hand-written test fakes stay valid. Real captures always take the
   * settle path: puppeteer's Page has had this since v5 and we pin ^24. Don't read the
   * `?.` at the call site as "this might not run in production" — it always does.
   */
  waitForNetworkIdle?(opts: { idleTime: number; timeout: number }): Promise<unknown>;
  screenshot(opts: { clip: { x: number; y: number; width: number; height: number } }): Promise<Buffer | Uint8Array>;
  evaluate<T>(fn: (...args: unknown[]) => T): Promise<T>;
}
export interface CaptureBrowser {
  newPage(): Promise<CapturePage>;
  close(): Promise<void>;
}
export type LaunchFn = () => Promise<CaptureBrowser>;

interface Deps {
  launch?: LaunchFn;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Dismiss cookie/consent/overlay junk before the shot (ported from add.ts:272-310).
async function dismissOverlays(page: CapturePage): Promise<void> {
  await page.evaluate(() => {
    const dismissText = ['accept', 'accept all', 'accept cookies', 'agree', 'allow', 'close', 'dismiss', 'got it', 'i understand', 'no thanks', 'ok', 'okay', 'reject all', 'decline', 'deny'];
    const buttons = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]')) as HTMLElement[];
    for (const btn of buttons) {
      const text = btn.innerText?.toLowerCase().trim();
      if (dismissText.some((d) => text === d || text?.startsWith(d))) { btn.click(); break; }
    }
    const style = document.createElement('style');
    style.textContent = `
      [class*="cookie"], [class*="Cookie"], [class*="consent"], [class*="Consent"],
      [class*="gdpr"], [class*="GDPR"], [class*="banner"], [id*="banner"],
      [class*="popup"], [id*="popup"], [class*="modal"], [class*="overlay"],
      [class*="notice"], [id*="notice"], [id*="cookie"], [id*="consent"],
      #onetrust-banner-sdk, .cc-banner, .cookielaw-banner,
      [aria-label*="cookie" i], [aria-label*="consent" i] { display: none !important; }
      body { overflow: auto !important; }`;
    document.head.appendChild(style);
  });
}

export function createUrlScreenshotAdapter(deps: Deps = {}): CaptureAdapter {
  const launch = deps.launch ?? (async () => (await launchBrowser()) as unknown as CaptureBrowser);
  const sleep = deps.sleep ?? realSleep;

  return {
    ingestMode: 'url-screenshot',
    async fetch(source: CaptureSource, ctx: CaptureCtx): Promise<CaptureResult> {
      if (typeof source !== 'string') {
        throw new Error('url-screenshot adapter requires a URL source');
      }
      const url = source;
      // Story 6.5: start the launch and register the memoized teardown around the
      // PROMISE (before awaiting) so a timeout DURING launch still tears the browser
      // down and the worker's gate isn't bypassed (launch-window race). On abort:
      // SIGKILL + bounded await exit; else close().
      const launchP = launch();
      const teardown = createBrowserTeardown(launchP as unknown as Promise<TeardownBrowser>, ctx.signal);
      ctx.registerTeardown?.(teardown);
      const onAbort = () => { void teardown(); };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const browser = await launchP;
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        // Navigate on `domcontentloaded`, then let the network settle SEPARATELY and
        // best-effort. `waitUntil: 'networkidle2'` made a quiet network a PRECONDITION
        // of the capture: any page holding a connection open — analytics beacon, chat
        // widget, video preload, websocket — never satisfies it, and goto rejected at
        // 30s with a TimeoutError that cleanErrorReason renders on the card as
        // "Timed out." (reproduced against twenty.com and stigg.io under CDP
        // throttling: 30755ms, no item). A slow connection does the same to an
        // ordinary page. Screenshot quality is worth waiting for; it is not worth
        // losing the item over, so a settle that expires just means we shoot a beat
        // early. renderPageText (browser.ts) already navigates this way.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
        await page.waitForNetworkIdle?.({ idleTime: 500, timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
        await sleep(1000);
        await dismissOverlays(page);
        await sleep(400);

        const shot = await page.screenshot({ clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });
        const buf = Buffer.isBuffer(shot) ? shot : Buffer.from(shot);

        const { title, text } = await page.evaluate(() => ({
          title: document.title,
          text: (document.body.innerText || '').substring(0, 10000),
        }));

        const screenshotsDir = ctx.screenshotsDir ?? config.screenshotsDir;
        const filename = `${ctx.itemId}.png`;
        const abs = join(screenshotsDir, filename);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, buf);
        const hash = createHash('sha256').update(buf).digest('hex');

        const asset: AssetSpec = {
          kind: 'screenshot',
          path: `screenshots/${filename}`, // relative form (Story 2.2)
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          hash,
        };
        return { fields: { title, text, url }, assets: [asset] };
      } finally {
        ctx.signal?.removeEventListener('abort', onAbort);
        await teardown(); // teardown ALWAYS (memoized; no leaked Chrome)
      }
    },
  };
}
