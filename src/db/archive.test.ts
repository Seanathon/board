import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { initDb } from './index.js';
import { boards } from './schema.js';
import { seed } from './seed.js';
import { writeItem } from './queue.js';
import { createArchiveStream, extractArchive, ARCHIVE_MANIFEST } from './archive.js';

// An export that carries only asset PATHS is not a backup: restore it on another box
// and every image 404s. The archive is the portable form — a manifest plus the actual
// image bytes — streamed rather than buffered, because a real collection here is
// ~110MB of screenshots and a base64 JSON of that size kills the browser tab.
describe('archive (tar) round trip', () => {
  let dir: string;
  let shotDir: string;
  let outDir: string;
  let handle: ReturnType<typeof initDb>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-arc-'));
    shotDir = mkdtempSync(join(tmpdir(), 'board-oss-arc-shots-'));
    outDir = mkdtempSync(join(tmpdir(), 'board-oss-arc-out-'));
    handle = initDb(join(dir, 'a.db'));
    seed(handle.db);
    handle.db.insert(boards).values({
      id: 'wishlist', name: 'Wish List', view: 'grid',
      descriptor: { name: 'Wish List', fields: [], view: 'grid', ingest_mode: 'url-screenshot' } as never,
    }).run();
    mkdirSync(shotDir, { recursive: true });
    // Deliberately not a round multiple of 512 — tar pads blocks, and an off-by-one in
    // the padding corrupts every subsequent entry rather than just this one.
    writeFileSync(join(shotDir, 'w1.png'), Buffer.alloc(1000, 7));
    await writeItem(handle, { id: 'w1', boardId: 'wishlist', source: 'https://example.com/w', title: 'W' },
      [{ id: 'w1-shot', itemId: 'w1', kind: 'screenshot', path: 'screenshots/w1.png' }]);
  });
  after(() => {
    handle.sqlite.close();
    for (const d of [dir, shotDir, outDir]) rmSync(d, { recursive: true, force: true });
  });

  it('streams a tar that standard tooling can read, then extracts it losslessly', async () => {
    const tarPath = join(outDir, 'board.tar');
    await pipeline(createArchiveStream(handle, shotDir), createWriteStream(tarPath));

    const bytes = readFileSync(tarPath);
    assert.ok(bytes.length % 512 === 0, 'a tar is a whole number of 512-byte blocks');
    assert.equal(bytes.subarray(257, 262).toString(), 'ustar', 'ustar magic makes it readable by tar(1)');

    const destShots = join(outDir, 'restored-shots');
    const { document, filesRestored } = await extractArchive(tarPath, destShots);

    assert.equal(document.version, 1);
    assert.ok(document.boards.some((b) => b.id === 'wishlist'), 'the composed board survives the archive');
    assert.equal(document.items['wishlist'].length, 1);
    assert.equal(filesRestored, 1, 'the image file is restored, not just its path');

    const restored = readFileSync(join(destShots, 'w1.png'));
    assert.equal(restored.length, 1000, 'the image is byte-exact after tar padding');
    assert.ok(restored.every((b) => b === 7), 'contents are unchanged');
  });

  it('names the manifest predictably so the archive is inspectable by hand', async () => {
    const tarPath = join(outDir, 'board2.tar');
    await pipeline(createArchiveStream(handle, shotDir), createWriteStream(tarPath));
    assert.ok(readFileSync(tarPath).subarray(0, 100).toString().startsWith(ARCHIVE_MANIFEST));
  });

  it('rejects an entry whose name escapes the destination directory', async () => {
    // A hostile archive must not be able to write outside the screenshots dir.
    const tarPath = join(outDir, 'evil.tar');
    const { buildEntry } = await import('./archive.js');
    const header = buildEntry('../../escaped.png', Buffer.from('x'));
    writeFileSync(tarPath, Buffer.concat([header, Buffer.alloc(1024)]));
    const destShots = join(outDir, 'safe-shots');
    await assert.rejects(() => extractArchive(tarPath, destShots), /manifest|escape|invalid/i);
    assert.equal(existsSync(join(outDir, '..', 'escaped.png')), false);
  });
});
