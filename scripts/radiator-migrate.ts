#!/usr/bin/env -S node --import tsx
import assert from 'node:assert/strict';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../src/db/schema.js';
import { RADIATOR_BOARD_ID } from '../src/radiator/contract.js';
import { loadApprovedMigration } from '../src/radiator/migration-input.js';
import { applyMigration, dryRunMigration, undoMigration, verifyMigration } from '../src/radiator/migration.js';

/** No initDb, environment defaults, prepared-JSON shortcut, inference or force mode. */
export async function main(args = process.argv.slice(2)): Promise<number> {
  const names = ['target', 'db', 'data-dir', 'backup-dir', 'plan-digest', 'run-id', 'selection', 'bundle', 'baseline', 'source-data-dir', 'selection-sha256', 'bundle-sha256', 'archive-sha256', 'asset-manifest-sha256'];
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: Object.fromEntries(names.map(k => [k, { type: 'string' as const }])) });
  const command = positionals[0] ?? 'dry-run';
  assert(positionals.length <= 1 && ['dry-run', 'apply', 'verify', 'undo'].includes(command), 'Expected dry-run (default), apply, verify or undo');
  const required = (key: string): string => { const value = values[key]; assert(typeof value === 'string' && value.length > 0, `Explicit --${key} required`); return value; };
  assert(required('target') === RADIATOR_BOARD_ID, 'Only --target radiator-9k51 is supported');
  const dbPath = required('db'); const dataDir = required('data-dir');
  assert(path.isAbsolute(dbPath) && path.isAbsolute(dataDir), '--db and --data-dir must be absolute');
  assert(lstatSync(dbPath).isFile() && !lstatSync(dbPath).isSymbolicLink(), '--db must be an existing regular file, not a symlink');
  const sourceCommands = command === 'apply' || command === 'dry-run';
  const allowed = new Set(['target', 'db', 'data-dir', ...(sourceCommands ? ['selection', 'bundle', 'baseline', 'source-data-dir', 'selection-sha256', 'bundle-sha256', 'archive-sha256', 'asset-manifest-sha256'] : ['run-id']), ...(command === 'apply' ? ['backup-dir', 'plan-digest'] : [])]);
  for (const key of Object.keys(values)) assert(allowed.has(key), `--${key} is not used by ${command}`);
  const prepared = sourceCommands ? loadApprovedMigration({
    selectionPath: required('selection'), bundlePath: required('bundle'), baselinePath: required('baseline'), sourceDataDir: required('source-data-dir'),
    expectedSelectionSha256: required('selection-sha256'), expectedBundleSha256: required('bundle-sha256'), expectedArchiveSha256: required('archive-sha256'), expectedAssetManifestSha256: required('asset-manifest-sha256'),
  }) : undefined;
  const readonly = command === 'dry-run' || command === 'verify';
  const sqlite = new Database(realpathSync(dbPath), { readonly, fileMustExist: true });
  try {
    // Connection-local pragmas only. Never bootstrap schema or change journal mode.
    sqlite.pragma('foreign_keys = ON'); sqlite.pragma('busy_timeout = 5000');
    if (readonly) sqlite.pragma('query_only = ON');
    const handle = { sqlite, db: drizzle(sqlite, { schema }) };
    const result = command === 'dry-run' ? dryRunMigration(handle, prepared!, { dataDir })
      : command === 'apply' ? await applyMigration(handle, prepared!, { dataDir, backupDir: required('backup-dir'), planDigest: required('plan-digest') })
      : command === 'verify' ? verifyMigration(handle, { dataDir, runId: required('run-id') })
      : await undoMigration(handle, { dataDir, runId: required('run-id') });
    console.log(JSON.stringify(result, null, 2));
    return 'conflicts' in result && result.conflicts.length ? 2 : 0;
  } finally { sqlite.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
}
