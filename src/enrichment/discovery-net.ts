import dns from 'node:dns/promises';
import { MIMEType } from 'node:util';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { assertCapturableUrl, BlockedUrlError } from '../capture/net-guard.js';

// Discovery is stricter than legacy capture: fail closed, validate every hop,
// pin the socket lookup, omit credentials/cookies and never use ambient proxies.
const reserved = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) reserved.addSubnet(ip, bits, 'ipv4');
const global6 = new net.BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) reserved.addSubnet(ip, bits, 'ipv6');
export function publicAddress(address: string): boolean {
  const family = net.isIP(address);
  return family === 4 ? !reserved.check(address, 'ipv4') : family === 6 && global6.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
}
const unsafePath = /(?:^|[\W_])(login|logout|signin|signout|signup|register|auth|oauth|checkout|cart|purchase|subscribe|unsubscribe|delete|remove|download|export|captcha|challenge)(?:[\W_]|$)/i;
/** Whole-discovery wall-clock budget: reads, model decisions and browser work together. */
export const DISCOVERY_TIME_BUDGET_MS = 45_000;
/**
 * How long Chromium gets to start and print its DevTools endpoint. A cold start on a
 * loaded CT or a shared CI runner can take 10s or more (a 10s limit flaked in CI, where
 * the passing run took 12s), so this is twice that. It must stay well inside the budget:
 * the budget's abort still cuts a stuck launch short.
 */
export const DISCOVERY_LAUNCH_TIMEOUT_MS = 20_000;

export function discoveryUrl(raw: string, publisher: string): URL {
  const url = new URL(raw, publisher), root = new URL(publisher);
  // Product-owned documentation commonly lives beneath the saved hostname.
  const samePublisher = url.hostname === root.hostname || (!net.isIP(root.hostname.replace(/^\[|\]$/g, '')) && url.hostname.endsWith('.' + root.hostname));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port !== '' && !['80', '443'].includes(url.port)) || !samePublisher || url.port !== root.port || (root.protocol === 'https:' && url.protocol !== 'https:') || unsafePath.test(decodeURIComponent(url.pathname + url.search + url.hash))) throw new BlockedUrlError('Unsafe discovery destination');
  return url;
}
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
export interface DiscoveryRead { url: string; status: number; contentType: string; body: Buffer }
/** Plain/XML text honours the advertised encoding; HTML uses JSDOM byte sniffing. */
export function decodeDiscoveryText(response: DiscoveryRead): string {
  const charset = new MIMEType(response.contentType).params.get('charset') ?? 'utf-8';
  return new TextDecoder(charset).decode(response.body);
}
export type DiscoveryReader = (url: string) => Promise<DiscoveryRead>;
export function createDiscoveryReader(publisher: string, signal: AbortSignal, options: {
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof http.request;
  maxRequests?: number;
  maxBytes?: number;
} = {}): DiscoveryReader {
  let requests = 0, bytes = 0;
  return async (raw) => {
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    let url = discoveryUrl(raw, publisher);
    for (let hop = 0; hop < 5; hop++) {
      readSignal.throwIfAborted();
      if (++requests > (options.maxRequests ?? 96)) throw new Error('Discovery request budget exhausted');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await abortable((options.lookup ?? ((h) => dns.lookup(h, { all: true })))(host), readSignal);
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new BlockedUrlError('Discovery DNS did not resolve exclusively to public addresses');
      await assertCapturableUrl(url.href, { lookup: async () => addresses });
      const address = addresses[0];
      const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const request = options.request ?? (url.protocol === 'https:' ? https.request : http.request);
        const transportUrl = new URL(url); transportUrl.hash = '';
        const req = request(transportUrl, {
          method: 'GET', agent: false, signal: readSignal,
          ...(url.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
          // Node must not resolve this hostname again. Host header / TLS SNI remain
          // the original hostname; only the connection address is overridden.
          lookup: ((_host: string, opts: { all?: boolean }, cb: Function) => opts.all ? cb(null, [address]) : cb(null, address.address, address.family)) as net.LookupFunction,
          headers: { 'user-agent': 'BoardDiscovery/1', accept: 'text/html,application/xhtml+xml,application/xml,text/plain,application/javascript,text/css,application/json', 'accept-encoding': 'identity' },
        }, res => {
          // SPA application bundles can exceed document limits; keep both per-read and aggregate bounds.
          const asset = /^(application\/(?:javascript|json)|text\/(?:javascript|css))(?:\s*;|$)/i.test(String(res.headers['content-type'] ?? ''));
          const maxResponseBytes = asset ? 4_000_000 : 1_000_000;
          const chunks: Buffer[] = []; let size = 0;
          res.on('error', reject);
          res.on('data', (chunk: Buffer) => {
            size += chunk.length; bytes += chunk.length;
            if (size > maxResponseBytes || bytes > (options.maxBytes ?? 16_000_000)) { res.destroy(new Error('Discovery byte budget exhausted')); return; }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject); req.end();
      });
      if (result.status >= 300 && result.status < 400 && result.headers.location) {
        const next = new URL(result.headers.location, url);
        if (!result.headers.location.includes('#')) next.hash = url.hash;
        url = discoveryUrl(next.href, publisher); continue;
      }
      if (result.status < 200 || result.status >= 300) throw new Error(`Discovery HTTP ${result.status}`);
      if (result.headers['content-disposition']?.toLowerCase().includes('attachment') || (result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity')) throw new Error('Discovery download or encoded response denied');
      const contentType = result.headers['content-type'] ?? '';
      if (!/^(text\/(html|plain|markdown|x-markdown|css|javascript|xml)|application\/(xhtml\+xml|xml|javascript|json|markdown))$/.test(new MIMEType(contentType).essence)) throw new Error('Discovery non-text response denied');
      return { url: url.href, status: result.status, contentType, body: result.body };
    }
    throw new Error('Discovery redirect budget exhausted');
  };
}
