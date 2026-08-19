import type { Config, ProviderConfig } from '../config.js';
import { disabledLlm, type LLMProvider } from '../skills/types.js';
import { HttpProvider } from './http-provider.js';
import { CliProvider, type CliAgent } from './cli-provider.js';
// The claude-CLI model default. Shared with add.ts's `resolveAnalysisAgent` (the
// `npm run add` path) so BOTH headless callers ask for the same model — `claude -p`
// with no `--model` would otherwise inherit the operator's interactive default (Opus
// on a subscription box): minutes and real money for a fixed-schema extraction.
// A floating alias, not a dated id, so it tracks the current Sonnet.
import { DEFAULT_CLAUDE_CLI_MODEL } from '../add.js';

// Story 4.4 — pick the LLM transport from config, with a NO-AI DEFAULT.
//
// Enrichment is OPTIONAL: the default install configures no provider and gets
// `disabledLlm` (the throwing sentinel from Story 3.1), so boot never requires a
// coding CLI or an API key (C10 — the coding CLI is OPT-IN, not the default; this
// deliberately reverses the prototype's claude default).
//
// Precedence (documented + tested): an explicit HTTP base-URL+model WINS over a CLI
// agent when both are set. HTTP needs base-URL AND model; CLI needs a supported
// agent (claude|codex — cursor is out of v1 scope). Anything else (incl. an unknown
// agent or a base-URL with no model) → `disabledLlm`, so a misconfiguration degrades
// to no-AI rather than blocking boot (NFR-4).
export function selectProvider(config: Config): LLMProvider {
  const p = config.provider;

  // HTTP wins when configured.
  if (p.baseUrl && p.model) {
    return new HttpProvider({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model });
  }

  if (p.agent === 'claude' || p.agent === 'codex') {
    return new CliProvider({ agent: resolveCliAgent(p) as CliAgent });
  }

  return disabledLlm;
}

/**
 * Resolve the CLI agent (id + model) for `CliProvider`. Split out from
 * `selectProvider` so the model default is testable on its own and — critically —
 * lands ONLY on the CLI path: defaulting `provider.model` in `loadConfig` would make
 * a base-URL-only install satisfy `baseUrl && model` above and silently point an
 * HttpProvider at a model that host has never heard of.
 *
 * `codex` is left unpinned: it has its own model catalog and its own default.
 */
export function resolveCliAgent(p: ProviderConfig): { id: 'claude' | 'codex'; model: string | null } {
  const id = p.agent as 'claude' | 'codex';
  if (p.model) return { id, model: p.model };
  return { id, model: id === 'claude' ? DEFAULT_CLAUDE_CLI_MODEL : null };
}

export interface ProviderInfo {
  kind: 'cli' | 'http';
  agent?: 'claude' | 'codex';
  /** Human label for the UI (add-button + provider menu). */
  label: string;
}

const CLI_AGENT_LABELS: Record<'claude' | 'codex', string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/**
 * The human-facing identity of the provider `selectProvider` would resolve — for
 * /api/meta, so the UI labels the add button and lists ONLY the configured provider
 * (no phantom agents). MUST mirror selectProvider's precedence: HTTP (base-URL+model)
 * wins; a supported CLI agent next; anything else → null (no AI).
 */
export function describeProvider(config: Config): ProviderInfo | null {
  const p = config.provider;
  if (p.baseUrl && p.model) return { kind: 'http', label: p.model };
  if (p.agent === 'claude' || p.agent === 'codex') {
    return { kind: 'cli', agent: p.agent, label: CLI_AGENT_LABELS[p.agent] };
  }
  return null;
}
