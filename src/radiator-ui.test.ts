import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import * as helpers from './collections-ui.js';
import { escHtml, renderField, isSafeUrl } from './descriptor/render-map.js';
import { cardSummary, itemFieldEntries, radiatorPresentation, renderRadiatorState, renderRadiatorProvenance, isRadiatorReadOnlyField } from './collections-ui.js';

const keys = ['relevance', 'subject', 'rationale', 'job', 'workflow', 'boundary', 'control', 'operations', 'comparison', 'implication', 'evidence', 'unknowns'];
const fields = keys.map(key => ({ key: `intel_v1.${key}`, label: key, type: key === 'relevance' ? 'enum' : 'text', enrichable: true }));
const legacyDescriptor = { fields: [{ key: 'old.read', label: 'Old read', type: 'text', enrichable: true }] };
const collection = { id: 'radiator-9k51', intelligence: { version: 1, modelId: 'claude-sonnet-5-5', legacyDescriptor }, descriptor: { fields } };
const receipt = { version: 1, itemId: 'one', boardId: 'radiator-9k51', source: 'https://example.org/product', modelId: 'claude-sonnet-5-5', sessionId: 'a7bb085b-3c59-42c9-a401-dc088e591a1a', schemaVersion: 'radiator-intel/1', promptVersion: 'radiator-intel/1.1', baselineSha256: 'a'.repeat(64), reviewedOn: '2026-11-13', sources: [{ id: 's1', url: 'https://example.org/product', title: '<Primary>', retrievedOn: '2026-11-13', text: 'private excerpt' }], usage: {} };
const item = (): any => ({ id: 'one', url: receipt.source, status: 'done', fields: Object.fromEntries(keys.map(k => [`intel_v1.${k}`, `${k} value`])), radiator_meta: { receipt } });

test('trusted complete analysis leads with relevance and rationale, not first long text', () => {
  const value = item();
  value.fields['intel_v1.subject'] = 'subject '.repeat(30);
  value.fields['old.read'] = 'stale old analysis';
  const view = radiatorPresentation(value, collection);
  assert.equal(view.active, true);
  const summary = cardSummary(value, view.descriptor, { collection });
  assert.equal(summary.badge?.key, 'intel_v1.relevance');
  assert.equal(summary.lead?.key, 'intel_v1.rationale');
  assert.equal(itemFieldEntries(value, view.descriptor).some(e => e.value === 'stale old analysis'), false);
});

test('incomplete or untrusted analyses fall back, without exposing metadata or new partial analysis', () => {
  for (const alter of [(v: any) => delete v.fields['intel_v1.job'], (v: any) => v.radiator_meta.receipt = { ...receipt, modelId: 'other' }, (v: any) => delete v.radiator_meta.receipt]) {
    const value = item(); alter(value); value.fields['old.read'] = 'previous analysis';
    const view = radiatorPresentation(value, collection);
    assert.equal(view.active, false);
    assert.equal(cardSummary(value, view.descriptor).lead?.value, 'previous analysis');
  }
  const value = item();
  value.fields['radiator_meta.recovery'] = 'secret';
  assert.deepEqual(itemFieldEntries(value, { fields: [{ key: 'radiator_meta.recovery', type: 'text' }] }), []);
});

test('states are honest, safely fixed copy, and use existing retry buttons', () => {
  for (const [status, label] of [['researching', 'Researching primary sources'], ['analyzing', 'Analyzing the product'], ['error', 'Analysis could not finish'], ['disabled', 'Analysis is disabled']]) {
    const value = { id: '<one>', status: 'done', radiator_meta: { state: { version: 1, status, message: 'secret <script>' } } };
    const html = renderRadiatorState(value, collection);
    assert.ok(html.includes(label)); assert.ok(!html.includes('secret'));
    assert.equal(html.includes('data-retry-id="&lt;one&gt;"'), status === 'error' || status === 'disabled');
  }
  assert.match(renderRadiatorState({ id: 'one', status: 'done' }, collection), /No product analysis yet/);
  assert.equal(renderRadiatorState(item(), collection), '');
  assert.equal(renderRadiatorState({ status: 'error' }, { id: 'other' }), '');
});

