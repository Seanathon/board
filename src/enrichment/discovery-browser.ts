import http from 'node:http';
import type { Browser, ElementHandle, HTTPRequest } from 'puppeteer-core';
import { launchBrowser } from '../browser.js';
import { createBrowserTeardown, type TeardownBrowser } from '../capture/teardown.js';
import { abortable, discoveryUrl, DISCOVERY_LAUNCH_TIMEOUT_MS, type DiscoveryReader } from './discovery-net.js';

export interface DiscoveryCandidate { id: string; label: string; url?: string }
export interface DiscoverySnapshot { url: string; text: string; candidates: DiscoveryCandidate[] }
export interface DiscoveryBrowser {
  snapshot(): Promise<DiscoverySnapshot>;
  act(id: string): Promise<void>;
  navigate(url: string): Promise<void>;
  dispose(): Promise<void>;
}
let terminationUnconfirmed = false;
const readControl = /\b(tutorial|documentation|docs|guide|learn|help|read|overview|features|details|about|how|getting started|next|previous|close)\b/i;
const unsafeControl = /\b(sign.?in|sign.?up|register|log.?in|log.?out|sign.?out|buy|pay|checkout|submit|send|delete|remove|download|install|accept|agree|subscribe|captcha|verify)\b/i;

export const isDiscoveryChallenge = (text: string): boolean => /verify (?:you are|that you are) human|checking your browser|enable javascript and cookies|access denied|(?:complete|solve) (?:the |this )?captcha/i.test(text);
export const safeDiscoveryLabel = (label: string): boolean => !!label.trim() && !unsafeControl.test(label);

