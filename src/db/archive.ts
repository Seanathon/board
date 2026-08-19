import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { exportJson, type ExportDocument } from './export.js';
import { assets } from './schema.js';
import type { DbHandle } from './index.js';

// The portable form of a collection: a plain ustar tar holding a JSON manifest plus
// the actual screenshot bytes.
//
// Why tar, and why streamed. `exportJson` carries asset PATHS, so restoring it on
// another machine leaves every image 404ing — an export that is not a backup. Bundling
// the bytes as base64 inside the JSON was the obvious alternative and is unusable at
// real size: ~110MB of screenshots inflates past 140MB, which the browser must build
// as one string and JSON.parse back. Tar is a 512-byte-block format simple enough to
// emit without a dependency, streams in constant memory, and opens natively with
// tar(1) and Finder, so a user can verify their own backup without this app.

export const ARCHIVE_MANIFEST = 'manifest.json';
const BLOCK = 512;
const ASSET_PREFIX = 'screenshots/';

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** One ustar header block. Names are kept short by construction (see ASSET_PREFIX). */
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 8);
  h.write(octal(0, 8), 108, 8);       // uid
  h.write(octal(0, 8), 116, 8);       // gid
  h.write(octal(size, 12), 124, 12);
  // mtime is fixed: a byte-identical collection should produce a byte-identical
  // archive, so two backups can be compared with a checksum.
  h.write(octal(0, 12), 136, 12);
  h.write('        ', 148, 8);        // checksum field is spaces while summing
  h.write('0', 156, 1);               // typeflag: regular file
  h.write('ustar\0', 257, 6);
  h.write('00', 263, 2);

  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** Zero padding that rounds a payload up to the next 512-byte block. */
function padding(size: number): Buffer {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

/** header + content + padding for one entry. Exported for tests. */
export function buildEntry(name: string, content: Buffer): Buffer {
  return Buffer.concat([tarHeader(name, content.length), content, padding(content.length)]);
}

/**
 * Stream the whole collection as a tar. Image files are read one at a time and yielded
 * immediately, so peak memory is one screenshot rather than the whole archive.
 */
export function createArchiveStream(handle: DbHandle, screenshotsDir: string): Readable {
  const document = exportJson(handle);
  const assetRows = handle.db.select().from(assets).all();

  async function* blocks(): AsyncGenerator<Buffer> {
    yield buildEntry(ARCHIVE_MANIFEST, Buffer.from(JSON.stringify(document, null, 2), 'utf8'));

    const seen = new Set<string>();
    for (const a of assetRows) {
      if (!a.path) continue;
      const base = path.basename(a.path);
      if (seen.has(base)) continue;          // one file per basename, however many rows point at it
      seen.add(base);
      const abs = path.join(screenshotsDir, base);
      let content: Buffer;
      try {
        content = await fs.promises.readFile(abs);
      } catch {
        continue;                            // a missing image must not abort the backup
      }
      yield buildEntry(ASSET_PREFIX + base, content);
    }

    yield Buffer.alloc(BLOCK * 2);           // two zero blocks terminate a tar
  }

  return Readable.from(blocks());
}

export interface ExtractResult {
  document: ExportDocument;
  filesRestored: number;
}

/**
 * Read an archive from disk, writing its images into `destDir` and returning the
 * manifest. Entries are read sequentially through a small window rather than loading
 * the file, so a multi-hundred-MB restore does not depend on heap size.
 */
export async function extractArchive(tarPath: string, destDir: string): Promise<ExtractResult> {
  const fd = await fs.promises.open(tarPath, 'r');
  let document: ExportDocument | undefined;
  let filesRestored = 0;

  try {
    fs.mkdirSync(destDir, { recursive: true });
    const header = Buffer.alloc(BLOCK);
    let offset = 0;

    for (;;) {
      const { bytesRead } = await fd.read(header, 0, BLOCK, offset);
      if (bytesRead < BLOCK) break;
      offset += BLOCK;
      if (header[0] === 0) break;                       // terminating zero block

      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const sizeRaw = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
      const size = parseInt(sizeRaw, 8) || 0;

      const content = Buffer.alloc(size);
      if (size > 0) await fd.read(content, 0, size, offset);
      offset += Math.ceil(size / BLOCK) * BLOCK;

      if (name === ARCHIVE_MANIFEST) {
        document = JSON.parse(content.toString('utf8')) as ExportDocument;
        continue;
      }
      if (!name.startsWith(ASSET_PREFIX)) continue;

      // Never trust a name from an archive someone else produced: resolve by basename
      // and verify containment, so "../../" can't reach outside destDir.
      const base = path.basename(name.slice(ASSET_PREFIX.length));
      if (!base || base === '.' || base === '..') continue;
      const abs = path.join(destDir, base);
      const resolved = path.resolve(abs);
      if (!resolved.startsWith(path.resolve(destDir) + path.sep)) {
        throw new Error(`Refusing to extract "${name}": path escapes the destination directory.`);
      }
      await fs.promises.writeFile(abs, content);
      filesRestored += 1;
    }
  } finally {
    await fd.close();
  }

  if (!document) throw new Error(`Archive is missing its ${ARCHIVE_MANIFEST} — not a Board archive.`);
  return { document, filesRestored };
}