test('provenance is read-only, escapes stamps, and links only exact HTTP(S) sources', () => {
  const value = item();
  value.radiator_meta.receipt = { ...receipt, sources: [...receipt.sources, ...['javascript:alert(1)', '//evil.org', 'data:text/html,hi', 'https://'].map(url => ({ id: 'bad', url, title: '<bad>' }))] };
  const html = renderRadiatorProvenance(value, collection);
  assert.ok(html.includes('href="https://example.org/product"'));
  assert.ok(html.includes('&lt;Primary&gt;'));
  assert.ok(html.includes(receipt.sessionId));
  assert.equal((html.match(/href=/g) || []).length, 1);
  assert.ok(!html.includes('private excerpt'));
  assert.ok(!html.includes('data-edit-key'));
  for (const key of ['intel_v1.reviewed_on', 'intel_v1.baseline', 'radiator_meta.receipt', 'url', 'screenshot']) assert.equal(isRadiatorReadOnlyField(key), true);
  assert.equal(isRadiatorReadOnlyField('my_notes'), false);
});

test('flat metadata works and unrelated collections retain incumbent descriptor', () => {
  const value = item(); delete value.radiator_meta; value.fields['radiator_meta.receipt'] = receipt;
  assert.equal(radiatorPresentation(value, collection).active, true);
  const other = { ...collection, id: 'other' };
  assert.equal(radiatorPresentation(value, other).descriptor, other.descriptor);
});

// Execute the actual inline UI functions in a fake DOM; no server or browser needed.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
function uiFunction(name: string) {
  let start = html.indexOf(`  function ${name}(`);
  if (start === -1) start = html.indexOf(`  async function ${name}(`);
  assert.notEqual(start, -1);
  return html.slice(start, html.indexOf('\n  }', start) + 4);
}
function fakeUi(value: any, col: any) {
  const dom = new JSDOM('<div id="modal-content"></div>');
  const context = vm.createContext({
    document: dom.window.document, window: { collectionHelpers: helpers, renderHelpers: { renderField, isSafeUrl } },
    bookmarks: [value], collections: [col], activeCollection: col.id, currentBookmark: null, modalLastFocused: null,
    MODAL_EDITABLE_TYPES: new Set(['text', 'number', 'date', 'url', 'enum', 'tags']), esc: escHtml,
    stateOf: () => 'ready', stateNote: () => '', shotSrc: () => '/asset', closeModal() {}, saveItemEdits() {}, toggleItemFavorite() {}, openModalOverlay() {},
    retryItem() {}, applyFilters() {}, buildTagCloud() {}, renderLibraryTopicCloud() {}, BOARD_FIELD_TYPES: ['text', 'enum', 'url', 'date', 'tags'],
  });
  vm.runInContext(['modalHasVal', 'modalEditInput', 'bindRetryButtons', 'openItemModal', 'collectItemPatch', 'boardFieldRowHtml', 'collectBoardDescriptor', 'applyStatusEvent', 'retryItem'].map(uiFunction).join('\n'), context);
  return { dom, context };
}

test('actual detail UI shows only the active analysis and keeps curation editable, not stamps', () => {
  const value = item(); value.notes = 'my note'; value.favorite = true;
  value.fields['old.read'] = 'legacy must not appear'; value.fields['my_tags'] = ['saved'];
  const col = { ...collection, descriptor: { fields: [...fields,
    { key: 'intel_v1.reviewed_on', label: 'Reviewed', type: 'date', enrichable: false },
    { key: 'my_tags', label: 'My tags', type: 'tags', enrichable: false },
    { key: 'tone', label: 'Tone', type: 'text', enrichable: false },
    { key: 'url', label: 'Source', type: 'url', enrichable: false },
  ] } };
  const { dom, context } = fakeUi(value, col);
  vm.runInContext('openItemModal("one")', context);
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.steal-this .field-value')?.textContent, 'rationale value');
  assert.match(doc.querySelector('.tier-badge')?.textContent ?? '', /relevance value/);
  assert.ok(!doc.body.textContent?.includes('legacy must not appear'));
  assert.ok(doc.querySelector('[data-edit-key="my_tags"]'));
  assert.ok(doc.querySelector('[data-edit-key="tone"]'));
  assert.equal(doc.querySelector('[data-edit-key="intel_v1.reviewed_on"]'), null);
  assert.equal(doc.querySelector('[data-edit-key="url"]'), null);
  assert.equal((doc.querySelector('[data-edit-notes]') as HTMLTextAreaElement).value, 'my note');
  assert.ok(doc.querySelector('.radiator-provenance a'));
  // Even a forged input cannot accidentally send a stamp through the save collector.
  const forged = doc.createElement('input'); forged.dataset.editKey = 'intel_v1.baseline'; forged.value = 'forged';
  doc.getElementById('modal-content')!.appendChild(forged);
  const patch = vm.runInContext('collectItemPatch()', context);
  assert.equal(patch['intel_v1.baseline'], undefined);
  assert.equal(patch.notes, 'my note');
  assert.equal(value.favorite, true);
});

