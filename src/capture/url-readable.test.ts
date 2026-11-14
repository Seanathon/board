import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createUrlReadableAdapter } from './url-readable.js';

const LONG = 'This is a substantial paragraph of article content that easily clears the useful-text threshold. '.repeat(6);
const ARTICLE_HTML = `<!doctype html><html><head><title>Great Article</title></head><body>
  <article><h1>Great Article</h1><p>${LONG}</p><p>${LONG}</p></article></body></html>`;
const THIN_SHELL = '<!doctype html><html><head><title>SPA</title></head><body><div id="root"></div></body></html>';

const fakeFetch = (html: string) => (async () => ({ text: async () => html })) as unknown as typeof fetch;

describe('url-readable adapter (Story 6.3)', () => {
  // AC 1 — readable markdown from an article URL via plain fetch (no browser)
  it('extracts markdown (title + content) from an article URL', async () => {
    const adapter = createUrlReadableAdapter({ fetchImpl: fakeFetch(ARTICLE_HTML) });
    const out = await adapter.fetch('https://blog.example/post', { itemId: 'r1', boardId: 'b' });
    assert.equal(out.fields.title, 'Great Article');
    assert.match(String(out.fields.text), /substantial paragraph/);
    assert.equal(out.fields.url, 'https://blog.example/post');
    assert.deepEqual(out.assets, []); // Library captures no screenshot
  });

  // AC 2 — SPA fallback: thin shell → headless render keeps the longer result
  it('falls back to a headless render when the fetched text is too thin', async () => {
    let rendered = false;
    const adapter = createUrlReadableAdapter({
      fetchImpl: fakeFetch(THIN_SHELL),
      renderImpl: async () => {
        rendered = true;
        return LONG + LONG;
      },
    });
    const out = await adapter.fetch('https://spa.example', { itemId: 'r2', boardId: 'b' });
    assert.equal(rendered, true, 'render fallback must run for a thin shell');
    assert.match(String(out.fields.text), /substantial paragraph/);
  });

  // AC 3 — no readable text even after fallback → clear error
  it('throws a clear "no readable text" error when nothing extracts', async () => {
    const adapter = createUrlReadableAdapter({
      fetchImpl: fakeFetch(THIN_SHELL),
      renderImpl: async () => '', // render also yields nothing
    });
    await assert.rejects(
      () => adapter.fetch('https://empty.example', { itemId: 'r3', boardId: 'b' }),
      /no readable text/i,
    );
  });

  it('declares ingest_mode = url-readable and rejects a non-URL source', async () => {
    const adapter = createUrlReadableAdapter({ fetchImpl: fakeFetch(ARTICLE_HTML) });
    assert.equal(adapter.ingestMode, 'url-readable');
    await assert.rejects(() => adapter.fetch({ buffer: Buffer.from('x') }, { itemId: 'x', boardId: 'b' }), /URL/i);
  });
});

// --- og:image hero-image download (screenshot-less captures get a picture) ---

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const HTML_WITH_OG = `<!doctype html><html><head><title>Edifier R1280T</title>
  <meta property="og:image" content="https://cdn.example/r1280t.jpg"></head>
  <body><article><h1>Edifier R1280T</h1><p>${LONG}</p><p>${LONG}</p></article></body></html>`;

// Fetch that serves the page HTML for any non-image URL and an injected response for the image.
function urlAwareFetch(pageHtml: string, imageResp: unknown): typeof fetch {
  return (async (u: unknown) => {
    if (String(u).includes('cdn.example')) return imageResp;
    return { text: async () => pageHtml };
  }) as unknown as typeof fetch;
}
const imageResponse = (contentType: string, bytes = [1, 2, 3, 4]) => ({
  ok: true,
  headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

describe('url-readable adapter — og:image hero image', () => {
  it('downloads og:image as an image asset and writes the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-'));
    try {
      const adapter = createUrlReadableAdapter({
        fetchImpl: urlAwareFetch(HTML_WITH_OG, imageResponse('image/jpeg')),
        assertUrl: async () => {}, // skip real DNS for cdn.example
      });
      const out = await adapter.fetch('https://shop.example/r1280t', { itemId: 'w1', boardId: 'b', screenshotsDir: dir });
      assert.equal(out.assets.length, 1, 'one image asset emitted');
      assert.equal(out.assets[0].kind, 'image');
      assert.match(out.assets[0].path!, /^screenshots\/w1-og-[a-f0-9-]+\.jpg$/);
      assert.ok(existsSync(join(dir, basename(out.assets[0].path!))), 'image file written to screenshotsDir');
      assert.match(String(out.fields.text), /Edifier R1280T/, 'text capture still succeeds');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a blocked image URL (SSRF) but the capture still succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-'));
    try {
      const adapter = createUrlReadableAdapter({
        fetchImpl: urlAwareFetch(HTML_WITH_OG, imageResponse('image/jpeg')),
        assertUrl: async () => { throw new Error('blocked'); },
      });
      const out = await adapter.fetch('https://shop.example/r1280t', { itemId: 'w2', boardId: 'b', screenshotsDir: dir });
      assert.deepEqual(out.assets, [], 'no asset when the image URL is blocked');
      assert.match(String(out.fields.text), /Edifier R1280T/, 'text capture unaffected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a non-image content-type (honest fallback, no asset)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-'));
    try {
      const adapter = createUrlReadableAdapter({
        fetchImpl: urlAwareFetch(HTML_WITH_OG, imageResponse('text/html')),
        assertUrl: async () => {},
      });
      const out = await adapter.fetch('https://shop.example/r1280t', { itemId: 'w3', boardId: 'b', screenshotsDir: dir });
      assert.deepEqual(out.assets, [], 'no asset when the response is not an image');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
