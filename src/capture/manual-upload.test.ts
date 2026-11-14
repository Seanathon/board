import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { eq } from 'drizzle-orm';

import { initDb } from '../db/index.js';
import { boards, assets, items } from '../db/schema.js';
import { decodeImageDataUrl, uploadAssetForItem } from './manual-upload.js';

// a 1x1 PNG (tiny, valid base64 image)
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('decodeImageDataUrl (Story 6.4)', () => {
  it('decodes a valid base64 image data URL', () => {
    const { buffer, ext } = decodeImageDataUrl(PNG_DATA_URL, 20 * 1024 * 1024);
    assert.ok(buffer.length > 0);
    assert.equal(ext, 'png');
  });

  it('rejects a non-image data URL (no write)', () => {
    assert.throws(() => decodeImageDataUrl('data:text/plain;base64,aGVsbG8=', 20 * 1024 * 1024), /image/i);
    assert.throws(() => decodeImageDataUrl('not a data url', 20 * 1024 * 1024), /image|data url/i);
  });

  it('rejects an oversized upload (no write)', () => {
    // small injected limit so we don't build a 20MB string
    assert.throws(() => decodeImageDataUrl(PNG_DATA_URL, 4), /exceeds|limit|large/i);
  });
});

describe('uploadAssetForItem (Story 6.4)', () => {
  let dir: string;
  let shotDir: string;
  let handle: ReturnType<typeof initDb>;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-upload-'));
    shotDir = join(dir, 'screenshots');
    handle = initDb(join(dir, 'u.db'));
    handle.db.insert(boards).values({ id: 'b', name: 'B', view: 'grid', descriptor: { fields: [], enrichment_prompt: '', view: 'grid', ingest_mode: 'url-screenshot' } }).run();
    handle.db.insert(items).values({ id: 'it', boardId: 'b', source: 'https://x' }).run();
  });
  after(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // AC 1/2/3 — stores the file under screenshotsDir + creates a linked asset row
  it('writes the image under screenshotsDir and creates a linked asset row', async () => {
    const path = await uploadAssetForItem(handle, { itemId: 'it', dataUrl: PNG_DATA_URL, screenshotsDir: shotDir });
    assert.match(path, /^screenshots\/it-[a-f0-9-]+\.png$/);
    assert.ok(existsSync(join(shotDir, basename(path))), 'file written under the temp screenshotsDir');

    const row = handle.db.select().from(assets).where(eq(assets.itemId, 'it')).all();
    assert.equal(row.length, 1);
    assert.equal(row[0].path, path);
    assert.ok(row[0].hash && row[0].hash.length > 0, 'asset has a content hash');
  });

  // AC 1 — item-scoped, works on a url-screenshot board (the failed-auto-capture fallback)
  it('replaces (not duplicates) the asset on a second upload', async () => {
    await uploadAssetForItem(handle, { itemId: 'it', dataUrl: PNG_DATA_URL, screenshotsDir: shotDir });
    const row = handle.db.select().from(assets).where(eq(assets.itemId, 'it')).all();
    assert.equal(row.length, 1, 'manual upload replaces the item asset, no duplicate');
  });

  // SECURITY — a traversal itemId must not escape screenshotsDir (no write)
  it('rejects a path-traversal itemId without escaping screenshotsDir', async () => {
    handle.db.insert(items).values({ id: '../../evil', boardId: 'b', source: 'x' }).run();
    const before = readdirSync(shotDir).length;
    await assert.rejects(
      () => uploadAssetForItem(handle, { itemId: '../../evil', dataUrl: PNG_DATA_URL, screenshotsDir: shotDir }),
      /invalid item id/i,
    );
    assert.equal(readdirSync(shotDir).length, before, 'no file written for a traversal id');
    assert.equal(existsSync(join(dir, 'evil.png')), false, 'must not escape screenshotsDir');
  });

  // AC 2/3 — rejection writes nothing
  it('rejects a non-image upload and writes no file', async () => {
    const before = readdirSync(shotDir).length;
    await assert.rejects(
      () => uploadAssetForItem(handle, { itemId: 'it', dataUrl: 'data:text/plain;base64,aGk=', screenshotsDir: shotDir }),
      /image/i,
    );
    assert.equal(readdirSync(shotDir).length, before, 'no file written on rejection');
  });
});