export async function openDiscoveryBrowser(args: {
  publisher: string; read: DiscoveryReader; signal: AbortSignal; errors: string[];
  launch?: (args: string[]) => Promise<Browser>;
}): Promise<DiscoveryBrowser> {
  args.signal.throwIfAborted();
  if (terminationUnconfirmed) throw new Error('Discovery browser termination unconfirmed; restart required');
  // No Chrome-originated network is trusted, including requests before interception,
  // popups, workers and WebSockets. The only permitted egress is the pinned reader.
  const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  proxy.on('connect', (_req, socket) => socket.destroy());
  proxy.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const port = (proxy.address() as { port: number }).port;
  const flags = [`--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>', '--disable-quic', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-extensions', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
  const launch = Promise.resolve().then(() => {
    args.signal.throwIfAborted();
    return (args.launch ?? ((extraArgs) => launchBrowser({ extraArgs, timeoutMs: DISCOVERY_LAUNCH_TIMEOUT_MS })))(flags);
  });
  const kill = new AbortController();
  const teardown = createBrowserTeardown(launch as unknown as Promise<TeardownBrowser>, kill.signal);
  let disposed: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const dispose = () => disposed ??= (async () => {
    args.signal.removeEventListener('abort', onAbort);
    // Always kill the dedicated disposable process: even normal close can wedge.
    kill.abort();
    await teardown();
    const process = (await launch.catch(() => null))?.process();
    if (process && process.exitCode === null && process.signalCode === null) {
      terminationUnconfirmed = true;
      args.errors.push('Discovery browser termination unconfirmed; further discovery is disabled until restart');
    }
    await Promise.allSettled([...pending]);
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  })();
  const onAbort = () => { void dispose(); };
  args.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const browser = await abortable(launch, args.signal);
    args.signal.throwIfAborted();
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000); page.setDefaultNavigationTimeout(8_000);
    const session = await page.createCDPSession();
    await session.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    page.on('popup', popup => { void popup?.close().catch(() => {}); });
    await page.evaluateOnNewDocument(() => {
      window.open = () => null;
      document.addEventListener('submit', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
    });
    let documents = 0;
    const respond = async (req: HTTPRequest) => {
      try {
        args.signal.throwIfAborted();
        if (req.method() !== 'GET' || !['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(req.resourceType()) || req.frame() !== page.mainFrame()) throw new Error('Discovery request type denied');
        if (req.resourceType() === 'document' && ++documents > 4) throw new Error('Discovery page budget exhausted');
        discoveryUrl(req.url(), args.publisher);
        const response = await args.read(req.url());
        args.signal.throwIfAborted();
        if (response.url !== req.url()) {
          await req.respond({ status: 302, headers: { location: response.url } }); return;
        }
        // Documentation servers may negotiate Markdown for research clients. Render
        // it as plain text instead of triggering Chromium's unsupported-MIME download.
        const contentType = response.contentType.replace(/^(?:text\/(?:x-)?markdown|application\/markdown)(?=;|$)/i, 'text/plain');
        await req.respond({ status: response.status, contentType, body: response.body,
          headers: { 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
      } catch (err) {
        if (args.errors.length < 12) args.errors.push(String((err as Error).message));
        if (!req.isInterceptResolutionHandled()) await req.abort().catch(() => {});
      }
    };
    page.on('request', req => { const work = respond(req); pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {}); });
    let candidates = new Map<string, { element: ElementHandle<Element>; label: string; url?: string }>();
    let serial = 0;
    const inspect = async (element: ElementHandle<Element>) => element.evaluate(el => {
      const html = el as HTMLElement;
      const label = (html.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 160);
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      return { label, visible, form: !!el.closest('form') || (el instanceof HTMLButtonElement && !!el.form), disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true', download: el.hasAttribute('download'), type: el.getAttribute('type'), tag: el.tagName, role: el.getAttribute('role'), url: el instanceof HTMLAnchorElement ? el.href : undefined };
    });
    const allowed = (info: Awaited<ReturnType<typeof inspect>>) => info.visible && !info.form && !info.disabled && !info.download && !['submit', 'reset'].includes(info.type ?? '') && safeDiscoveryLabel(info.label) && (info.url || info.role === 'tab' || info.tag === 'SUMMARY' || readControl.test(info.label));
    const navigate = async (url: string) => {
      args.signal.throwIfAborted();
      await abortable(page.goto(discoveryUrl(url, args.publisher).href, { waitUntil: 'domcontentloaded' }), args.signal);
      await abortable(new Promise<void>(resolve => setTimeout(resolve, 250)), args.signal);
    };
    return {
      navigate, dispose,
      async snapshot() {
        args.signal.throwIfAborted();
        discoveryUrl(page.url(), args.publisher);
        for (const c of candidates.values()) await c.element.dispose();
        candidates = new Map();
        // Fixed semantic roots, never model-provided selectors. A visible active
        // dialog/tab panel takes precedence over a long graph or menu behind it.
        const observation = await page.evaluateHandle(() => {
          const roots = [...document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"],[role="tabpanel"]')].filter(el => {
            const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.opacity !== '0' && !el.closest('[hidden],[aria-hidden="true"]');
          });
          return roots.filter(el => el.matches('dialog[open],[role="dialog"],[aria-modal="true"]')).at(-1) ?? roots.at(-1) ?? document.body ?? document.documentElement;
        });
        try {
          const root = observation.asElement();
          if (!root) throw new Error('Discovery observation unavailable');
          const selector = 'a[href],button,[role="tab"],summary,[role="button"]';
          const elements = await root.$$(selector);
          if (await root.evaluate(el => el !== document.body && el !== document.documentElement)) {
            // Prefer documentation controls without losing sibling tabs/navigation.
            for (const element of await page.$$(selector)) {
              if (await element.evaluate((el, scope) => scope.contains(el), root)) await element.dispose();
              else elements.push(element);
            }
          }
          for (const element of elements) {
            const info = await inspect(element);
            let safe = allowed(info);
            if (safe && info.url) { try { discoveryUrl(info.url, args.publisher); } catch { safe = false; } }
            if (safe && candidates.size < 40) candidates.set(`control-${++serial}`, { element, label: info.label, url: info.url });
            else await element.dispose();
          }
          const text = await root.evaluate(el => ((el as HTMLElement).innerText ?? '').slice(0, 12_000));
          if (isDiscoveryChallenge(text)) throw new Error('Discovery challenge page; not bypassed');
          return { url: page.url(), text, candidates: [...candidates].map(([id, c]) => ({ id, label: c.label, ...(c.url ? { url: c.url } : {}) })) };
        } finally { await observation.dispose(); }
      },
      async act(id) {
        args.signal.throwIfAborted();
        const c = candidates.get(id); if (!c) throw new Error('Unknown discovery candidate');
        const info = await inspect(c.element);
        if (!allowed(info) || info.label !== c.label || info.url !== c.url) throw new Error('Discovery control changed');
        if (info.url) {
          const target = discoveryUrl(info.url, args.publisher), current = new URL(page.url());
          // Follow document links in this controlled page, even when their UI opens a
          // new tab. Same-document/fragment controls still need their actual click.
          if (target.origin !== current.origin || target.pathname !== current.pathname || target.search !== current.search) { await navigate(target.href); return; }
        }
        // Click the actual element, including anchors: href="#tutorial" may open
        // documentation in a modal rather than navigate. All resulting reads still
        // pass through interception; forms, downloads and popups stay denied.
        const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 1200 }).catch(() => null);
        await abortable(c.element.click(), args.signal);
        await abortable(navigation, args.signal);
        await abortable(new Promise<void>(resolve => setTimeout(resolve, 250)), args.signal);
      },
    };
  } catch (err) { await dispose(); throw err; }
}
