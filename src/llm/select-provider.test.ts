import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { loadConfig } from '../config.js';
import { disabledLlm, EnrichmentDisabledError } from '../skills/types.js';
import { HttpProvider } from './http-provider.js';
import { CliProvider } from './cli-provider.js';
import { selectProvider, describeProvider, resolveCliAgent } from './select-provider.js';

describe('selectProvider (Story 4.4)', () => {
  // AC 1/3/6 — no provider config → disabledLlm (the C10 no-AI default)
  it('returns disabledLlm when no provider is configured', () => {
    assert.equal(selectProvider(loadConfig({})), disabledLlm);
  });

  // AC 2/6 — HTTP config → HttpProvider
  it('returns HttpProvider for HTTP config (base-URL + model)', () => {
    const p = selectProvider(loadConfig({ LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm', LLM_API_KEY: 'k' }));
    assert.ok(p instanceof HttpProvider);
  });

  // AC 2/6 — CLI config → CliProvider (claude/codex)
  it('returns CliProvider for a CLI agent', () => {
    assert.ok(selectProvider(loadConfig({ LLM_AGENT: 'claude' })) instanceof CliProvider);
    assert.ok(selectProvider(loadConfig({ LLM_AGENT: 'codex', LLM_MODEL: 'o4' })) instanceof CliProvider);
  });

  // AC 4 — both configured → HTTP wins (documented precedence), asserted
  it('prefers HttpProvider when BOTH HTTP and CLI are configured', () => {
    const p = selectProvider(loadConfig({ LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm', LLM_AGENT: 'claude' }));
    assert.ok(p instanceof HttpProvider, 'explicit HTTP base-URL wins over CLI');
  });

  // graceful: an unknown/unsupported agent must not break boot → disabledLlm
  it('returns disabledLlm for an unknown CLI agent (e.g. cursor, out of scope)', () => {
    assert.equal(selectProvider(loadConfig({ LLM_AGENT: 'cursor' })), disabledLlm);
  });

  // HTTP needs a model — base-URL alone (no model, no agent) → disabledLlm
  it('returns disabledLlm when base-URL is set without a model', () => {
    assert.equal(selectProvider(loadConfig({ LLM_BASE_URL: 'http://x/v1' })), disabledLlm);
  });

  // AC 5 — disabledLlm.complete THROWS the typed error (the degrade is Story 5.2's)
  it('disabledLlm.complete throws EnrichmentDisabledError', async () => {
    await assert.rejects(
      () => disabledLlm.complete('p', z.object({})),
      (e: unknown) => e instanceof EnrichmentDisabledError,
    );
  });
});

// describeProvider — the human-facing identity of the resolved provider, for /api/meta
// (so the UI labels the add button and lists only the configured provider). Mirrors
// selectProvider's precedence (HTTP wins; unknown/incomplete → null).
describe('describeProvider', () => {
  it('returns null when no provider is configured', () => {
    assert.equal(describeProvider(loadConfig({})), null);
  });
  it('labels a claude CLI agent', () => {
    assert.deepEqual(describeProvider(loadConfig({ LLM_AGENT: 'claude' })), { kind: 'cli', agent: 'claude', label: 'Claude Code' });
  });
  it('labels a codex CLI agent', () => {
    assert.deepEqual(describeProvider(loadConfig({ LLM_AGENT: 'codex' })), { kind: 'cli', agent: 'codex', label: 'Codex' });
  });
  it('labels an HTTP provider by model, and HTTP wins over a CLI agent', () => {
    assert.deepEqual(
      describeProvider(loadConfig({ LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'gpt-4o', LLM_AGENT: 'claude' })),
      { kind: 'http', label: 'gpt-4o' },
    );
  });
  it('returns null for an unknown agent or a base-URL without a model (mirrors selectProvider)', () => {
    assert.equal(describeProvider(loadConfig({ LLM_AGENT: 'cursor' })), null);
    assert.equal(describeProvider(loadConfig({ LLM_BASE_URL: 'http://x/v1' })), null);
  });
});

// The CLI agent's model. Left unset, `claude -p` inherits whatever the operator's
// interactive default is (Opus on this box) — expensive and slow for a structured
// extraction. Board pins Sonnet for the headless read; an explicit LLM_MODEL wins.
describe('resolveCliAgent (headless model default)', () => {
  it('defaults the claude CLI agent to sonnet when no model is configured', () => {
    assert.deepEqual(resolveCliAgent(loadConfig({ LLM_AGENT: 'claude' }).provider), {
      id: 'claude',
      model: 'sonnet',
    });
  });

  it('honors an explicit LLM_MODEL over the default', () => {
    assert.deepEqual(resolveCliAgent(loadConfig({ LLM_AGENT: 'claude', LLM_MODEL: 'opus' }).provider), {
      id: 'claude',
      model: 'opus',
    });
  });

  it('honors the legacy BOARD_CLAUDE_MODEL alias over the default', () => {
    assert.deepEqual(
      resolveCliAgent(loadConfig({ LLM_AGENT: 'claude', BOARD_CLAUDE_MODEL: 'haiku' }).provider),
      { id: 'claude', model: 'haiku' },
    );
  });

  // codex has its own model catalog — Board does not pick one for it.
  it('leaves codex unpinned (no claude default leaks across agents)', () => {
    assert.deepEqual(resolveCliAgent(loadConfig({ LLM_AGENT: 'codex' }).provider), {
      id: 'codex',
      model: null,
    });
  });

  // The default must NOT enable HTTP: selectProvider gates HTTP on baseUrl && model,
  // so a base-URL-only install has to stay disabled rather than resolve to a guess.
  it('does not enable an HTTP provider that has a base-URL but no model', () => {
    assert.equal(selectProvider(loadConfig({ LLM_BASE_URL: 'http://x/v1' })), disabledLlm);
  });
});
