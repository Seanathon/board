import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { launchBrowser } from '../browser.js';
import { discoverEvidence } from './discovery.js';
import { openDiscoveryBrowser, type DiscoveryBrowser } from './discovery-browser.js';
import { createDiscoveryReader, discoveryUrl, publicAddress, DISCOVERY_LAUNCH_TIMEOUT_MS, DISCOVERY_TIME_BUDGET_MS, type DiscoveryReader } from './discovery-net.js';
import type { LLMProvider } from '../skills/types.js';
import type { BoardDescriptor } from '../descriptor/types.js';

const source = 'https://example.com/';
const descriptor: BoardDescriptor = { view: 'list', ingest_mode: 'url-readable', enrichment_prompt: 'Describe any useful detail.', fields: [{ key: 'custom', label: 'Custom', type: 'text', enrichable: true }] };
const base = { enabled: true, capturedText: '', descriptor, context: { itemId: 'item', boardId: 'board', source } };
const response = (url: string, text: string, contentType = 'text/html') => ({ url, status: 200, contentType, body: Buffer.from(text) });
const forbidden = async (): Promise<never> => { throw new Error('Must not be called'); };

// Existing navigation fakes explicitly opt through the new evidence-routing stage.
const exploreExisting = (llm: LLMProvider): LLMProvider => ({
  async complete(prompt, schema, context) {
    return prompt.startsWith('Assess existing evidence') ? schema.parse({ action: 'explore' }) : llm.complete(prompt, schema, context);
  },
});

