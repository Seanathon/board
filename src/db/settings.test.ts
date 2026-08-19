import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb } from './index.js';
import { getSetting, setSetting, getAllSettings } from './settings.js';

// A key/value table so runtime-editable config lives in the SAME SQLite file as
// everything else — the product promise is "a plain file you can copy and walk away
// with", which a sidecar JSON on disk would quietly break.
describe('settings store', () => {
  let dir: string;
  let handle: ReturnType<typeof initDb>;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-oss-settings-'));
    handle = initDb(join(dir, 's.db'));
  });
  after(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined for a key that was never set', () => {
    assert.equal(getSetting(handle, 'nope'), undefined);
  });

  it('round-trips a value and overwrites on a second write', () => {
    setSetting(handle, 'system_prompt', 'first');
    assert.equal(getSetting(handle, 'system_prompt'), 'first');
    setSetting(handle, 'system_prompt', 'second');
    assert.equal(getSetting(handle, 'system_prompt'), 'second', 'a setting is upserted, not duplicated');
  });

  it('stores multi-line prompt text verbatim', () => {
    const prompt = 'Line one.\n\n## A heading\n- bullet with `backticks` and "quotes"\n';
    setSetting(handle, 'system_prompt', prompt);
    assert.equal(getSetting(handle, 'system_prompt'), prompt);
  });

  it('lists everything set, for the config UI', () => {
    setSetting(handle, 'another', 'x');
    const all = getAllSettings(handle);
    assert.equal(all.another, 'x');
    assert.ok('system_prompt' in all);
  });

  it('treats an empty string as a real value, not as unset', () => {
    // Clearing a prompt to empty must not silently fall back to the built-in default;
    // the caller decides what empty means.
    setSetting(handle, 'blank', '');
    assert.equal(getSetting(handle, 'blank'), '');
  });
});
