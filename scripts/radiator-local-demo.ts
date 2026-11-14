#!/usr/bin/env node
// LOCAL review only. Always creates a NEW disposable DATA_DIR; never accepts an existing DB.
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { disabledLlm } from '../src/skills/types.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'board-radiator-review-'));
process.env.DATA_DIR = dataDir;
process.env.HOST = '127.0.0.1';
process.env.LLM_AGENT = 'claude'; // this child process only; global provider settings are unchanged
const [{ initDb }, { buildServer }, { seedRadiatorFixture }, profile, { boards, items }, { eq }, { writeItem }, { captureRegistry, registerAllCaptureAdapters }, { runRadiatorSonnet }, { RADIATOR_BOARD_ID }, { selectProvider }, { config }] = await Promise.all([
  import('../src/db/index.js'), import('../src/server.js'), import('../src/radiator/fixture.js'), import('../src/radiator/profile.js'),
  import('../src/db/schema.js'), import('drizzle-orm'), import('../src/db/queue.js'), import('../src/capture/adapter.js'),
  import('../src/llm/radiator-sonnet.js'), import('../src/radiator/contract.js'), import('../src/llm/select-provider.js'), import('../src/config.js'),
]);
const handle = initDb(path.join(dataDir, 'board.db'));
seedRadiatorFixture(handle);
await writeItem(handle, { id: 'local-legacy-fixture', boardId: RADIATOR_BOARD_ID, source: 'https://fixture.example/legacy', title: 'Local fixture — legacy fallback', status: 'done', notes: 'Synthetic review fixture, not researched.', fields: { steal_this: 'This synthetic legacy design observation remains visible until a successful replacement.', tier: 'reference', aesthetic_tags: ['curated'], tone: ['quiet'], my_notes: 'This manual field stays editable.' } });
const before = handle.db.select().from(boards).where(eq(boards.id, RADIATOR_BOARD_ID)).get()!;
const beforeBoardSha256 = profile.boardGuard(before);
await profile.activateRadiatorProfile(handle, { boardId: RADIATOR_BOARD_ID, expectedBoardSha256: beforeBoardSha256 });
await writeItem(handle, { id: 'local-error-fixture', boardId: RADIATOR_BOARD_ID, source: 'https://fixture.example/blocked', title: 'Local fixture — blocked analysis', status: 'error', errorReason: 'AI returned invalid output', notes: 'Synthetic error-state fixture, no model call.', fields: { 'radiator_meta.state': { version: 1, status: 'error' } } });
if (!captureRegistry.has('url-readable')) registerAllCaptureAdapters(captureRegistry);
let invocations = 0;
const real = process.argv.includes('--real');
const app = await buildServer({ db: handle, llm: real ? selectProvider(config) : disabledLlm, screenshotsDir: config.screenshotsDir, snapshotsDir: config.snapshotsDir,
  radiator: { recoveryDir: path.join(dataDir, 'radiator-recovery'), auditDir: path.join(dataDir, 'radiator-runs'), cli: { command: process.env.RADIATOR_CLAUDE_COMMAND || 'claude' },
    complete: async (prompt, options) => {
      if (!real || invocations >= 1) throw new Error('Local review inference limit reached');
      invocations++;
      return runRadiatorSonnet(prompt, options);
    },
  },
});
app.get('/api/radiator/local-proof', async () => ({ localOnly: true, invocationLimit: real ? 1 : 0, invocations, dataDir, beforeBoardSha256, modelRequested: 'claude-sonnet-5-5', productionTouched: false }));
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const launch = { localOnly: true, url: address, dataDir, node: process.version, abi: process.versions.modules, diagnosticRuntime: process.versions.node.split('.')[0] !== '22', modelRequested: 'claude-sonnet-5-5', invocationLimit: real ? 1 : 0, beforeBoardSha256, productionTouched: false };
const evidenceIndex = process.argv.indexOf('--evidence-dir');
if (evidenceIndex !== -1) {
  const dir = path.resolve(process.argv[evidenceIndex + 1]);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'launch.json');
  if (existsSync(file)) throw new Error('Review launch evidence already exists');
  writeFileSync(file, JSON.stringify(launch, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify(launch));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); handle.sqlite.close(); process.exit(0); });