test('OFF makes zero calls; useful captured evidence stops after one semantic decision', async () => {
  assert.deepEqual(await discoverEvidence({ ...base, enabled: false, llm: { complete: forbidden }, read: forbidden, openBrowser: forbidden }), { sources: [], errors: [] });
  let calls = 0;
  const capturedText = 'A tool for comparing research graphs. Users import documents, inspect provenance and open the Tutorial to learn navigation.';
  const llm: LLMProvider = { async complete(prompt, schema, context) {
    calls++; assert.equal(context?.purpose, 'discovery'); assert.equal(context?.itemId, base.context.itemId);
    assert(prompt.includes(descriptor.enrichment_prompt)); assert(prompt.includes(capturedText));
    assert(prompt.includes('not character count')); assert(prompt.includes('No field'));
    return schema.parse({ action: 'stop' });
  } };
  const result = await discoverEvidence({ ...base, capturedText, llm, read: forbidden, openBrowser: forbidden });
  assert.equal(calls, 1); assert.deepEqual(result.sources, [{ url: source, text: capturedText, kind: 'captured' }]); assert.equal(result.errors.length, 0);
});
test('useful static evidence stops after one semantic decision without browser exploration', async () => {
  let reads = 0, calls = 0;
  const llm: LLMProvider = { async complete(prompt, schema, context) {
    calls++; assert.equal(context?.purpose, 'discovery'); assert(prompt.includes('Readable evidence'));
    return schema.parse({ action: 'stop' });
  } };
  const result = await discoverEvidence({ ...base, llm, openBrowser: forbidden, read: async url => { reads++; return response(url, `<p>${'Readable evidence. '.repeat(60)}</p>`); } });
  assert.equal(reads, 1); assert.equal(calls, 1); assert.equal(result.sources[0].kind, 'static');
});
test('provider chooses Tutorial control then stops with attributable partial evidence', async () => {
  let clicked = false, disposed = 0, calls = 0;
  const browser: DiscoveryBrowser = {
    navigate: async () => {}, dispose: async () => { disposed++; },
    act: async id => { assert.equal(id, 'control-1'); clicked = true; },
    snapshot: async () => ({ url: source, text: clicked ? 'Tutorial explains useful custom details' : 'Thin shell', candidates: [{ id: 'control-1', label: 'Tutorial' }] }),
  };
  const llm: LLMProvider = { async complete(_prompt, schema, context) {
    assert.equal(context?.purpose, 'discovery'); calls++;
    return schema.parse({ action: clicked ? 'stop' : 'click', candidateId: clicked ? '' : 'control-1' });
  } };
  const result = await discoverEvidence({ ...base, llm: exploreExisting(llm), read: async url => response(url, '<html>Thin</html>'), openBrowser: async () => browser });
  assert.equal(calls, 2); assert.equal(disposed, 1); assert(result.sources.some(s => s.text.includes('Tutorial explains')));
});
test('sitemap candidates are provider selected, not crawled automatically', async () => {
  let url = source; const visits: string[] = [];
  const browser: DiscoveryBrowser = { dispose: async () => {}, navigate: async next => { visits.push(next); url = next; }, act: forbidden,
    snapshot: async () => ({ url, text: url.endsWith('/guide') ? 'Guide evidence' : 'Shell', candidates: [] }) };
  const llm: LLMProvider = { async complete(prompt, schema) {
    assert(prompt.includes('Sitemap page')); assert(!prompt.includes('https://other.example/'));
    return schema.parse({ action: 'open', candidateId: 'link-0' });
  } };
  const result = await discoverEvidence({ ...base, llm: exploreExisting(llm), openBrowser: async () => browser, read: async url => response(url, url.endsWith('.xml') ? '<urlset><url><loc>https://example.com/guide</loc></url><url><loc>https://other.example/</loc></url></urlset>' : '<body>Shell</body>') });
  assert.deepEqual(visits, [source, source + 'guide']); assert(result.sources.some(s => s.url === source + 'guide'));
});
test('action, text and decision budgets are finite; unknown actions cannot execute', async () => {
  let acts = 0, calls = 0, disposed = 0;
  const browser: DiscoveryBrowser = { navigate: async () => {}, dispose: async () => { disposed++; }, act: async () => { acts++; }, snapshot: async () => ({ url: source, text: 'Shell', candidates: [{ id: 'control-1', label: 'Tutorial' }] }) };
  const llm: LLMProvider = { async complete(_p, schema) { calls++; return schema.parse({ action: 'click', candidateId: 'control-1' }); } };
  await discoverEvidence({ ...base, llm, read: forbidden, openBrowser: async () => browser });
  assert.equal(acts, 4); assert.equal(calls, 4); assert.equal(disposed, 1);
  const invalid: LLMProvider = { async complete(_p, schema) { return schema.parse({ action: 'click', candidateId: 'not-a-candidate' }); } };
  const result = await discoverEvidence({ ...base, llm: invalid, read: forbidden, openBrowser: async () => browser });
  assert.match(result.errors.join(), /Invalid discovery action/); assert.equal(acts, 4);
});
test('abort waits for decision transport disposal and browser disposal', async () => {
  const controller = new AbortController(); let entered!: () => void, release!: () => void;
  const entry = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  let disposed = false, finished = false;
  const llm: LLMProvider = { async complete(_p, _s, ctx) { entered(); await new Promise<void>(r => ctx!.signal!.addEventListener('abort', () => r(), { once: true })); await gate; throw new Error('Aborted'); } };
  const work = discoverEvidence({ ...base, context: { ...base.context, signal: controller.signal }, llm, read: forbidden, openBrowser: async () => ({ navigate: async () => {}, act: forbidden, dispose: async () => { disposed = true; }, snapshot: async () => ({ url: source, text: '', candidates: [{ id: 'control-1', label: 'Tutorial' }] }) }) });
  const rejected = assert.rejects(work).then(() => { finished = true; });
  await entry; controller.abort(); await new Promise(r => setImmediate(r));
  assert.equal(disposed, true); assert.equal(finished, false); release(); await rejected;
});
test('deadline preserves explicit error and disposes the browser', async () => {
  let disposed = false;
  const result = await discoverEvidence({ ...base, timeoutMs: 20, llm: { complete: forbidden }, read: forbidden, openBrowser: async () => ({ navigate: async () => {}, act: forbidden, dispose: async () => { disposed = true; }, snapshot: () => new Promise(() => {}) }) });
  assert.equal(disposed, true); assert.match(result.errors.join(), /time budget/);
});
test('discovery rejects private, reserved, mapped and mixed-address DNS and unsafe destinations', async () => {
  for (const ip of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '0.0.0.0', '224.0.0.1', '198.18.1.1', '192.0.2.1', '::1', '::ffff:7f00:1', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('93.184.216.34'), true); assert.equal(publicAddress('2606:4700::1111'), true);
  for (const url of ['file:///etc/passwd', 'https://u:p@example.com/', 'https://other.example/', 'https://example.com/logout', 'https://example.com/download', 'https://example.com/?action=delete']) assert.throws(() => discoveryUrl(url, source));
  for (const lookup of [async () => [], async () => { throw new Error('DNS failure'); }, async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]]) {
    const read = createDiscoveryReader(source, new AbortController().signal, { lookup, request: (() => { throw new Error('NETWORK MUST NOT RUN'); }) as never });
    await assert.rejects(read(source), /DNS/);
  }
});
test('connection lookup is pinned and redirects are rechecked before network', async () => {
  let requests = 0, lookups = 0;
  const request = ((_url: URL, options: any, callback: Function) => {
    requests++;
    options.lookup('example.com', { all: true }, (err: unknown, addresses: unknown) => { assert.equal(err, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]); });
    const req = new EventEmitter() as any;
    req.end = () => {
      const res = Readable.from([Buffer.from('redirect')]) as any;
      res.statusCode = 302; res.headers = { location: 'https://127.0.0.1/' };
      callback(res);
    }; return req;
  }) as typeof http.request;
  const read = createDiscoveryReader(source, new AbortController().signal, { lookup: async () => { lookups++; return [{ address: '93.184.216.34', family: 4 }]; }, request });
  await assert.rejects(read(source), /Unsafe/); assert.equal(requests, 1); assert.equal(lookups, 1);
});
test('network request and byte budgets fail closed', async () => {
  const read = createDiscoveryReader(source, new AbortController().signal, { maxRequests: 0, lookup: forbidden });
  await assert.rejects(read(source), /request budget/);
  const request = ((_url: URL, _options: unknown, callback: Function) => {
    const req = new EventEmitter() as any;
    req.end = () => { const res = Readable.from([Buffer.alloc(50)]) as any; res.statusCode = 200; res.headers = { 'content-type': 'text/html' }; callback(res); }; return req;
  }) as typeof http.request;
  await assert.rejects(createDiscoveryReader(source, new AbortController().signal, { maxBytes: 10, lookup: async () => [{ address: '93.184.216.34', family: 4 }], request })(source), /byte budget/);
});

