import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { fetchPublic, researchProduct, extractSource, type ResearchOptions } from './research.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const body = '<title>Fixture product</title><p>Fixture coordinates engineering work and review, with a durable work record. People decide before changes ship. </p>'.repeat(4);
async function fixture(handler: http.RequestListener, run: (options: ResearchOptions, calls: string[]) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const calls: string[] = [];
  // Only the injected test transport talks to this local HTTP fixture; production has no private-network override.
  const request = ((url: URL, options: https.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
    calls.push(url.href);
    return http.get(`http://127.0.0.1:${port}${url.pathname}`, { signal: options.signal, headers: options.headers }, callback);
  }) as typeof https.get;
  try { await run({ lookup: publicLookup, request }, calls); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
test('research: bounded current local HTTP evidence, same-origin supplement, no script execution', async () => {
  await fixture((req, res) => { res.setHeader('content-type', 'text/html'); res.end(body + (req.url === '/' ? '<a href="/pricing">Pricing</a><a href="https://evil.invalid/docs">Ignore</a><script>globalThis.RESEARCH_EXECUTED=true</script>' : '<p>Fixture costs $20 per seat.</p>')); }, async (options, calls) => {
    const records = await researchProduct('https://vendor.example/', options);
    assert.equal(records.length, 2); assert.deepEqual(calls, ['https://vendor.example/', 'https://vendor.example/pricing']);
    assert.equal(records[0].id, 'T1'); assert.equal(records[1].id, 'T2'); assert.ok(records[1].text.includes('$20'));
    assert.equal(records[0].excerptSha256, createHash('sha256').update(records[0].text).digest('hex'));
    assert.equal((globalThis as Record<string, unknown>).RESEARCH_EXECUTED, undefined);
    assert.ok(!records[0].text.includes('globalThis'));
  });
});
test('research: every redirect and every DNS address is guarded before HTTP', async () => {
  await fixture((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1/' }); res.end(); }, async (options, calls) => {
    await assert.rejects(fetchPublic('https://vendor.example/', options)); assert.equal(calls.length, 1);
    calls.length = 0;
    await assert.rejects(fetchPublic('https://vendor.example/', { ...options, lookup: async () => [...await publicLookup(), { address: '10.1.2.3', family: 4 }] }));
    await assert.rejects(fetchPublic('https://vendor.local/', options));
    await assert.rejects(fetchPublic('https://user:secret@vendor.example/', options));
    await assert.rejects(fetchPublic('https://vendor.example:8443/', options));
    assert.equal(calls.length, 0);
  });
});
test('research: redirect, encoding, MIME, response size and excerpt bounds', async () => {
  await fixture((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/redirect' }); res.end(); }
    else if (req.url === '/gzip') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); res.end('bad'); }
    else if (req.url === '/image') { res.setHeader('content-type', 'image/png'); res.end('not text'); }
    else { res.setHeader('content-type', 'text/plain'); res.end('x'.repeat(1048577)); }
  }, async (options, calls) => {
    await assert.rejects(fetchPublic('https://vendor.example/redirect', options)); assert.equal(calls.length, 6);
    for (const route of ['gzip', 'image', 'large']) await assert.rejects(fetchPublic('https://vendor.example/' + route, options));
    const parsed = extractSource(Buffer.from('<p>' + 'x'.repeat(7000) + '</p>'), 'https://vendor.example/');
    assert.equal(parsed.text.length, 6000); assert.equal(parsed.truncated, true); assert.ok(parsed.fullTextChars > 6000);
  });
});
test('research: thin page text fallback is bounded; access denials and challenges are not bypassed', async () => {
  await fixture((req, res) => {
    if (req.url === '/denied') { res.writeHead(403); res.end(); return; }
    res.setHeader('content-type', 'text/plain');
    res.end(req.url === '/llms.txt' ? body : req.url === '/challenge' ? 'Verify you are human. ' + 'a'.repeat(200) : 'thin');
  }, async (options, calls) => {
    const sources = await researchProduct('https://vendor.example/thin', options); assert.equal(sources.length, 1); assert.equal(sources[0].url, 'https://vendor.example/llms.txt'); assert.equal(calls.length, 2);
    for (const path of ['denied', 'challenge']) { const before: number = calls.length; await assert.rejects(researchProduct('https://vendor.example/' + path, options)); assert.equal(calls.length - before, 1); }
  });
});
test('research: cancellation releases a hung DNS lookup without ever requesting HTTP', async () => {
  const controller = new AbortController(); let requested = false;
  const pending = fetchPublic('https://vendor.example/', { signal: controller.signal, lookup: () => new Promise(() => {}), request: (() => { requested = true; throw new Error(); }) as typeof https.get });
  controller.abort(); await assert.rejects(pending); assert.equal(requested, false);
});

test('research: supplemental redirects cannot turn a different publisher into primary evidence', async () => {
  await fixture((req, res) => { if (req.url === '/docs') { res.writeHead(302, { location: 'https://other-publisher.example/reference' }); res.end(); } else { res.setHeader('content-type', 'text/html'); res.end(body + '<a href="/docs">Docs</a>'); } }, async (options, calls) => {
    const sources = await researchProduct('https://vendor.example/', options);
    assert.equal(sources.length, 1); assert.deepEqual(calls, ['https://vendor.example/', 'https://vendor.example/docs']);
  });
});

test('research: malformed remote redirect rejects the job instead of escaping an async callback', async () => {
  await fixture((_req, res) => { res.writeHead(302, { location: 'http://[' }); res.end(); }, async (options, calls) => {
    await assert.rejects(fetchPublic('https://vendor.example/', options), /invalid redirect/); assert.equal(calls.length, 1);
  });
});
