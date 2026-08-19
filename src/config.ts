import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';

// Story 2.1 — the single env-driven config loader. Every deployment knob is read
// here from an INJECTED env (pure, testable); Stories 2.2/2.3/2.4 migrate their
// specific consumers to read from this surface, and the `// Story 2.1/2.2` markers
// left in Epic 1 resolve here.
//
// Scope: this owns DEPLOYMENT config (PORT, HOST, DATA_DIR, CHROME_PATH, provider).
// It deliberately does NOT own the prototype's subprocess-IPC run-flags
// (BOARD_COLLECTION/BOARD_UPDATE_ID/BOARD_INSTRUCTIONS/BOARD_RESULT_FILE/
// BOARD_ALLOW_EMPTY_CAPTURE) — those are per-invocation IPC, not configuration.

export interface ProviderConfig {
  /** CLI agent id for CliProvider (claude/codex/…). Epic 4 consumes. */
  agent: string | null;
  /** Model name (HttpProvider or CLI). */
  model: string | null;
  /** OpenAI-compatible base URL for HttpProvider. */
  baseUrl: string | null;
  /** API key (secret — redacted in every serialization surface, AC 5). */
  apiKey: string | null;
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Derived: the SQLite DB file, rooted under DATA_DIR (Story 2.2). */
  dbPath: string;
  /** Derived: the screenshots directory, rooted under DATA_DIR (Story 2.2). */
  screenshotsDir: string;
  /** Derived: the snapshots (archival self-contained HTML) directory (Story 16.1). */
  snapshotsDir: string;
  chromePath: string | null;
  /**
   * Budget for ONE capture job, which covers headless capture AND the LLM read
   * together (they share a job so the item holds a single `processing` state). The
   * old fixed 60s was tight enough that an ordinary CLI-provider enrichment could
   * exhaust it and fail an item whose page had already been captured. Raise it for
   * slow local models via CAPTURE_TIMEOUT_MS.
   */
  captureTimeoutMs: number;
  provider: ProviderConfig;
  /**
   * Coarse "some provider knob is set" signal — the NFR-4 graceful default is false.
   * NOT authoritative for "is AI actually usable": `selectProvider(config)` (Story
   * 4.4) is the source of truth and degrades misconfig (unknown agent, base-URL
   * without a model, key-only) to `disabledLlm` even though this is true. Status
   * displays (Story 8.5) must reflect the selected provider, not this flag.
   */
  providerEnabled: boolean;
  /**
   * Story 12.1 — SHA-256 hash (hex) of BOARD_API_TOKEN, or null when unset. Only
   * the hash is held; the plaintext token is never stored. Set NON-ENUMERABLE (like
   * `apiKey`) so it also drops out of every serialization surface (JSON.stringify /
   * util.inspect / spread): an unsalted hash of a low-entropy operator token in a
   * debug dump is a cheap offline brute-force target, so it must not be logged either.
   * The `/api/v1` bearer guard (api/v1.ts) compares incoming-token hashes against
   * this with timingSafeEqual.
   */
  apiTokenHash: string | null;
  /**
   * Story 12.1 — allowlisted cross-origin origins for the `/api/v1` surface
   * (BOARD_API_CORS_ORIGINS, comma-separated). Empty = no cross-origin allowed.
   * Scoped to the v1 plugin only; legacy/SPA routes emit no CORS headers.
   */
  corsOrigins: string[];
}

const REDACTED = '[REDACTED]';

/** Empty/whitespace → undefined, so `HOST=""`/`PORT=""` take the default (AC 1). */
function clean(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveMs(value: string | undefined, fallback: number): number {
  const raw = clean(value);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(
      `Invalid config: CAPTURE_TIMEOUT_MS must be a positive integer (milliseconds), got "${value}"`,
    );
  }
  return Number(raw);
}

function parsePort(value: string | undefined, fallback: number): number {
  const raw = clean(value);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid config: PORT must be a positive integer, got "${value}"`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid config: PORT must be between 1 and 65535, got "${value}"`);
  }
  return n;
}

