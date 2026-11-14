import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, bundle, digest, validateInput, validateResponse } from './radiator-intel.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('../docs/radiator-intel-schema-v1.json', import.meta.url)));
const save = (p, v) => fs.writeFileSync(p, JSON.stringify(v));
const load = p => JSON.parse(fs.readFileSync(p));

test('offline selected-only preparation, immutable originals, bounded validation and guarded bundles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-intel-test-'));
  try {
    const record = id => ({ id, url: 'https://fixture.invalid/', title: 'FIXTURE, not vendor research',
      notes: 'Keep notes', my_notes: 'Keep manual field', text: 'Historical fixture capture',
      aesthetic_tags: ['radiator', 'keep'], steal_this: 'Old generated analysis', added: '2026-01-01' });
    const input = { format: 'board-radiator-selected-export/1', fixture: true,
      provenance: { archiveSha256: 'a'.repeat(64), membership: 'exported-canonical-home-board' },
      selection: { boardId: 'fixture-radiator', completeExportedBoard: true, expectedCount: 2 },
      board: { id: 'fixture-radiator', name: 'Radiator', view: 'grid', descriptor: { view: 'grid', ingest_mode: 'url-screenshot', archive_on_promote: true, empty_state: { head: 'Fixture collection', body: 'Fixture empty-state copy' }, enrichment_prompt: 'Fixture old design prompt', fields: [
        { key: 'steal_this', label: 'Fixture steal_this', type: 'text', enrichable: true },
        { key: 'aesthetic_tags', label: 'Fixture aesthetic_tags', type: 'tags', enrichable: true },
        { key: 'my_notes', label: 'Fixture my_notes', type: 'text', enrichable: false },
        { key: 'text', label: 'Fixture text', type: 'text', enrichable: true },
        { key: 'screenshot', label: 'Fixture screenshot', type: 'image', enrichable: true }] } },
      items: [record('fixture-one'), record('fixture-two')], assets: [
        { id: 'shot', itemId: 'fixture-one', kind: 'screenshot', path: 'screenshots/fixture.png' }] };
    const source = path.join(dir, 'selected.json'), base = path.join(dir, 'baseline.json'), runDir = path.join(dir, 'run');
    save(source, input); save(base, { summary: 'Fixture baseline only', sources: [{ id: 'R1', text: 'Decided is not shipped' }, { id: 'R2', text: 'Source evidence only' }] });
    const beforeBytes = fs.readFileSync(source);
    const p = prepare(source, runDir, base);
    assert.equal(p.selected, 2); assert.equal(p.distinctUrls, 1); assert.equal(p.modelCallsMadeByThisCommand, 0);
    assert.throws(() => prepare(source, runDir, base), /new directory/);
    assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(runDir, 'original-selected-export.json')).mode & 0o777, 0o600);
    const run = load(path.join(runDir, 'run.json')), job = run.jobs[0];
    assert.deepEqual(job.retireKeys, ['steal_this']);
    assert.notEqual(run.jobs[0].key, run.jobs[1].key); // Duplicate URLs retain separate immutable IDs.
    assert.deepEqual(bundle(runDir).counts, { 'blocked-evidence': 2 });
    const e = { itemId: job.id, source: job.source, sources: [{ id: 'T1', url: 'https://fixture.invalid/docs',
      kind: 'primary', retrievedOn: new Date().toISOString().slice(0, 10), text: 'FIXTURE primary-source excerpt. '.repeat(8) }] };
    save(path.join(runDir, 'evidence', job.key + '.json'), e);
    const fields = Object.fromEntries(schema.fields.filter(f => f.enrichable).map(f => [f.key,
      f.type === 'enum' ? 'enabler' : f.key.endsWith('.implication') ? 'Analyst inference: fixture evaluation only.' : 'FIXTURE claim, not real vendor evidence [T1].']));
    const response = { itemId: job.id, source: job.source, fields };
    const shortKeys = structuredClone(response); shortKeys.fields.subject = shortKeys.fields['intel_v1.subject']; delete shortKeys.fields['intel_v1.subject'];
    assert.equal(validateResponse(shortKeys, job, e, ['R1'])['intel_v1.subject'], response.fields['intel_v1.subject']);
    shortKeys.fields['intel_v1.subject'] = 'Conflicting value'; assert.throws(() => validateResponse(shortKeys, job, e, ['R1']), /Conflicting/);
    const punctuated = structuredClone(response); punctuated.fields['intel_v1.evidence'] = 'T1: https://fixture.invalid/docs);';
    punctuated.fields['intel_v1.job'] = 'Current claim [T1, R1]'; assert.doesNotThrow(() => validateResponse(punctuated, job, e, ['R1']));
    punctuated.fields['intel_v1.evidence'] = 'T1: https://fixture.invalid/docs-UNFETCHED'; assert.throws(() => validateResponse(punctuated, job, e, ['R1']), /Unsupplied URL/);
    const falseBaseline = structuredClone(response); falseBaseline.fields['intel_v1.comparison'] += ' [R2]';
    assert.throws(() => validateResponse(falseBaseline, job, e, ['R1']), /Invented source/);
    const receipt = attempt => ({ itemId: job.id, source: job.source, runKey: job.runKey, attempt,
      evidenceSha256: digest(e), responseSha256: digest(attempt === 1 ? bad : response), billing: 'fixture', modelId: 'fixture-model', elapsedSeconds: 1, inputTokens: null, outputTokens: null });
    assert.equal(bundle(runDir).counts['pending-subscription-worker'], 1);
    const bad = structuredClone(response); bad.fields['intel_v1.job'] += ' [T99]';
    save(path.join(runDir, 'responses', job.key + '.1.json'), bad);
    save(path.join(runDir, 'receipts', job.key + '.1.json'), receipt(1));
    assert.equal(bundle(runDir).counts['invalid-output'], 1);
    save(path.join(runDir, 'responses', job.key + '.2.json'), response);
    save(path.join(runDir, 'receipts', job.key + '.2.json'), receipt(2));
    const built = bundle(runDir), result = load(built.file), good = result.entries.find(x => x.id === job.id);
    assert.equal(built.counts['validated-awaiting-human-review'], 1);
    assert.equal(result.executable, false); assert.equal(result.appliesToProduction, false);
    assert.equal(result.proposedFutureBoardUpdate.applied, false);
    assert.equal(result.proposedFutureBoardUpdate.descriptor.archive_on_promote, true);
    assert.deepEqual(result.proposedFutureBoardUpdate.descriptor.empty_state, input.board.descriptor.empty_state);
    assert(result.proposedFutureBoardUpdate.descriptor.fields.some(f => f.key === 'aesthetic_tags' && f.enrichable === false));
    assert(result.proposedFutureBoardUpdate.descriptor.fields.some(f => f.key === 'my_notes' && f.enrichable === false));
    assert.equal(good.guards.expectedExportRecordSha256, digest(input.items[0]));
    assert.deepEqual(good.expectedOldGeneratedValues, { steal_this: 'Old generated analysis' });
    assert.deepEqual(good.deleteGeneratedKeys, ['steal_this']);
    assert(!Object.keys(good.setAnalysisFields).some(k => ['notes', 'url', 'my_notes', 'aesthetic_tags'].includes(k)));
    assert.equal(good.setAnalysisFields['intel_v1.prompt_version'], 'radiator-intel/1.1');
    assert.equal(bundle(runDir).file, built.file); // Immutable deterministic bundle, no rerun/model calls.
    const changed = structuredClone(response); changed.fields['intel_v1.subject'] = 'Altered after receipt';
    save(path.join(runDir, 'responses', job.key + '.2.json'), changed);
    assert.equal(bundle(runDir).counts['invalid-output'], 1); // Receipt is bound to exact output.
    save(path.join(runDir, 'responses', job.key + '.2.json'), response);
    assert.deepEqual(fs.readFileSync(source), beforeBytes);
    assert.deepEqual(load(path.join(runDir, 'original-selected-export.json')), input);
    const malicious = structuredClone(response); malicious.script = 'rm -rf /';
    save(path.join(runDir, 'responses', job.key + '.2.json'), malicious);
    assert.equal(bundle(runDir).counts['invalid-output'], 1);
    save(path.join(runDir, 'responses', job.key + '.2.json'), response);
    const changedBase = path.join(dir, 'changed-baseline.json');
    const nextBaseline = load(base); nextBaseline.summary = 'A different pinned baseline'; save(changedBase, nextBaseline);
    const replayDir = path.join(dir, 'replay'); prepare(source, replayDir, changedBase);
    const replayRun = load(path.join(replayDir, 'run.json')); replayRun.jobs = run.jobs;
    save(path.join(replayDir, 'run.json'), replayRun);
    assert.throws(() => bundle(replayDir), /run key does not match/);
    const invalidBase = load(base); invalidBase.sources.push(invalidBase.sources[0]); save(changedBase, invalidBase);
    assert.throws(() => prepare(source, path.join(dir, 'duplicate-baseline'), changedBase), /duplicate baseline/);
    // A fixture receipt must never validate a real run or imply subscription billing.
    const real = structuredClone(input); real.fixture = false; save(source, real);
    const realDir = path.join(dir, 'real'); prepare(source, realDir, base);
    for (const folder of ['evidence', 'responses', 'receipts']) {
      for (const name of fs.readdirSync(path.join(runDir, folder))) fs.copyFileSync(path.join(runDir, folder, name), path.join(realDir, folder, name));
    }
    assert.equal(bundle(realDir).counts['invalid-output'], 1);
    const modified = load(path.join(runDir, 'run.json')); modified.jobs[0].retireKeys.push('aesthetic_tags');
    save(path.join(runDir, 'run.json'), modified);
    assert.throws(() => bundle(runDir), /Protected/);
    const wrong = structuredClone(input); wrong.items[1].id = wrong.items[0].id;
    assert.throws(() => validateInput(wrong), /duplicate/);
    wrong.items[1].id = 'other'; wrong.items[1].url = 'https://paperclip.ing/';
    assert.throws(() => validateInput(wrong), /Paperclip/);
    wrong.items[1].url = 'javascript:bad'; assert.throws(() => validateInput(wrong), /Unsafe URL/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
