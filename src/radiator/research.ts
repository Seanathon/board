import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { JSDOM } from 'jsdom';
import { assertCapturableUrl } from '../capture/net-guard.js';

const MAX_BYTES = 1048576;
export class RadiatorResearchError extends Error {
  constructor(message = 'Current primary sources could not be read') { super(message); this.name = 'RadiatorResearchError'; }
}
export interface ResearchSource {
  id: string; url: string; title: string; retrievedOn: string; text: string;
  rawSha256: string; excerptSha256: string; fullTextChars: number; truncated: boolean;
}
export interface ResearchOptions {
  signal?: AbortSignal;
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof https.get;
  now?: () => Date;
  /** Internal supplement/fallback boundary, not a URL-supplied option. */
  allowedOrigin?: string;
}
const sha = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');
export async function fetchPublic(raw: string, options: ResearchOptions = {}, redirects = 0): Promise<{ url: string; bytes: Buffer; mime: string }> {
  options.signal?.throwIfAborted();
  const url = new URL(raw);
  assert(!options.allowedOrigin || url.origin === options.allowedOrigin, 'Supplement left the checked primary origin');
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && (!url.port || ['80', '443'].includes(url.port)), 'Unsupported public source URL');
  assert(redirects <= 5, 'Source redirect bound exceeded');
  // Fail closed on DNS failure or IPv6-only hosts; pin validated IPv4 at connection time.
  const dnsSignal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const aborted = () => reject(dnsSignal.reason);
    dnsSignal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => (options.lookup ?? (host => dns.lookup(host, { family: 4, all: true })))(url.hostname.replace(/^\[|\]$/g, '')))
      .then(resolve, reject).finally(() => dnsSignal.removeEventListener('abort', aborted));
    if (dnsSignal.aborted) aborted();
  });
  options.signal?.throwIfAborted();
  assert(addresses.length && addresses.every(a => a.family === 4 && isIP(a.address) === 4), 'No public IPv4 address');
  await assertCapturableUrl(url.href, { lookup: async () => addresses });
  for (const a of addresses) await assertCapturableUrl(`http://${a.address}`);
  options.signal?.throwIfAborted();
  const address = addresses[0];
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const result = await new Promise<{ url: string; bytes: Buffer; mime: string } | { redirect: string }>((resolve, reject) => {
    const request = options.request ?? (url.protocol === 'https:' ? https.get : http.get);
    const req = request(url, { signal, headers: { 'user-agent': 'Board product research/1', 'accept-encoding': 'identity' },
      lookup: (_host, opts, callback) => opts.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, res => {
      res.on('error', reject);
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
        try { const redirect = new URL(res.headers.location, url).href; res.destroy(); resolve({ redirect }); }
        catch { res.destroy(); reject(new RadiatorResearchError('Primary source returned an invalid redirect')); }
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); reject(new RadiatorResearchError(`Primary source returned HTTP ${res.statusCode ?? 0}`)); return; }
      if (String(res.headers['content-encoding'] ?? 'identity').toLowerCase() !== 'identity') { res.destroy(); reject(new RadiatorResearchError('Compressed primary source was refused')); return; }
      const mime = String(res.headers['content-type'] ?? '').toLowerCase();
      if (!(mime.startsWith('text/') || mime.includes('application/xhtml+xml'))) { res.destroy(); reject(new RadiatorResearchError('Primary source was not readable text')); return; }
      const chunks: Buffer[] = []; let count = 0;
      res.on('data', (chunk: Buffer) => { count += chunk.length; if (count > MAX_BYTES) res.destroy(new RadiatorResearchError('Primary source exceeded 1 MiB')); else chunks.push(chunk); });
      res.on('end', () => resolve({ url: url.href, bytes: Buffer.concat(chunks), mime }));
    });
    req.on('error', reject);
  });
  options.signal?.throwIfAborted();
  return 'redirect' in result ? fetchPublic(result.redirect, options, redirects + 1) : result;
}
export function extractSource(bytes: Buffer, url: string, mime = 'text/html'): { title: string; text: string; fullTextChars: number; truncated: boolean; links: string[] } {
  assert(bytes.length <= MAX_BYTES, 'Primary source exceeded 1 MiB');
  if (!mime.includes('html')) {
    const text = bytes.toString('utf8').replace(/\u0000/g, '').trim();
    return { title: new URL(url).hostname + ' source document', text: text.slice(0, 6000), fullTextChars: text.length, truncated: text.length > 6000, links: [] };
  }
  const dom = new JSDOM(bytes.toString('utf8'), { url }); // no scripts, subresources or browser session
  try {
    const doc = dom.window.document;
    const links = [...doc.querySelectorAll<HTMLAnchorElement>('a[href]')].map(a => a.href);
    const title = doc.title.slice(0, 300);
    const description = doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
    doc.querySelectorAll('script,style,noscript,svg,template').forEach(node => node.remove());
    doc.querySelectorAll('p,div,li,section,h1,h2,h3,h4,tr,br').forEach(node => node.prepend(doc.createTextNode('\n')));
    const full = (title + '\n' + description + '\n' + (doc.body?.textContent ?? '')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return { title, text: full.slice(0, 6000), fullTextChars: full.length, truncated: full.length > 6000, links };
  } finally { dom.window.close(); }
}
function readable(text: string): void {
  if (/verify (you are|that you are) human|just a moment|checking your browser|enable javascript and cookies|access denied/i.test(text)) throw new RadiatorResearchError('Current primary source was blocked');
  if (text.length < 160) throw new RadiatorResearchError('Current primary source was thin');
}
/** At most two inspected pages, three attempts including a same-origin text fallback. */
export async function researchProduct(source: string, options: ResearchOptions = {}): Promise<ResearchSource[]> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  const opts = { ...options, signal };
  const records: ResearchSource[] = [];
  const inspected = async (url: string, allowedOrigin?: string) => {
    const response = await fetchPublic(url, { ...opts, allowedOrigin });
    const parsed = extractSource(response.bytes, response.url, response.mime);
    readable(parsed.text);
    records.push({ id: `T${records.length + 1}`, url: response.url, title: parsed.title, retrievedOn: (options.now?.() ?? new Date()).toISOString().slice(0, 10), text: parsed.text,
      rawSha256: sha(response.bytes), excerptSha256: sha(parsed.text), fullTextChars: parsed.fullTextChars, truncated: parsed.truncated });
    return { ...parsed, url: response.url };
  };
  let primary;
  try { primary = await inspected(source); }
  catch (error) {
    signal.throwIfAborted();
    // Do not retry access denials/auth/challenges. Only oversized/thin ordinary material gets a bounded text alternative.
    if (!(error instanceof RadiatorResearchError) || !/exceeded 1 MiB|was thin$/.test(error.message)) throw error;
    primary = await inspected(new URL('/llms.txt', source).href, new URL(source).origin);
  }
  const origin = new URL(primary.url).origin;
  const candidate = primary.links.find(raw => {
    try { const u = new URL(raw); return u.origin === origin && u.href !== primary.url && /\/(pricing|docs|product)(?:\/|$)/i.test(u.pathname) && !u.username && !u.password; } catch { return false; }
  });
  if (candidate) {
    try { await inspected(candidate, origin); } catch { signal.throwIfAborted(); /* Partial evidence remains explicitly partial; no guessed source. */ }
  }
  signal.throwIfAborted();
  return records;
}
