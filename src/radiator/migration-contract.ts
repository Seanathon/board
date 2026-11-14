import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type { Item, Asset } from '../db/schema.js';
import { toRecord } from '../db/export.js';
import { digest } from './profile.js';
import { RADIATOR_BOARD_ID } from './contract.js';

export interface MigrationAsset {
  id: string; itemId: string; kind: string; path: string; hash: string | null;
  width: number | null; height: number | null; fileSha256: string;
}
export interface PreparedMigrationItem {
  id: string; source: string; disposition: 'eligible' | 'retained'; retentionReason?: 'blocked-evidence' | 'invalid-output';
  expectedRecord: Record<string, unknown>; expectedRecordSha256: string;
  expectedAssets: MigrationAsset[];
  deleteKeys: string[]; setFields: Record<string, unknown>;
}
export interface PreparedMigration {
  format: 'board-radiator-prepared-migration/1'; runId: string; inputSha256: string;
  boardId: typeof RADIATOR_BOARD_ID; expectedBoard: { id: string; name: string; view: string; descriptor: unknown };
  expectedBoardSha256: string; items: PreparedMigrationItem[];
  fingerprints: { selection: string; bundle: string; baseline: string; schema: string; archive: string; assetManifest?: string };
}
const INCIDENTAL = new Set(['status', 'error_reason', 'added', 'analysis_agent', 'analysis_model', 'queuePosition']);
/** Reuse the incumbent export projection, excluding only non-curation/derived lifecycle metadata. */
export function comparableMigrationRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !INCIDENTAL.has(key)));
}
export function currentMigrationRecord(item: Item, itemAssets: Asset[]): Record<string, unknown> {
  return comparableMigrationRecord({ ...toRecord(item, itemAssets), id: item.id, url: item.source ?? null, title: item.title ?? null, notes: item.notes ?? null, favorite: !!item.favorite });
}
export const migrationRecordSha256 = (record: Record<string, unknown>): string => digest(comparableMigrationRecord(record));
export function migrationAssetShape(asset: Pick<Asset, 'id' | 'itemId' | 'kind' | 'path' | 'hash' | 'width' | 'height'>) {
  return { id: asset.id, itemId: asset.itemId, kind: asset.kind, path: asset.path, hash: asset.hash ?? null, width: asset.width ?? null, height: asset.height ?? null };
}
export function migrationAssetFileSha256(dataDir: string, relative: string): string {
  const root = realpathSync(dataDir); const file = path.resolve(root, relative);
  assert(relative && !path.isAbsolute(relative) && file.startsWith(root + path.sep), 'Unsafe migration asset path');
  const stat = lstatSync(file); const resolved = realpathSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024 && resolved.startsWith(root + path.sep), 'Unsafe/oversized migration asset');
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
