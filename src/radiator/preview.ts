import assert from 'node:assert/strict';
import { validateInput, digest, validateResponse } from '../../scripts/radiator-intel.mjs';
import { RADIATOR_BOARD_ID, RADIATOR_MODEL_ID, RADIATOR_ANALYSIS_KEYS } from './contract.js';

type Draft = { id: string; source: string; status: string; guards?: Record<string, string>; setAnalysisFields?: Record<string, string>; evidence?: any; controllerReceipt?: any; deleteGeneratedKeys?: string[]; outputSha256?: string };
/** Display-only projection. The originals and database are never changed by this function. */
export function buildDraftPreview(snapshot: unknown, rawBundle: unknown) {
  const selected = validateInput(snapshot);
  const bundle = rawBundle as { format: string; boardId: string; executable: boolean; appliesToProduction: boolean; source: { archiveSha256: string }; entries: Draft[]; selectionCount: number; schemaSha256: string; schema: unknown; baselineSha256: string };
  assert(selected.board.id === RADIATOR_BOARD_ID && bundle.format === 'board-radiator-replacement-bundle/1' && bundle.boardId === RADIATOR_BOARD_ID && bundle.executable === false && bundle.appliesToProduction === false, 'Not a Radiator data-only preview');
  assert(bundle.source.archiveSha256 === selected.provenance.archiveSha256 && digest(bundle.schema) === bundle.schemaSha256, 'Preview source/schema guard mismatch');
  assert(bundle.selectionCount === selected.items.length && bundle.entries.length === selected.items.length, 'Preview selection count mismatch');
  const records = new Map<string, any>(selected.items.map((item: any) => [item.id, item]));
  const entries = new Map<string, Draft>(); let drafts = 0;
  for (const entry of bundle.entries) {
    assert(!entries.has(entry.id), 'Duplicate preview entry');
    const original = records.get(entry.id); assert(original && original.url === entry.source, 'Preview item identity mismatch');
    if (entry.status === 'validated-awaiting-human-review') {
      const fields = entry.setAnalysisFields!; const receipt = entry.controllerReceipt;
      assert(entry.guards?.expectedExportRecordSha256 === digest(original) && entry.guards?.expectedBoardSha256 === digest(selected.board) && entry.guards?.expectedAssetRowsSha256 === digest(selected.assets.filter((a: any) => a.itemId === entry.id)), 'Preview before-image guard mismatch');
      assert(receipt?.controllerVerified === true && receipt.modelId === RADIATOR_MODEL_ID && receipt.itemId === entry.id && receipt.source === entry.source && receipt.responseSha256 === entry.outputSha256 && receipt.evidenceSha256 === digest(entry.evidence), 'Draft provenance mismatch');
      assert(Array.isArray(receipt.effectiveModelsAsReported) && receipt.effectiveModelsAsReported.length === 1 && receipt.effectiveModelsAsReported[0] === RADIATOR_MODEL_ID, 'Draft effective model mismatch');
      validateResponse({ itemId: entry.id, source: entry.source, fields: Object.fromEntries(RADIATOR_ANALYSIS_KEYS.map(key => [key, fields[key]])) }, { id: entry.id, source: entry.source }, entry.evidence, ['R1', 'R1G', 'R1J', 'R2']);
      assert(fields['intel_v1.baseline'] === bundle.baselineSha256, 'Draft baseline stamp mismatch');
      drafts++;
    } else assert(['blocked-evidence', 'invalid-output'].includes(entry.status), 'Unknown draft status');
    entries.set(entry.id, entry);
  }
  const counts = { total: selected.items.length, drafts, retained: selected.items.length - drafts };
  return {
    selected, counts,
    project(item: Record<string, any>): Record<string, any> {
      const entry = entries.get(item.id); assert(entry && records.get(item.id).url === item.url, 'Preview response identity mismatch');
      const out = structuredClone(item);
      if (entry.status !== 'validated-awaiting-human-review') { out.radiator_meta = { state: { version: 1, status: 'error' } }; out.status = 'done'; return out; }
      for (const key of entry.deleteGeneratedKeys ?? []) delete out[key];
      out.intel_v1 = Object.fromEntries(Object.entries(entry.setAnalysisFields!).map(([key, value]) => [key.slice('intel_v1.'.length), value]));
      const r = entry.controllerReceipt;
      out.radiator_meta = { receipt: { version: 1, previewOnly: true, kind: 'validated-local-draft', itemId: item.id, boardId: RADIATOR_BOARD_ID, source: entry.source,
        modelId: r.modelId, sessionId: r.sessionId, schemaVersion: entry.setAnalysisFields!['intel_v1.schema_version'], promptVersion: entry.setAnalysisFields!['intel_v1.prompt_version'],
        baselineSha256: bundle.baselineSha256, reviewedOn: entry.setAnalysisFields!['intel_v1.reviewed_on'], sources: entry.evidence.sources.map((s: any) => ({ id: s.id, url: s.url, title: s.title, retrievedOn: s.retrievedOn })),
        responseSha256: r.responseSha256, promptSha256: r.effectivePromptSha256, usage: r.usageAsReported } };
      out.status = 'done'; delete out.error_reason; return out;
    },
  };
}

// Literal browser code: serializing a transpiled function can leak compiler helpers.
const PREVIEW_CLIENT = String.raw`(() => {
  try { localStorage.setItem('board.activeCollection', 'radiator-9k51'); } catch {}
  document.addEventListener('DOMContentLoaded', () => {
    const seen = new WeakSet();
    const update = () => {
      document.querySelectorAll('.add-bar,#add-dock,#agent-menu,#ai-nudge,.card-retry,.more-btn,.more-btn-list').forEach(el => { el.hidden = true; el.style.display = 'none'; });
      document.querySelectorAll('.fav-btn,.fav-btn-list,#new-board-btn,#edit-board-btn,#modal-fav,#edit-board-save,#edit-board-delete,#board-add-field,#modal-content button').forEach(el => {
        if (el.closest('#modal-content') && (el.getAttribute('role') === 'tab' || el.textContent?.trim() === 'Close')) return;
        el.disabled = true; el.title = 'Read-only preview; no changes are applied';
      });
      document.querySelectorAll('#modal-content [data-edit-key],#modal-content [data-edit-notes]').forEach(el => { el.readOnly = true; });
      const heading = document.querySelector('.radiator-provenance h3');
      if (heading && heading.textContent !== 'Proposed analysis — source provenance') heading.textContent = 'Proposed analysis — source provenance';
      const tab = document.querySelector('#modal-content [role="tab"][data-panel="intel_v1"]');
      if (tab && !seen.has(tab)) { seen.add(tab); tab.textContent = 'Product analysis'; tab.click(); }
    };
    update(); new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  });
})();`;

export function previewHtml(html: string, counts: { total: number; drafts: number; retained: number }): string {
  assert(Object.values(counts).every(Number.isSafeInteger), 'Invalid preview counts');
  const head = `<style>.review-preview{padding:12px 16px;background:var(--surface);color:var(--text);border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:4px 16px}.review-preview span{max-width:80ch}</style><script>${PREVIEW_CLIENT}</script>`;
  const notice = `<aside class="review-preview" role="note"><strong>Read-only library preview</strong><span>${counts.total} saved listings · ${counts.drafts} proposed analyses · ${counts.retained} prior analyses retained. Nothing applied; no new AI calls.</span></aside>`;
  return html.replace('</head>', head + '</head>').replace('<body>', '<body>' + notice);
}
