import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, ensureDataDir } from './config.js';

// Story 2.1 — pure, injectable config loader. Tests never touch the real process.env.

describe('loadConfig (Story 2.1)', () => {
  // AC 1 — unset env yields safe defaults
  it('applies safe defaults when env is empty', () => {
    const c = loadConfig({});
    assert.equal(c.port, 3141);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(typeof c.dataDir, 'string');
    assert.ok(c.dataDir.length > 0);
    assert.equal(c.chromePath, null);
    assert.equal(c.providerEnabled, false); // unset = no-AI
    assert.equal(c.provider.apiKey, null);
    assert.equal(c.provider.agent, null);
  });

  // AC 2 — env overrides win
  it('lets non-empty env override every knob', () => {
    const c = loadConfig({
      PORT: '8080',
      HOST: '0.0.0.0',
      DATA_DIR: '/tmp/board-x',
      CHROME_PATH: '/usr/bin/chromium',
      LLM_BASE_URL: 'https://api.example/v1',
      LLM_API_KEY: 'sk-secret',
      LLM_MODEL: 'gpt-x',
      LLM_AGENT: 'codex',
    });
    assert.equal(c.port, 8080);
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.dataDir, '/tmp/board-x');
    assert.equal(c.chromePath, '/usr/bin/chromium');
    assert.equal(c.provider.baseUrl, 'https://api.example/v1');
    assert.equal(c.provider.apiKey, 'sk-secret');
    assert.equal(c.provider.model, 'gpt-x');
    assert.equal(c.provider.agent, 'codex');
    assert.equal(c.providerEnabled, true);
  });

  // AC 1 — empty/whitespace string is treated as UNSET (the HOST="" security trap)
  it('treats empty/whitespace HOST and PORT as unset (not bind-all)', () => {
    assert.equal(loadConfig({ HOST: '' }).host, '127.0.0.1');
    assert.equal(loadConfig({ HOST: '   ' }).host, '127.0.0.1');
    assert.equal(loadConfig({ PORT: '' }).port, 3141);
  });

  // AC 4 — malformed value fails fast with a named error
  it('throws a clear, key-naming error on a malformed PORT', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
    assert.throws(() => loadConfig({ PORT: '-5' }), /PORT/);
    assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
    assert.throws(() => loadConfig({ PORT: '3141.5' }), /PORT/); // decimals rejected
    assert.throws(() => loadConfig({ PORT: '0x10' }), /PORT/); // hex rejected
    assert.throws(() => loadConfig({ PORT: '0' }), /PORT/); // out of range
  });

  // providerEnabled — a model name alone must NOT enable AI (no-AI default)
  it('does not enable the provider when only a model name is set', () => {
    assert.equal(loadConfig({ LLM_MODEL: 'gpt-x' }).providerEnabled, false);
    assert.equal(loadConfig({ LLM_API_KEY: 'sk-x' }).providerEnabled, true);
    assert.equal(loadConfig({ LLM_AGENT: 'claude' }).providerEnabled, true);
  });

  // AC 5 — the provider key never leaks into logs/serialized config
  it('redacts the provider API key in all serialization surfaces', () => {
    const c = loadConfig({ LLM_API_KEY: 'sk-supersecret-zzz' });
    assert.doesNotMatch(JSON.stringify(c), /sk-supersecret-zzz/);
    assert.doesNotMatch(inspect(c), /sk-supersecret-zzz/);
    assert.doesNotMatch(String(c), /sk-supersecret-zzz/);
    assert.doesNotMatch(`${c}`, /sk-supersecret-zzz/);
    // ...but the real key is still programmatically reachable for Epic 4.
    assert.equal(c.provider.apiKey, 'sk-supersecret-zzz');
  });

  // AC 5 — the NESTED provider object must not leak when serialized/logged directly
  it('does not leak the key when the provider sub-object is serialized directly', () => {
    const c = loadConfig({ LLM_API_KEY: 'sk-nested-leak' });
    assert.doesNotMatch(JSON.stringify(c.provider), /sk-nested-leak/);
    assert.doesNotMatch(inspect(c.provider), /sk-nested-leak/);
    // spread / Object.entries of config (which drop the non-enumerable toJSON) too
    assert.doesNotMatch(JSON.stringify({ ...c }), /sk-nested-leak/);
    assert.doesNotMatch(inspect(Object.fromEntries(Object.entries(c.provider))), /sk-nested-leak/);
  });

  // Story 12.1 — BOARD_API_TOKEN is held only as a SHA-256 hash; plaintext never serialized
  it('holds only a SHA-256 hash of BOARD_API_TOKEN and never serializes the plaintext', () => {
    const c = loadConfig({ BOARD_API_TOKEN: 'tok-supersecret-zzz' });
    assert.equal(typeof c.apiTokenHash, 'string');
    assert.equal(c.apiTokenHash!.length, 64); // sha256 hex
    assert.doesNotMatch(JSON.stringify(c), /tok-supersecret-zzz/);
    assert.doesNotMatch(inspect(c), /tok-supersecret-zzz/);
    assert.doesNotMatch(String(c), /tok-supersecret-zzz/);
    // the non-reversible hash is non-enumerable, so it also drops out of every
    // serialization surface (an unsalted hash of a low-entropy token is brute-forceable).
    assert.ok(!JSON.stringify(c).includes(c.apiTokenHash!));
    assert.ok(!inspect(c).includes(c.apiTokenHash!));
    assert.ok(!String(c).includes(c.apiTokenHash!));
    // ...but it stays directly reachable for the bearer guard.
    assert.equal(typeof c.apiTokenHash, 'string');
    // unset → no token
    assert.equal(loadConfig({}).apiTokenHash, null);
  });

  // Story 12.1 — BOARD_API_CORS_ORIGINS parses into a trimmed list (default: none)
  it('parses BOARD_API_CORS_ORIGINS into a list and defaults to empty', () => {
    assert.deepEqual(loadConfig({}).corsOrigins, []);
    assert.deepEqual(
      loadConfig({ BOARD_API_CORS_ORIGINS: 'https://a.example, https://b.example' }).corsOrigins,
      ['https://a.example', 'https://b.example'],
    );
    // blank entries dropped
    assert.deepEqual(loadConfig({ BOARD_API_CORS_ORIGINS: ' , https://c.example , ' }).corsOrigins, [
      'https://c.example',
    ]);
  });

  // Provider env legacy aliases (keep the prototype CLI path working)
  it('folds legacy BOARD_ANALYSIS_AGENT / model env as provider aliases', () => {
    const c = loadConfig({ BOARD_ANALYSIS_AGENT: 'claude', BOARD_CLAUDE_MODEL: 'claude-x' });
    assert.equal(c.provider.agent, 'claude');
    assert.equal(c.provider.model, 'claude-x');
    assert.equal(c.providerEnabled, true);
    const codex = loadConfig({ BOARD_ANALYSIS_AGENT: 'codex', BOARD_CODEX_MODEL: 'codex-y' });
    assert.equal(codex.provider.model, 'codex-y');
    // explicit LLM_* wins over the legacy alias
    assert.equal(loadConfig({ BOARD_ANALYSIS_AGENT: 'claude', LLM_AGENT: 'codex' }).provider.agent, 'codex');
    // legacy model is resolved BY AGENT (mirrors the prototype): codex agent + both
    // model vars set → the codex model, not the claude one.
    const both = loadConfig({
      BOARD_ANALYSIS_AGENT: 'codex',
      BOARD_CLAUDE_MODEL: 'claude-m',
      BOARD_CODEX_MODEL: 'codex-m',
    });
    assert.equal(both.provider.model, 'codex-m');
  });
});