test('real browser reads Tutorial modal behind a >12k graph body, then sitemap docs, with unsafe egress blocked', { timeout: DISCOVERY_LAUNCH_TIMEOUT_MS + 40_000 }, async () => {
  let forbiddenHits = 0;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/forbidden') forbiddenHits++;
    res.setHeader('content-type', 'text/html');
    if (req.url === '/guide') { res.end('<p>Guide explains an arbitrary custom detail.</p>'); return; }
    res.end(`<a href="#tutorial" id="tutorial">Tutorial</a><form><button>Submit</button></form><a download href="/file">Download</a><button type="button">Delete</button><div id="background">${'Graph node Demo label Menu example. '.repeat(600)}</div><div id="modal" role="dialog" aria-modal="true" hidden></div><script>
      document.querySelector('#tutorial').onclick = () => { document.querySelector('#modal').hidden = false; document.querySelector('#modal').textContent = 'Tutorial reveals the dynamically rendered details.'; };
      fetch('http://127.0.0.1:${(fixture.address() as { port: number }).port}/forbidden').catch(()=>{});
      fetch('/forbidden',{method:'POST'}).catch(()=>{});
      try { new WebSocket('ws://127.0.0.1:${(fixture.address() as { port: number }).port}/forbidden'); } catch {}
      window.open('http://127.0.0.1:${(fixture.address() as { port: number }).port}/forbidden');
      try { new Worker('/forbidden'); } catch {}
      </script>`);
  });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const read: DiscoveryReader = async url => {
    assert.equal(new URL(url).hostname, 'example.com');
    if (url.endsWith('/sitemap.xml')) return response(url, '<urlset><url><loc>https://example.com/guide</loc></url></urlset>', 'application/xml');
    if (url.endsWith('/forbidden')) { forbiddenHits++; throw new Error('unsafe read'); }
    // Test transport only: the production reader has no localhost exemption.
    const body = await fetch(origin + new URL(url).pathname).then(r => r.text());
    return response(url, body);
  };
  let calls = 0;
  const llm: LLMProvider = { async complete(prompt, schema) {
    calls++;
    if (calls === 1) {
      const candidates = JSON.parse(prompt.split('\nCandidates: ')[1]);
      assert(!candidates.some((c: any) => /Submit|Delete|Download/.test(c.label)));
      return schema.parse({ action: 'click', candidateId: candidates.find((c: any) => c.label === 'Tutorial').id });
    }
    assert(prompt.includes('Tutorial reveals the dynamically rendered details.'));
    const candidates = JSON.parse(prompt.split('\nCandidates: ')[1]);
    const guide = candidates.find((c: any) => c.url === source + 'guide');
    return schema.parse({ action: guide ? 'open' : 'stop', candidateId: guide?.id ?? '' });
  } };
  try {
    const evidence = await discoverEvidence({ ...base, capturedText: 'Graph node Demo label Menu example. '.repeat(300), llm: exploreExisting(llm), read, openBrowser: args => openDiscoveryBrowser({ ...args, launch: async extraArgs => {
      const browser = await launchBrowser({ extraArgs, timeoutMs: DISCOVERY_LAUNCH_TIMEOUT_MS });
      try {
        // An un-intercepted target must not bypass the proxy, even for loopback.
        const rogue = await browser.newPage();
        assert.equal((await rogue.goto(origin + '/forbidden', { timeout: 2000 }))?.status(), 403);
        assert.equal(forbiddenHits, 0);
        await rogue.close();
        return browser;
      } catch (err) { await browser.close(); throw err; }
    } }) });
    assert(evidence.sources.some(s => s.kind === 'browser' && s.text.includes('Tutorial reveals')), JSON.stringify({ errors: evidence.errors, sources: evidence.sources.map(s => ({ url: s.url, kind: s.kind, text: s.text.slice(0, 100), length: s.text.length })) }));
    assert(evidence.sources.some(s => s.url.endsWith('/guide') && s.text.includes('arbitrary custom')));
    assert.equal(forbiddenHits, 0);
    assert(evidence.sources.reduce((sum, s) => sum + s.text.length, 0) <= 24_000);
  } finally { fixture.closeAllConnections(); await new Promise<void>(r => fixture.close(() => r())); }
});

