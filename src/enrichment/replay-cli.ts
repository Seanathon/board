import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { replayEnrichment } from './replay.js';
import type { BoardDescriptor } from '../descriptor/types.js';

// `npm run replay:enrichment -- --db <board.db> --board <id> --raw <file> [--json]`
//
// Validates a saved model output against a board's descriptor offline. The database is
// opened READ-ONLY and no model is called, so it is safe against a live data dir.
// Exit code: 0 accepted, 1 rejected, 64 usage.

const args = process.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
const db = value('--db');
const board = value('--board');
const rawFile = value('--raw');
if (!db || !board || !rawFile) {
  console.error('usage: replay:enrichment --db <board.db> --board <board id> --raw <saved output file> [--json]');
  process.exit(64);
}

const sqlite = new Database(db, { readonly: true, fileMustExist: true });
let descriptor: BoardDescriptor | undefined;
try {
  const row = sqlite.prepare('SELECT descriptor FROM board WHERE id = ?').get(board) as { descriptor: string | null } | undefined;
  if (!row?.descriptor) { console.error(`replay: board "${board}" not found or has no descriptor`); process.exit(64); }
  descriptor = JSON.parse(row.descriptor) as BoardDescriptor;
} finally {
  sqlite.close();
}

const verdict = replayEnrichment(descriptor!, readFileSync(rawFile, 'utf8'));
if (args.includes('--json')) {
  console.log(JSON.stringify(verdict, null, 2));
} else {
  console.log(verdict.ok ? 'ACCEPTED' : 'REJECTED');
  for (const r of verdict.repairs) console.log(`  repaired: dropped ${r.kind}${r.key ? ` "${r.key}"` : ''}`);
  if (verdict.ok) console.log(`  would write: ${Object.keys(verdict.accepted).join(', ') || '(nothing)'}`);
  if (verdict.ignoredKeys.length) console.log(`  ignored (not on this board): ${verdict.ignoredKeys.join(', ')}`);
  for (const issue of verdict.issues) console.log(`  problem: ${issue}`);
}
process.exit(verdict.ok ? 0 : 1);