test('actual board editor preserves archive and empty-state flags and disables runner stamp rows', () => {
  const col = { ...collection, descriptor: { ...collection.descriptor, archive_on_promote: true, empty_state: { headline: 'Keep this', body: 'Keep this too' } } };
  const { dom, context } = fakeUi(item(), col);
  dom.window.document.body.innerHTML = '<div id="board-fields-container"></div><textarea id="edit-board-prompt">lens</textarea><select id="edit-board-view"><option>grid</option></select><select id="edit-board-ingest"><option>url-readable</option></select>';
  const descriptor = vm.runInContext('collectBoardDescriptor("radiator-9k51")', context);
  assert.equal(descriptor.archive_on_promote, true);
  assert.equal(descriptor.empty_state.headline, 'Keep this');
  const row = vm.runInContext('boardFieldRowHtml({key:"intel_v1.reviewed_on",label:"Reviewed",type:"date",enrichable:false},true)', context);
  dom.window.document.getElementById('board-fields-container')!.innerHTML = row;
  assert.equal(dom.window.document.querySelector('fieldset')?.disabled, true);
  assert.ok(!dom.window.document.querySelector('.bf-key')?.matches(':enabled'));
});

test('actual live completion replaces flat and nested values and clears obsolete runner state', () => {
  const value = item(); value.status = 'processing';
  value.fields['intel_v1.rationale'] = 'old';
  value.fields['radiator_meta.state'] = { version: 1, status: 'analyzing' };
  value.radiator_meta.state = { version: 1, status: 'analyzing' };
  const { context } = fakeUi(value, collection);
  context.event = { itemId: 'one', status: 'done', fields: { 'intel_v1.rationale': 'fresh rationale', 'radiator_meta.receipt': receipt } };
  vm.runInContext('applyStatusEvent(event)', context);
  assert.equal(helpers.getFieldValue(value, 'intel_v1.rationale'), 'fresh rationale');
  assert.equal(helpers.getFieldValue(value, 'radiator_meta.state'), undefined);
  assert.equal(renderRadiatorState(value, collection), '');
});

test('actual retry uses incumbent refetch and replaces stale error with a useful pending state', async () => {
  const value = item(); value.radiator_meta.state = { version: 1, status: 'error' };
  const { context } = fakeUi(value, collection);
  let request: any;
  context.fetch = async (url: string, options: any) => { request = { url, options }; return { ok: true }; };
  await vm.runInContext('retryItem("one", null)', context);
  assert.equal(request.url, '/api/collections/radiator-9k51/items/one/refetch');
  assert.equal(request.options.method, 'POST');
  assert.match(renderRadiatorState(value, collection), /Preparing product analysis/);
  assert.ok(!renderRadiatorState(value, collection).includes('card-retry'));
});

test('terminal timeout takes precedence over stale researching or analyzing metadata', () => {
  for (const status of ['researching', 'analyzing']) {
    for (const flat of [false, true]) {
      const value = item();
      value.status = 'error'; value.error_reason = 'timed out';
      const state = { version: 1, status };
      if (flat) value.fields['radiator_meta.state'] = state;
      else value.radiator_meta.state = state;
      const rendered = renderRadiatorState(value, collection);
      assert.match(rendered, /Analysis could not finish/);
      assert.match(rendered, /data-retry-id="one"/);
      assert.ok(!rendered.includes('Researching primary sources'));
      assert.ok(!rendered.includes('Analyzing the product'));
      assert.equal(radiatorPresentation(value, collection).active, true);
    }
  }
});