test('plain quick evidence avoids browser and a sitemap index follows only one checked child', async () => {
  const result = await discoverEvidence({ ...base, llm: { async complete(prompt, schema) { return schema.parse({ action: prompt.includes('Useful quick evidence.') ? 'stop' : 'explore' }); } }, openBrowser: forbidden,
    read: async url => response(url, url.endsWith('/llms.txt') ? 'Useful quick evidence. '.repeat(50) : '<p>Thin</p>', url.endsWith('/llms.txt') ? 'text/plain' : 'text/html') });
  assert(result.sources.some(s => s.url.endsWith('/llms.txt')));
  const reads: string[] = [];
  const indexed = await discoverEvidence({ ...base, llm: { async complete(prompt, schema) { if (prompt.startsWith('Assess existing evidence')) return schema.parse({ action: 'explore' }); assert(prompt.includes('https://example.com/documentation')); return schema.parse({ action: 'stop', candidateId: '' }); } },
    read: async url => {
      reads.push(url);
      return response(url, url.endsWith('/sitemap.xml') ? '<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap><sitemap><loc>https://other.example/unsafe.xml</loc></sitemap></sitemapindex>' : url.endsWith('/pages.xml') ? '<urlset><url><loc>https://example.com/documentation</loc></url></urlset>' : '<p>Thin</p>');
    },
    openBrowser: async () => ({ navigate: async () => {}, dispose: async () => {}, act: forbidden, snapshot: async () => ({ url: source, text: 'Shell', candidates: [] }) }),
  });
  assert(reads.includes(source + 'pages.xml')); assert(!reads.some(url => url.includes('other.example'))); assert.equal(indexed.errors.length, 0);
});

