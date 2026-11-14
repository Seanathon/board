#!/usr/bin/env node
// Read-only local projection of the original snapshot and validated drafts. Never applies draft values to SQLite.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const dataDir = path.resolve(process.argv[2] ?? '');
assert(lstatSync(dataDir).isDirectory() && !lstatSync(dataDir).isSymbolicLink(), 'Explicit private preview directory required');
assert(!existsSync(path.join(dataDir, 'board.db')), 'Preview refuses an existing database');
const marker = JSON.parse(readFileSync(path.join(dataDir, 'preview-input.json'), 'utf8'));
assert(marker.format === 'board-radiator-preview-input/1', 'Prepared preview input required');
// This view is pinned to the reviewed119-item snapshot and its114 validated drafts, not arbitrary replacement JSON.
assert(marker.selectionSha256 === '82912ef03a2a59cc55bf7b620dbf3ac447e2beca7591e610292002db865dbe4c' && marker.bundleSha256 === 'c31bfb1bdfa85b92de42b7fcc7d5936edac5fed490639f803611143668f7cb10', 'Unreviewed preview inputs');
const load = (name: string, expected: string) => { const bytes = readFileSync(path.join(dataDir, name)); assert(createHash('sha256').update(bytes).digest('hex') === expected, 'Preview input changed'); return JSON.parse(bytes.toString('utf8')); };
const selection = load('selection.json', marker.selectionSha256); const bundle = load('bundle.json', marker.bundleSha256);
process.env.DATA_DIR = dataDir; process.env.HOST = '127.0.0.1';
const [{ initDb }, { buildServer }, { boards, assets }, { writeItem }, { disabledLlm }, { activateRadiatorProfile, boardGuard }, { buildDraftPreview, previewHtml }] = await Promise.all([
  import('../src/db/index.js'), import('../src/server.js'), import('../src/db/schema.js'), import('../src/db/queue.js'), import('../src/skills/types.js'), import('../src/radiator/profile.js'), import('../src/radiator/preview.js'),
]);
const preview = buildDraftPreview(selection, bundle); const handle = initDb(path.join(dataDir, 'board.db'));
handle.db.insert(boards).values(selection.board).run();
for (const record of selection.items) {
  const fields = Object.fromEntries(selection.board.descriptor.fields.filter((f: any) => !['url', 'screenshot'].includes(f.key)).map((f: any) => [f.key, record[f.key] ?? null]));
  await writeItem(handle, { id: record.id, boardId: selection.board.id, source: record.url, title: record.title ?? null, notes: record.notes ?? null, favorite: record.favorite ? 1 : 0,
    status: 'done', createdAt: Number.isFinite(Date.parse(record.added)) ? Math.floor(Date.parse(record.added) / 1000) : 0, fields });
}
for (const asset of selection.assets) handle.db.insert(assets).values(asset).run();
await activateRadiatorProfile(handle, { boardId: selection.board.id, expectedBoardSha256: boardGuard(selection.board) });
const app = await buildServer({ db: handle, llm: disabledLlm, screenshotsDir: path.join(dataDir, 'screenshots'), snapshotsDir: path.join(dataDir, 'snapshots') });
app.addHook('onRequest', async (request, reply) => {
  if (!['GET', 'HEAD'].includes(request.method)) return reply.code(409).send({ error: 'Read-only library preview. No changes are applied.' });
  // A previously cached proof shell has the same source-file ETag, but different preview chrome.
  if (['/', '/index.html'].includes(request.url.split('?')[0])) { delete request.headers['if-none-match']; delete request.headers['if-modified-since']; }
});
app.addHook('onSend', async (request, reply, payload) => {
  const url = request.url.split('?')[0];
  if (url === '/' || url === '/index.html') { if (payload && typeof (payload as any).destroy === 'function') (payload as any).destroy(); reply.removeHeader('etag'); reply.removeHeader('content-length'); reply.header('cache-control', 'no-store'); return previewHtml(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), preview.counts); }
  if (request.method === 'GET' && url === '/api/collections/' + selection.board.id + '/items' && typeof payload === 'string') { const rows = JSON.parse(payload); if (Array.isArray(rows)) return JSON.stringify(rows.map(preview.project)); }
  if (url === '/api/meta' && typeof payload === 'string') return JSON.stringify({ ...JSON.parse(payload), reviewPreview: { readOnly: true, ...preview.counts } });
  return payload;
});
const port = process.env.PREVIEW_PORT ? Number(process.env.PREVIEW_PORT) : 0;
const url = await app.listen({ host: '127.0.0.1', port });
console.log(JSON.stringify({ url, dataDir, ...preview.counts, readOnly: true, draftsAppliedToDatabase: 0, modelCalls: 0, diagnosticRuntime: process.versions.node.split('.')[0] !== '22' }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); handle.sqlite.close(); process.exit(0); });
