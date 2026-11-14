import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { eq, sql } from 'drizzle-orm';

import type { DbHandle } from './index.js';
import { assets } from './schema.js';
import { enqueueWrite } from './queue.js';

// Story 16.1 — the ADDITIVE snapshot-asset write. THE load-bearing rule: never route a
// snapshot through writeItemDirect(handle, item, assetRows) — that path DELETE-then-
// INSERTs ALL of an item's assets (db/queue.ts), which would silently WIPE the item's
// existing kind='screenshot' asset. Instead the snapshot is its own single-row upsert,
// keyed on a STABLE id (`${itemId}-snapshot`) so it can never collide with the
// screenshot asset and re-archiving updates one row in place.

export interface SnapshotCapture {
  /** The self-contained HTML bytes. */
  buf: Buffer;
  /** sha256 of the bytes (for dedupe). */
  hash: string;
  /** Byte length (for the size-cap guardrail). */
  bytes: number;
}

export interface SnapshotAssetRef {
  kind: 'snapshot';
  path: string;
  hash: string;
}

export interface WriteSnapshotOpts {
  /** Absolute dir the .html is written under (relative path stored is snapshots/<id>.html). */
  snapshotsDir: string;
  /** Injectable file writer (tests spy on it to prove dedupe skips the write). */
  writeFile?: (absPath: string, buf: Buffer) => void;
}

const defaultWriteFile = (absPath: string, buf: Buffer): void => {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buf, { flag: 'wx' });
};

/** Convenience: build a SnapshotCapture from raw HTML (hashes + measures). */
export function snapshotFromHtml(html: string): SnapshotCapture {
  const buf = Buffer.from(html, 'utf8');
  return { buf, hash: createHash('sha256').update(buf).digest('hex'), bytes: buf.byteLength };
}

/**
 * The DIRECT snapshot write (dedupe-read + file write + row upsert), with NO enqueue.
 * MUST be called only from inside a job that already holds the single-writer slot (i.e.
 * runSnapshotJob's enqueueJob `run`). Calling the enqueued `writeSnapshotAsset` there
 * would DEADLOCK — the inner enqueue waits for the outer slot, which awaits the inner
 * (the same trap writeItemDirect documents in db/queue.ts). Returns `{written}`:
 *  - hash-DEDUPE: a snapshot row with the SAME hash already exists → file NOT (re)written,
 *    row NOT touched (`written:false`).
 *  - otherwise: write the .html, upsert ONLY the `${itemId}-snapshot` row (dedupe-read +
 *    upsert in ONE transaction). NEVER deletes/rewrites the item's other assets (AC6).
 */
export function writeSnapshotAssetDirect(
  handle: DbHandle,
  itemId: string,
  snapshot: SnapshotCapture,
  opts: WriteSnapshotOpts,
): { written: boolean; asset?: SnapshotAssetRef } {
  const id = `${itemId}-snapshot`;
  const filename = `${itemId}-${randomUUID()}.html`;
  const relPath = `snapshots/${filename}`; // relative form (Story 2.2), mirrors screenshots/<id>.png
  const abs = join(opts.snapshotsDir, filename);

  // Dedupe-read inside the same transaction as the upsert (no read-then-write race).
  return handle.sqlite.transaction(() => {
    const existing = handle.db.select().from(assets).where(eq(assets.id, id)).get();
    if (existing && existing.hash === snapshot.hash) {
      return { written: false }; // identical bytes already archived
    }
    (opts.writeFile ?? defaultWriteFile)(abs, snapshot.buf);
    handle.db
      .insert(assets)
      .values({ id, itemId, kind: 'snapshot', path: relPath, hash: snapshot.hash })
      .onConflictDoUpdate({
        target: assets.id,
        set: { path: relPath, hash: snapshot.hash, capturedAt: sql`(unixepoch())` },
      })
      .run();
    return { written: true, asset: { kind: 'snapshot' as const, path: relPath, hash: snapshot.hash } };
  })();
}

/**
 * Enqueued wrapper for STANDALONE callers (not already holding the worker slot). Routes
 * the direct write through the single-writer queue. runSnapshotJob must NOT use this (it
 * already holds the slot) — it calls writeSnapshotAssetDirect.
 */
export async function writeSnapshotAsset(
  handle: DbHandle,
  itemId: string,
  snapshot: SnapshotCapture,
  opts: WriteSnapshotOpts,
): Promise<{ written: boolean; asset?: SnapshotAssetRef }> {
  return enqueueWrite(() => writeSnapshotAssetDirect(handle, itemId, snapshot, opts));
}