test('clear access challenges return explicit errors without browser interaction', async () => {
  const result = await discoverEvidence({ ...base, llm: { complete: forbidden }, openBrowser: forbidden, read: async url => response(url, '<p>Verify you are human</p>') });
  assert.match(result.errors.join(), /challenge page; not bypassed/); assert.equal(result.sources.length, 0);
});

test('semantic checks share the overall deadline and do not start network work after timeout', async () => {
  let calls = 0;
  const llm: LLMProvider = { async complete(_prompt, _schema, context) {
    calls++;
    await new Promise<void>(resolve => context!.signal!.addEventListener('abort', () => resolve(), { once: true }));
    context!.signal!.throwIfAborted(); throw new Error('Unreachable');
  } };
  const result = await discoverEvidence({ ...base, capturedText: 'Graph labels. '.repeat(800), timeoutMs: 20, llm, read: forbidden, openBrowser: forbidden });
  assert.equal(calls, 1); assert.match(result.errors.join(), /time budget/);
});

test('parent abort during sufficiency waits for the scoped transport to finish disposing', async () => {
  const controller = new AbortController(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  const llm: LLMProvider = { async complete(_prompt, _schema, context) {
    enter(); await new Promise<void>(resolve => context!.signal!.addEventListener('abort', () => resolve(), { once: true }));
    await gate; throw new Error('Aborted after disposal');
  } };
  const result = assert.rejects(discoverEvidence({ ...base, capturedText: 'Potential evidence', context: { ...base.context, signal: controller.signal }, llm, read: forbidden, openBrowser: forbidden })).then(() => { finished = true; });
  await entered; controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); release(); await result;
});

test('semantic checks add at most three decisions to the four bounded navigation actions', async () => {
  let assessments = 0, actions = 0;
  const llm: LLMProvider = { async complete(prompt, schema) {
    if (prompt.startsWith('Assess existing evidence')) { assessments++; return schema.parse({ action: 'explore' }); }
    return schema.parse({ action: 'click', candidateId: 'control-1' });
  } };
  const evidence = await discoverEvidence({ ...base, capturedText: 'Captured shell', llm,
    read: async url => response(url, url.endsWith('.xml') ? '<urlset/>' : url.endsWith('/llms.txt') ? 'Quick shell' : '<p>Static shell</p>', url.endsWith('/llms.txt') ? 'text/plain' : 'text/html'),
    openBrowser: async () => ({ navigate: async () => {}, dispose: async () => {}, act: async () => { actions++; }, snapshot: async () => ({ url: source, text: 'Browser shell', candidates: [{ id: 'control-1', label: 'Tutorial' }] }) }),
  });
  assert.equal(assessments, 3); assert.equal(actions, 4); assert(evidence.sources.reduce((sum, s) => sum + s.text.length, 0) <= 24_000);
});