// Story 16.1 — derived snapshotsDir (rooted under DATA_DIR, Story 2.2 relative-path
// contract) + ensureDataDir creates it idempotently. Additive alongside screenshotsDir.
describe('snapshotsDir (Story 16.1)', () => {
  it('derives snapshotsDir under DATA_DIR, sibling of screenshotsDir', () => {
    const c = loadConfig({ DATA_DIR: '/tmp/board-snap' });
    assert.equal(c.snapshotsDir, path.join('/tmp/board-snap', 'snapshots'));
    assert.equal(c.screenshotsDir, path.join('/tmp/board-snap', 'screenshots'));
  });

  it('ensureDataDir creates the snapshots dir idempotently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-oss-snapcfg-'));
    try {
      const c = loadConfig({ DATA_DIR: dir });
      ensureDataDir(c);
      ensureDataDir(c); // idempotent — second call must not throw
      assert.ok(fs.existsSync(c.snapshotsDir), 'snapshots dir was created');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The capture job covers headless capture AND the LLM read as one unit of work. At
// the original fixed 60s an ordinary Claude-CLI enrichment could exhaust the budget
// and land the item in `error: timed out` with a captured page already in hand.
describe('capture timeout budget', () => {
  it('defaults to a budget that fits capture plus an LLM read', () => {
    assert.equal(loadConfig({}).captureTimeoutMs, 180_000);
  });

  it('is overridable for slow local models', () => {
    assert.equal(loadConfig({ CAPTURE_TIMEOUT_MS: '600000' }).captureTimeoutMs, 600_000);
  });

  it('rejects a non-numeric or zero value', () => {
    assert.throws(() => loadConfig({ CAPTURE_TIMEOUT_MS: 'soon' }), /CAPTURE_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ CAPTURE_TIMEOUT_MS: '0' }), /CAPTURE_TIMEOUT_MS/);
  });
});