/**
 * Pure config resolution from an INJECTED env. The app-facing singleton passes
 * `process.env` explicitly; tests pass a plain object. Throws a clear, key-naming
 * error on a malformed value rather than producing NaN / silently defaulting.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // LLM_* are the canonical names; the prototype's BOARD_* are accepted as aliases
  // so the existing CLI path keeps working. Canonical wins over legacy.
  const agent = clean(env.LLM_AGENT) ?? clean(env.BOARD_ANALYSIS_AGENT) ?? null;
  // Legacy model resolution mirrors the prototype's by-agent pick
  // (resolveAnalysisAgent in add.ts): claude→BOARD_CLAUDE_MODEL, else→BOARD_CODEX_MODEL.
  const legacyModel =
    agent === 'codex'
      ? clean(env.BOARD_CODEX_MODEL)
      : agent === 'claude'
        ? clean(env.BOARD_CLAUDE_MODEL)
        : (clean(env.BOARD_CLAUDE_MODEL) ?? clean(env.BOARD_CODEX_MODEL));
  const apiKey = clean(env.LLM_API_KEY) ?? null;

  const provider: ProviderConfig = {
    agent,
    model: clean(env.LLM_MODEL) ?? legacyModel ?? null,
    baseUrl: clean(env.LLM_BASE_URL) ?? null,
    // apiKey is set NON-ENUMERABLE below so it drops out of JSON.stringify /
    // util.inspect / spread / Object.entries of `provider` itself (a debug-log of
    // the provider sub-object must not echo the secret — NFR-3), while staying
    // programmatically reachable for Epic 4.
    apiKey: null,
  };
  Object.defineProperty(provider, 'apiKey', {
    value: apiKey,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  // Story 12.1 — hold only a SHA-256 hash of the API token; the plaintext is read
  // here and immediately hashed, never retained on `config`.
  const apiTokenPlain = clean(env.BOARD_API_TOKEN);
  const apiTokenHash = apiTokenPlain ? createHash('sha256').update(apiTokenPlain).digest('hex') : null;
  const corsOrigins = (clean(env.BOARD_API_CORS_ORIGINS) ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  const dataDir = clean(env.DATA_DIR) ?? './data';
  const config: Config = {
    port: parsePort(env.PORT, 3141),
    host: clean(env.HOST) ?? '127.0.0.1',
    dataDir,
    // Data lives under DATA_DIR, separate from app code, so upgrades never nuke it
    // (FR-21/NFR-6). Stored asset paths stay relative ("screenshots/<id>.png") and
    // resolve under screenshotsDir; only the resolution base moves here.
    dbPath: path.join(dataDir, 'board.db'),
    screenshotsDir: path.join(dataDir, 'screenshots'),
    snapshotsDir: path.join(dataDir, 'snapshots'),
    chromePath: clean(env.CHROME_PATH) ?? null,
    captureTimeoutMs: parsePositiveMs(env.CAPTURE_TIMEOUT_MS, 180_000),
    provider,
    // Enabled when a transport is configured (agent OR base-URL/key). A model name
    // alone does not enable AI.
    providerEnabled: provider.agent !== null || provider.baseUrl !== null || provider.apiKey !== null,
    // apiTokenHash set NON-ENUMERABLE below (like provider.apiKey) so it drops out of
    // every serialization surface; placeholder here satisfies the Config type.
    apiTokenHash: null,
    corsOrigins,
  };
  Object.defineProperty(config, 'apiTokenHash', {
    value: apiTokenHash,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  attachRedaction(config);
  return config;
}

/** A copy with the secret masked — used by every log/serialize surface (AC 5). */
function redact(config: Config): Omit<Config, 'provider'> & { provider: ProviderConfig } {
  return {
    ...config,
    provider: { ...config.provider, apiKey: config.provider.apiKey ? REDACTED : null },
  };
}

function attachRedaction(config: Config): void {
  const surface = (): unknown => redact(config);
  Object.defineProperty(config, 'toJSON', { value: surface, enumerable: false });
  Object.defineProperty(config, 'toString', {
    value: () => JSON.stringify(redact(config)),
    enumerable: false,
  });
  Object.defineProperty(config, inspect.custom, {
    value: () => redact(config),
    enumerable: false,
  });
}

/**
 * Idempotently create DATA_DIR + the screenshots subdir so a fresh install boots
 * with zero manual setup (NFR-4/UJ-3). One place, not scattered.
 */
export function ensureDataDir(cfg: Config = config): void {
  mkdirSync(cfg.dataDir, { recursive: true });
  mkdirSync(cfg.screenshotsDir, { recursive: true });
  mkdirSync(cfg.snapshotsDir, { recursive: true });
}

/** Resolved singleton for app code (reads the real process.env explicitly). */
export const config: Config = loadConfig(process.env);