test('hash routes survive candidate validation and redirects but never enter HTTP request targets', async () => {
  const routed = source + '#/research';
  assert.equal(discoveryUrl(routed, source).href, routed);
  assert.equal(discoveryUrl('#/tutorial', routed).href, source + '#/tutorial');
  assert.throws(() => discoveryUrl('#/logout', source), /Unsafe/);
  let requests = 0;
  const request = ((url: URL, _options: unknown, callback: Function) => {
    assert.equal(url.hash, ''); requests++;
    const req = new EventEmitter() as any;
    req.end = () => {
      const res = Readable.from([Buffer.from('route')]) as any;
      res.statusCode = requests === 1 ? 302 : 200;
      res.headers = requests === 1 ? { location: '/app' } : { 'content-type': 'text/html; charset=utf-8' };
      callback(res);
    }; return req;
  }) as typeof http.request;
  const read = createDiscoveryReader(source, new AbortController().signal, { lookup: async () => [{ address: '93.184.216.34', family: 4 }], request });
  const result = await read(routed);
  assert.equal(result.url, source + 'app#/research'); assert.equal(requests, 2);
});

test('HTTP charset is preserved and static HTML bytes honour charset and meta sniffing', async () => {
  for (const contentType of ['text/html; charset=windows-1252', 'text/html']) {
    const bytes = Buffer.from('<meta charset="windows-1252"><p>Café résumé documentation.</p>', 'latin1');
    const request = ((_url: URL, _options: unknown, callback: Function) => {
      const req = new EventEmitter() as any;
      req.end = () => { const res = Readable.from([bytes]) as any; res.statusCode = 200; res.headers = { 'content-type': contentType }; callback(res); }; return req;
    }) as typeof http.request;
    const read = createDiscoveryReader(source, new AbortController().signal, { lookup: async () => [{ address: '93.184.216.34', family: 4 }], request });
    assert.equal((await read(source)).contentType, contentType);
    let calls = 0;
    const evidence = await discoverEvidence({ ...base, read, openBrowser: forbidden, llm: { async complete(prompt, schema) {
      calls++; assert(prompt.includes('Café résumé documentation.')); return schema.parse({ action: 'stop' });
    } } });
    assert.equal(calls, 1); assert.equal(evidence.sources[0].text, 'Café résumé documentation.'); assert.deepEqual(evidence.errors, []);
  }
});

test('quick text accepts MIME parameters and decodes its advertised character encoding', async () => {
  let calls = 0;
  const evidence = await discoverEvidence({ ...base, openBrowser: forbidden,
    read: async url => url.endsWith('/llms.txt') ? { url, status: 200, contentType: 'text/plain; charset="windows-1252"', body: Buffer.from('Crème brûlée product documentation.', 'latin1') } : response(url, '<p>Shell</p>'),
    llm: { async complete(prompt, schema) { calls++; return schema.parse({ action: prompt.includes('Crème brûlée') ? 'stop' : 'explore' }); } },
  });
  assert.equal(calls, 2); assert(evidence.sources.some(s => s.text === 'Crème brûlée product documentation.')); assert.deepEqual(evidence.errors, []);
});

test('real browser preserves saved hash route and charset while reading the active Tutorial tab panel', { timeout: 20_000 }, async () => {
  const routed = source + '#/research';
  const html = Buffer.from(`<div>${'Long graph background. '.repeat(700)}</div><div id="controls"></div><div role="tabpanel" hidden>Hidden stale panel</div><div id="docs" role="tabpanel" hidden></div><script>
    if (location.hash === '#/research') {
      document.querySelector('#controls').innerHTML = '<button type="button" id="tutorial">Tutorial</button>';
      document.querySelector('#tutorial').onclick = () => { document.querySelector('#docs').hidden = false; document.querySelector('#docs').textContent = 'Café résumé documentation.'; };
    } else { document.querySelector('#controls').textContent = 'Wrong homepage'; }
  </script>`, 'latin1');
  let clicks = 0;
  const llm: LLMProvider = exploreExisting({ async complete(prompt, schema) {
    assert(prompt.includes(`Current page: ${routed}`));
    if (prompt.includes('Café résumé documentation.')) return schema.parse({ action: 'stop', candidateId: '' });
    const tutorial = JSON.parse(prompt.split('\nCandidates: ')[1]).find((c: any) => c.label === 'Tutorial');
    assert(tutorial, 'Saved hash route must expose the Tutorial control'); clicks++;
    return schema.parse({ action: 'click', candidateId: tutorial.id });
  } });
  const evidence = await discoverEvidence({ ...base, context: { ...base.context, source: routed }, llm,
    read: async url => url.endsWith('.xml') ? response(url, '<urlset/>', 'application/xml') : { url, status: 200, contentType: 'text/html; charset=windows-1252', body: html },
  });
  assert.equal(clicks, 1);
  assert(evidence.sources.some(s => s.kind === 'browser' && s.url === routed && s.text === 'Café résumé documentation.'), JSON.stringify(evidence.errors));
  assert(evidence.sources.reduce((sum, s) => sum + s.text.length, 0) <= 24_000);
});


