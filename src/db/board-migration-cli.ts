import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyMigration, openMigrationDb, planMigration, undoMigration, verifyMigration } from './board-migration.js';

// Explicit paths only. Reports contain digests/counts, never bundle or private row data.
// --offline acknowledges stopped writers; it is NOT an online-safety detector.
export async function runMigrationCli(args: string[]): Promise<void> {
  const defaultDryRun = !args[0] || args[0].startsWith('--');
  const command = defaultDryRun ? 'dry-run' : args[0];
  const rest = defaultDryRun ? args : args.slice(1);
  const commands = ['dry-run', 'apply', 'verify', 'undo'];
  if (!commands.includes(command)) throw new Error('expected dry-run, apply, verify, or undo');
  const allowed = new Set(['--db', '--data-dir',
    ...(command === 'dry-run' || command === 'apply' ? ['--bundle'] : ['--operation']),
    ...(command === 'apply' ? ['--digest', '--backup'] : []),
    ...(command === 'apply' || command === 'undo' ? ['--offline', '--backup-confirmed'] : []),
  ]);
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!allowed.has(flag) || Object.hasOwn(flags, flag)) throw new Error('unsupported or duplicate flag');
    if (flag === '--offline' || flag === '--backup-confirmed') flags[flag] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error('missing flag value');
      flags[flag] = value;
    }
  }
  const required = (flag: string): string => {
    if (typeof flags[flag] !== 'string') throw new Error('required flag missing');
    return flags[flag] as string;
  };
  const path = (flag: string): string => {
    const value = required(flag);
    if (!isAbsolute(value)) throw new Error('absolute paths required');
    return value;
  };
  const dbPath = path('--db'), dataDir = path('--data-dir');
  const opts = { offlineAcknowledged: flags['--offline'] === true, backupAcknowledged: flags['--backup-confirmed'] === true };
  let input: unknown;
  if (command === 'apply' || command === 'dry-run') {
    const bundlePath = path('--bundle');
    if (!statSync(bundlePath).isFile() || statSync(bundlePath).size > 16 * 1024 * 1024) throw new Error('bundle must be a bounded regular file');
    input = JSON.parse(readFileSync(bundlePath, 'utf8'));
  }
  const operation = command === 'verify' || command === 'undo' ? required('--operation') : '';
  const digest = command === 'apply' ? required('--digest') : '';
  const backupPath = command === 'apply' ? path('--backup') : '';
  if ((command === 'apply' || command === 'undo') && (!opts.offlineAcknowledged || !opts.backupAcknowledged)) throw new Error('offline maintenance and operator backup acknowledgments required');
  const handle = openMigrationDb(dbPath, command === 'dry-run' || command === 'verify');
  try {
    if (command === 'dry-run') {
      const plan = planMigration(handle, input, dataDir);
      console.log(JSON.stringify({ state: 'planned', digest: plan.digest, items: plan.before.rows.length, patches: plan.bundle.patches.length }));
    } else if (command === 'apply') console.log(JSON.stringify(await applyMigration(handle, input, dataDir, { ...opts, digest, backupPath })));
    else if (command === 'verify') console.log(JSON.stringify(verifyMigration(handle, operation, dataDir)));
    else console.log(JSON.stringify(await undoMigration(handle, operation, dataDir, opts)));
  } finally { handle.sqlite.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMigrationCli(process.argv.slice(2)).catch(() => {
    // Error objects from filesystem/SQLite/Zod can carry private paths or values.
    console.error('Migration refused. Check explicit paths, flags, acknowledgments, guards and plan digest.');
    process.exitCode = 1;
  });
}