test('legacy fallback upgrades matching curation definitions without moving old generated fields', () => {
  const tags = { key: 'aesthetic_tags', label: 'Your tags', type: 'tags', enrichable: false };
  const tone = { key: 'tone', label: 'Your tone', type: 'text', enrichable: false };
  const manual = { key: 'manual_note', label: 'Manual note', type: 'text', enrichable: false };
  const oldRead = { key: 'old.read', label: 'Old read', type: 'text', enrichable: true };
  const col = { ...collection,
    descriptor: { fields: [...fields, tags, tone, manual] },
    intelligence: { ...collection.intelligence, legacyDescriptor: { fields: [oldRead, { ...tags, enrichable: true }, { ...tone, enrichable: true }] } },
  };
  const value = item(); delete value.radiator_meta.receipt;
  Object.assign(value.fields, { 'old.read': 'Preserved legacy analysis '.repeat(4), aesthetic_tags: ['calm', 'warm'], tone: 'Quiet', manual_note: 'Personal context' });
  value.notes = 'My notes';
  const view = radiatorPresentation(value, col);
  assert.equal(view.active, false);
  assert.deepEqual(view.descriptor.fields.map((f: any) => f.key), ['old.read', 'aesthetic_tags', 'tone', 'manual_note']);
  assert.equal(cardSummary(value, view.descriptor).lead?.value, value.fields['old.read']);
  const { dom, context } = fakeUi(value, col);
  vm.runInContext('openItemModal("one")', context);
  const doc = dom.window.document;
  assert.equal((doc.querySelector('[data-edit-key="aesthetic_tags"]') as HTMLInputElement)?.value, 'calm, warm');
  assert.equal((doc.querySelector('[data-edit-key="tone"]') as HTMLTextAreaElement)?.value, 'Quiet');
  assert.equal((doc.querySelector('[data-edit-key="manual_note"]') as HTMLTextAreaElement)?.value, 'Personal context');
  assert.equal((doc.querySelector('[data-edit-notes]') as HTMLTextAreaElement)?.value, 'My notes');
  assert.equal(doc.querySelector('[data-edit-key="old.read"]'), null);
});

test('receipt rejects wrong item or board, empty/unsafe source and non-UUID session', () => {
  for (const change of [
    { itemId: 'other' }, { itemId: undefined }, { boardId: 'other' }, { boardId: undefined },
    { source: '' }, { source: '   ' }, { source: 'javascript:alert(1)' }, { source: '//example.org' },
    { sessionId: '' }, { sessionId: 'not-a-uuid' }, { sessionId: '<session>' },
  ]) {
    const value = item();
    value.radiator_meta.receipt = { ...receipt, ...change };
    if ('source' in change) value.url = change.source;
    value.fields['old.read'] = 'retained legacy';
    assert.equal(radiatorPresentation(value, collection).active, false, JSON.stringify(change));
    assert.equal(renderRadiatorProvenance(value, collection), '');
    assert.equal(cardSummary(value, radiatorPresentation(value, collection).descriptor).lead?.value, 'retained legacy');
  }
});

test('a forged raw root metadata field cannot substitute for hydrated runner metadata', () => {
  const value = item(); delete value.radiator_meta;
  value.fields.radiator_meta = { receipt, state: { version: 1, status: 'researching' } };
  assert.equal(radiatorPresentation(value, collection).active, false);
  assert.equal(renderRadiatorProvenance(value, collection), '');
  assert.match(renderRadiatorState(value, collection), /No product analysis yet/);
});

test('configuration errors show fixed review guidance without hiding saved content or manual fields', () => {
  const col = { ...collection,
    intelligence: { ...collection.intelligence, configurationError: true, error: 'SECRET <stack>' },
    descriptor: { fields: [...fields, { key: 'tone', label: 'Tone', type: 'text', enrichable: false }] },
  };
  for (const active of [true, false]) {
    const value = item(); value.notes = 'Keep notes'; value.fields.tone = 'Quiet';
    value.fields['old.read'] = 'Legacy read '.repeat(8);
    if (!active) delete value.radiator_meta.receipt;
    value.radiator_meta.state = { version: 1, status: 'researching', message: 'SECRET' };
    const rendered = renderRadiatorState(value, col);
    assert.match(rendered, /Analysis configuration needs review/);
    assert.ok(!rendered.includes('SECRET'));
    assert.ok(!rendered.includes('card-retry'));
    const { dom, context } = fakeUi(value, col);
    vm.runInContext('openItemModal("one")', context);
    assert.equal((dom.window.document.querySelector('[data-edit-key="tone"]') as HTMLTextAreaElement)?.value, 'Quiet');
    assert.equal((dom.window.document.querySelector('[data-edit-notes]') as HTMLTextAreaElement)?.value, 'Keep notes');
    assert.ok(dom.window.document.body.textContent?.includes(active ? 'rationale value' : 'Legacy read'));
  }
});