test('SPA bundles have a bounded asset allowance without relaxing document or total byte limits', async () => {
  for (const [type, size, allowed, maxBytes] of [
    ['application/javascript; charset=utf-8', 2_100_000, true, undefined],
    ['application/javascript', 4_000_001, false, undefined],
    ['text/html', 1_000_001, false, undefined],
    ['application/javascript', 2_100_000, false, 1_000_000],
  ] as const) {
    const request = ((_url: URL, _options: unknown, callback: Function) => {
      const req = new EventEmitter() as any;
      req.end = () => { const res = Readable.from([Buffer.alloc(size)]) as any; res.statusCode = 200; res.headers = { 'content-type': type }; callback(res); };
      return req;
    }) as typeof http.request;
    const work = createDiscoveryReader(source, new AbortController().signal, { maxBytes, request, lookup: async () => [{ address: '93.184.216.34', family: 4 }] })(source);
    if (allowed) assert.equal((await work).body.length, size);
    else await assert.rejects(work, /byte budget/);
  }
});


test('first-party documentation subdomains are permitted without admitting siblings or lookalike publishers', () => {
  const publisher = 'https://product.example.com/';
  assert.equal(discoveryUrl('https://docs.product.example.com/tutorial', publisher).hostname, 'docs.product.example.com');
  for (const destination of ['https://docs.example.com/', 'https://product.example.com.attacker.invalid/', 'https://otherexample.com/', 'https://product.example.com/signup', 'https://product.example.com/register']) assert.throws(() => discoveryUrl(destination, publisher));
});


test('real browser follows first-party new-tab Tutorial links and reads inline Markdown without downloads', { timeout: 20_000 }, async () => {
  const publisher = 'https://example.com/', target = 'https://docs.example.com/tutorial';
  const browser = await openDiscoveryBrowser({ publisher, signal: AbortSignal.timeout(15_000), errors: [], read: async url => {
    if (url === publisher) return response(url, '<a href="https://docs.example.com/tutorial" target="_blank" onclick="event.preventDefault();window.open(this.href)">Tutorial</a>');
    assert.equal(url, target);
    return response(url, '# What is this product?\n\nDocumentation explains the workflow.', 'text/markdown; charset=utf-8');
  }});
  try {
    await browser.navigate(publisher);
    const first = await browser.snapshot(), link = first.candidates.find(c => c.label === 'Tutorial'); assert(link);
    await browser.act(link.id);
    const docs = await browser.snapshot();
    assert.equal(docs.url, target);
    assert(docs.text.includes('Documentation explains the workflow.'));
  } finally { await browser.dispose(); }
});

test('the browser launch timeout leaves most of the discovery budget for the actual discovery', () => {
  // A cold Chromium start flaked at 10s on CI, so the launch limit was raised; it must not
  // grow so far that a slow launch could consume the whole budget.
  assert(DISCOVERY_LAUNCH_TIMEOUT_MS >= 15_000, 'too tight for a cold start on a loaded host');
  assert(DISCOVERY_LAUNCH_TIMEOUT_MS <= DISCOVERY_TIME_BUDGET_MS / 2, 'a slow launch could eat the whole discovery budget');
});
