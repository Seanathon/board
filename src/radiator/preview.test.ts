import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { digest } from '../../scripts/radiator-intel.mjs';
import { INTEL_DESCRIPTOR } from './profile.js';
import { buildDraftPreview, previewHtml } from './preview.js';

function fixture() {
  const items = [{ id: 'one', url: 'https://example.com/', notes: 'Owner note' }, { id: 'two', url: 'https://example.org/', notes: 'Second note' }];
  const board = { id: 'radiator-9k51', name: 'Radiator', view: 'grid', descriptor: { fields: [{ key: 'old', label: 'Old analysis', type: 'text', enrichable: true }], enrichment_prompt: 'Original lens', view: 'grid', ingest_mode: 'url-readable' } };
  const snapshot = { format: 'board-radiator-selected-export/1', fixture: true, board, items, assets: [], selection: { boardId: board.id, completeExportedBoard: true, expectedCount: 2 }, provenance: { archiveSha256: 'a'.repeat(64), membership: 'exported-canonical-home-board' } };
  const evidence = { sources: [{ id: 'T1', url: items[0].url, title: 'Example', retrievedOn: '2026-11-13', text: 'Inspected test material' }] };
  const fields = Object.fromEntries(INTEL_DESCRIPTOR.fields.filter(f => f.enrichable).map(f => [f.key, f.key.endsWith('.relevance') ? 'reference' : f.key.endsWith('.implication') ? 'Analyst inference: compare one bounded workflow [T1].' : 'An inspected product claim or baseline comparison [T1, R1].']));
  Object.assign(fields, { 'intel_v1.schema_version': 'radiator-intel/1', 'intel_v1.prompt_version': 'radiator-intel/1.1', 'intel_v1.reviewed_on': '2026-11-13', 'intel_v1.baseline': 'b'.repeat(64) });
  const entry = { id: 'one', source: items[0].url, status: 'validated-awaiting-human-review', guards: { expectedExportRecordSha256: digest(items[0]), expectedAssetRowsSha256: digest([]), expectedBoardSha256: digest(board) }, setAnalysisFields: fields, evidence, outputSha256: 'c'.repeat(64), deleteGeneratedKeys: ['old'], controllerReceipt: { itemId: 'one', source: items[0].url, controllerVerified: true, modelId: 'claude-sonnet-5-5', sessionId: '12345678-1234-4234-8234-123456789abc', effectiveModelsAsReported: ['claude-sonnet-5-5'], responseSha256: 'c'.repeat(64), evidenceSha256: digest(evidence), usageAsReported: { input_tokens: 1, output_tokens: 1 } } };
  const bundle = { format: 'board-radiator-replacement-bundle/1', boardId: board.id, executable: false, appliesToProduction: false, source: snapshot.provenance, schema: INTEL_DESCRIPTOR, schemaSha256: digest(INTEL_DESCRIPTOR), baselineSha256: 'b'.repeat(64), selectionCount: 2, entries: [entry, { id: 'two', source: items[1].url, status: 'blocked-evidence' }] };
  return { snapshot, bundle };
}
test('preview projects validated drafts without changing originals, prior values or curation', () => {
  const { snapshot, bundle } = fixture(); const before = JSON.stringify({ snapshot, bundle }); const preview = buildDraftPreview(snapshot, bundle);
  assert.deepEqual(preview.counts, { total: 2, drafts: 1, retained: 1 });
  const original = { id: 'one', url: 'https://example.com/', notes: 'Owner note', old: 'Old observation', tone: ['quiet'] };
  const projected = preview.project(original); assert.equal(projected.radiator_meta.receipt.previewOnly, true); assert.equal(projected.radiator_meta.receipt.itemId, 'one'); assert.equal(projected.notes, original.notes); assert.deepEqual(projected.tone, original.tone); assert.equal(projected.old, undefined); assert.equal(original.old, 'Old observation');
  const blocked = preview.project({ id: 'two', url: 'https://example.org/', old: 'Retained old read' }); assert.equal(blocked.old, 'Retained old read'); assert.equal(blocked.radiator_meta.receipt, undefined);
  assert.equal(JSON.stringify({ snapshot, bundle }), before);
});
test('preview rejects source guards, duplicates and invented model provenance', () => {
  for (const mutation of [(x: ReturnType<typeof fixture>) => { x.snapshot.items[0].notes = 'changed'; }, (x: ReturnType<typeof fixture>) => { const entry = x.bundle.entries[0]; if ('controllerReceipt' in entry) entry.controllerReceipt.modelId = 'wrong'; }, (x: ReturnType<typeof fixture>) => { x.bundle.entries[1] = x.bundle.entries[0]; }]) {
    const value = fixture(); mutation(value); assert.throws(() => buildDraftPreview(value.snapshot, value.bundle));
  }
});
test('preview browser bootstrap is executable without compiler helpers and exposes no write affordances', async () => {
  const errors: unknown[] = []; const console = new VirtualConsole(); console.on('jsdomError', e => errors.push(e));
  const html = previewHtml(`<!doctype html><html><head></head><body><div class="add-bar"><button id="add-btn">Add</button></div><button id="new-board-btn">New board</button><button class="card-retry">Retry</button><div id="modal-content"><button role="tab" data-panel="intel_v1" onclick="this.setAttribute('aria-selected','true')">intel_v1</button><textarea data-edit-notes></textarea><button>Save</button><button>Close</button><section class="radiator-provenance"><h3>Sources</h3></section></div> </body></html>`, { total: 119, drafts: 114, retained: 5 });
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', virtualConsole: console });
  try {
    await new Promise<void>(resolve => dom.window.addEventListener('load', () => resolve()));
    const doc = dom.window.document; assert.equal(errors.length, 0); assert.ok(doc.querySelector('.review-preview')?.textContent?.includes('119 saved listings')); assert.equal((doc.querySelector('.add-bar') as HTMLElement).hidden, true); assert.equal((doc.querySelector('#new-board-btn') as HTMLButtonElement).disabled, true); assert.equal((doc.querySelector('textarea') as HTMLTextAreaElement).readOnly, true);
    const buttons = [...doc.querySelectorAll('button')]; assert.equal(buttons.find(b => b.textContent === 'Save')?.disabled, true); assert.equal(buttons.find(b => b.textContent === 'Close')?.disabled, false); assert.equal(doc.querySelector('[role="tab"]')?.textContent, 'Product analysis'); assert.equal(doc.querySelector('[role="tab"]')?.getAttribute('aria-selected'), 'true'); assert.equal(dom.window.localStorage.getItem('board.activeCollection'), 'radiator-9k51');
  } finally { dom.window.close(); }
});
