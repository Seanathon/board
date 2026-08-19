import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply } from "fastify";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAnalysisAgentId, type AnalysisAgentId } from "./add.js";
import {
  listCollections,
  getCollection,
  loadCollection,
  mutateCollection,
  type CollectionMeta,
} from "./storage.js";
import { config, ensureDataDir, type Config } from "./config.js";
import { getDb, type DbHandle } from "./db/index.js";
import { enqueueWrite, enqueueTransaction, reconcileInterruptedItems } from "./db/queue.js";
import { eq } from "drizzle-orm";
import { validateDescriptorProposal } from "./descriptor/guardrails.js";
import { patchItemFields, deleteItemWithAssets } from "./db/item-actions.js";
import { uploadAssetForItem } from "./capture/manual-upload.js";
import { listBoardItemsForUi, getItemForUi } from "./db/hydrate.js";
import { renameBoard, deleteBoardCascade } from "./db/board-actions.js";
import { boards as boardsTable } from "./db/schema.js";
import { addItemSkill } from "./skills/add-item.js";
import { refetchItem, reenrichBoardItems } from "./enrichment/refetch.js";
import { assignItems } from "./enrichment/assign.js";
import { archiveFootprint } from "./db/archive-footprint.js";
import { createRegistry, registerAllSkills, type SkillRegistry } from "./skills/registry.js";
import { buildCtx, type JobQueue, type LLMProvider, type Logger } from "./skills/types.js";
import { selectProvider, describeProvider } from "./llm/select-provider.js";
import { disabledLlm } from "./skills/types.js";
import { startSseStream } from "./sse.js";
import { pipeline } from "node:stream/promises";
import { createArchiveStream, extractArchive } from "./db/archive.js";
import { getAllSettings, setSetting } from "./db/settings.js";
import { DEFAULT_INSPIRATION_PROMPT } from "./add.js";
import { importDocumentSkill } from "./skills/import-document.js";
import { registerV1Api, sha256Hex } from "./api/v1.js";
import { buildBookmarklet, TOKEN_PLACEHOLDER } from "./capture-clients/bookmarklet.js";
import { captureRegistry, registerAllCaptureAdapters } from "./capture/adapter.js";
import { INSPIRATION_BOARD_ID, LIBRARY_BOARD_ID, INBOX_BOARD_ID, INSPIRATION_DESCRIPTOR, LIBRARY_DESCRIPTOR, seed, updateBoardDescriptor } from "./db/seed.js";
import type { BoardDescriptor } from "./descriptor/types.js";

// Story 7.2: the seeded boards' descriptors, served on /api/collections for the
// frontend's generic field renderer.
const SEED_DESCRIPTORS: Record<string, BoardDescriptor> = {
  [INSPIRATION_BOARD_ID]: INSPIRATION_DESCRIPTOR,
  [LIBRARY_BOARD_ID]: LIBRARY_DESCRIPTOR,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Story 2.4: bind posture (localhost default + reverse-proxy guidance) ---

export interface ListenOptions {
  port: number;
  host: string;
}

/** The exact object server.ts passes to app.listen — the testable bind seam. */
export function getListenOptions(cfg: Config = config): ListenOptions {
  return { port: cfg.port, host: cfg.host };
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Log a one-line warning when bound to a non-localhost address (AC 5) — the v1
 * safety net for an operator who exposes the port without reading the README,
 * given there is no built-in auth (reverse-proxy-only, AD7).
 */
export function warnIfExposed(opts: ListenOptions, logger: { warn: (m: string) => void } = console): void {
  if (!LOCAL_HOSTS.has(opts.host)) {
    logger.warn(
      `⚠  board-oss bound to ${opts.host}:${opts.port} — it ships no built-in auth. ` +
        `Ensure a reverse proxy (Caddy/Authelia/Tailscale) or firewall is in front.`,
    );
  }
}
const TAXONOMY_FILE = path.join(__dirname, "..", "taxonomy.json");

interface Bookmark {
  id: string;
  url: string;
  added: string;
  screenshot: string | null;
  title: string;
  meta: {
    audience: string;
    form: string;
    domain: string | null;
    tier: string;
    tone: string[];
    tags: string[];
  };
  design: Record<string, string>;
  reflection: Record<string, string>;
  favorite?: boolean;
  favorite_reason?: string;
  analysis_agent?: AnalysisAgentId;
  analysis_model?: string | null;
}

type PatchBody = {
  reflection?: Record<string, string>;
  favorite?: boolean;
  favorite_reason?: string;
  notes?: string;
};

// --- Shared helpers ---

function resolveCollection(cid: string, reply: FastifyReply): CollectionMeta | null {
  try {
    return getCollection(cid);
  } catch {
    reply.status(400);
    return null;
  }
}

function spawnAddItem(
  opts: { cid: string; url: string; updateId?: string; instructions?: string; analysisAgent?: string },
  reply: FastifyReply
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-result-"));
    const resultFile = path.join(resultDir, "item.json");
    const args = ["tsx", path.join(__dirname, "add.ts"), opts.url, "--collection", opts.cid];
    const env: NodeJS.ProcessEnv = { ...process.env, BOARD_RESULT_FILE: resultFile };
    if (opts.updateId) env.BOARD_UPDATE_ID = opts.updateId;
    if (opts.instructions) env.BOARD_INSTRUCTIONS = opts.instructions;
    if (opts.analysisAgent) env.BOARD_ANALYSIS_AGENT = opts.analysisAgent;

    const proc = spawn("npx", args, { cwd: path.join(__dirname, ".."), env });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      try {
        if (code !== 0) {
          reply.status(500);
          resolve({ error: "Failed to process item", detail: stderr });
          return;
        }
        resolve(JSON.parse(fs.readFileSync(resultFile, "utf-8")));
      } catch (err) {
        reply.status(500);
        resolve({ error: "Failed to read result", detail: (err as Error).message });
      } finally {
        fs.rmSync(resultDir, { recursive: true, force: true });
      }
    });
  });
}

// Shared handler: GET items for a collection
function handleGetItems(cid: string, reply: FastifyReply): Record<string, unknown>[] | { error: string } {
  const col = resolveCollection(cid, reply);
  if (!col) return { error: `Unknown collection: "${cid}"` };
  return loadCollection<Record<string, unknown>>(cid);
}

// Shared handler: add item (spawn)
async function handleAddItem(
  cid: string,
  body: { url?: string; analysisAgent?: string },
  reply: FastifyReply
): Promise<Record<string, unknown>> {
  const col = resolveCollection(cid, reply);
  if (!col) return { error: `Unknown collection: "${cid}"` };
  const { url, analysisAgent } = body;
  if (!url) { reply.status(400); return { error: "url is required" }; }
  if (analysisAgent !== undefined && !isAnalysisAgentId(analysisAgent)) {
    reply.status(400);
    return { error: "invalid analysisAgent" };
  }
  return spawnAddItem({ cid, url, analysisAgent }, reply);
}

// Shared handler: patch item fields (allowlisted)
function handlePatchItem(
  cid: string,
  itemId: string,
  body: PatchBody,
  reply: FastifyReply
): Record<string, unknown> | { error: string } {
  const col = resolveCollection(cid, reply);
  if (!col) return { error: `Unknown collection: "${cid}"` };

  const updated = mutateCollection<Record<string, unknown>, Record<string, unknown> | undefined>(
    col.id,
    (items) => {
      const idx = items.findIndex((b) => b.id === itemId);
      if (idx === -1) return undefined;
      let item = { ...items[idx] };
      // reflection: object-merge; other allowlisted keys: direct set
      if (body.reflection !== undefined) {
        item.reflection = { ...(item.reflection as object ?? {}), ...body.reflection };
      }
      if (body.favorite !== undefined) item.favorite = body.favorite;
      if (body.favorite_reason !== undefined) item.favorite_reason = body.favorite_reason;
      if (body.notes !== undefined) item.notes = body.notes;
      items[idx] = item;
      return items[idx];
    }
  );

  if (!updated) { reply.status(404); return { error: "Not found" }; }
  return updated;
}

// Shared handler: delete item
function handleDeleteItem(
  cid: string,
  itemId: string,
  reply: FastifyReply,
  screenshotsDir: string
): null | { error: string } {
  const col = resolveCollection(cid, reply);
  if (!col) return { error: `Unknown collection: "${cid}"` };

  const removed = mutateCollection<Record<string, unknown>, Record<string, unknown> | undefined>(
    col.id,
    (items) => {
      const idx = items.findIndex((b) => b.id === itemId);
      if (idx === -1) return undefined;
      return items.splice(idx, 1)[0];
    }
  );

  if (!removed) { reply.status(404); return { error: "Not found" }; }

  // Only clean up screenshot files for visual (grid) collections. Story 2.2:
  // screenshots live under DATA_DIR/screenshots — resolve by basename there.
  if (col.view === "grid" && removed.screenshot) {
    const screenshotPath = path.join(screenshotsDir, path.basename(removed.screenshot as string));
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
  }

  reply.status(204);
  return null;
}

// Shared handler: refetch item (spawn)
async function handleRefetchItem(
  cid: string,
  itemId: string,
  body: { instructions?: string; analysisAgent?: string },
  reply: FastifyReply
): Promise<Record<string, unknown>> {
  const col = resolveCollection(cid, reply);
  if (!col) return { error: `Unknown collection: "${cid}"` };
  const { analysisAgent } = body;
  if (analysisAgent !== undefined && !isAnalysisAgentId(analysisAgent)) {
    reply.status(400);
    return { error: "invalid analysisAgent" };
  }
  const item = loadCollection<Record<string, unknown>>(cid).find((b) => b.id === itemId);
  if (!item) { reply.status(404); return { error: "Not found" }; }
  return spawnAddItem({ cid, url: item.url as string, updateId: itemId, instructions: body.instructions, analysisAgent }, reply);
}

// Shared handler: manual image upload (the graceful escape hatch when auto-capture
// fails — e.g. an og:image fetch came back empty). SQLite-backed via the upload-asset
// path (capture/manual-upload), so it works for EVERY board, including composed ones
// (the legacy JSON handler only knew the three seeded boards and 400'd on a composed
// board id). Board-mode-agnostic by design: a readable/list item can also receive an
// uploaded image, so there is no "visual collections only" guard here.
async function handleScreenshot(
  handle: DbHandle,
  itemId: string,
  body: { dataUrl?: string },
  reply: FastifyReply,
  screenshotsDir: string
): Promise<Record<string, unknown> | { error: string } | null> {
  const dataUrl = body?.dataUrl;
  if (!dataUrl) { reply.status(400); return { error: "dataUrl is required" }; }
  if (!getItemForUi(handle, itemId)) { reply.status(404); return { error: "Not found" }; }

  try {
    await uploadAssetForItem(handle, { itemId, dataUrl, screenshotsDir });
  } catch (err) {
    // Bad/oversized data URL → client error. (Unknown item is already 404'd above.)
    reply.status(400);
    return { error: (err as Error).message };
  }

  return getItemForUi(handle, itemId) ?? null;
}

// --- Server factory ---

export interface BuildServerOptions {
  screenshotsDir?: string;
  /** Story 16.3 — snapshots dir for the archive footprint route; defaults to config. */
  snapshotsDir?: string;
  /** Skill registry (Story 3.1 seam). Defaults to a fresh registry + registerAllSkills. */
  registry?: SkillRegistry;
  /** ctx collaborators — injectable for hermetic tests; production uses real defaults. */
  db?: DbHandle;
  queue?: JobQueue;
  logger?: Logger;
  llm?: LLMProvider;
  /**
   * Story 12.1 — plaintext bearer token for the `/api/v1` surface. Hashed here;
   * defaults to the configured `config.apiTokenHash`. Pass `null` to force the v1
   * surface fail-closed (no token). Accepting plaintext is a test-ergonomics seam
   * (the AC5 `buildServer({ apiToken })` example) — production reads from config.
   */
  apiToken?: string | null;
  /** Story 12.1 — CORS allowlist for `/api/v1`; defaults to `config.corsOrigins`. */
  corsOrigins?: string[];
  /**
   * Story 16.2 — injectable archival snapshot enqueue (tests pass a spy so the per-item
   * archive action + the assign trigger never launch Chrome). Defaults to fire-and-forget
   * the 16.1 snapshot job on the single worker.
   */
  enqueueSnapshot?: (args: { itemId: string; url: string | null }) => void;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  // Story 2.2: screenshots resolve from DATA_DIR (config.screenshotsDir); tests
  // inject a temp dir so they never pollute the real data dir. The dir is created
  // at real boot via ensureDataDir() (the entrypoint), and handleScreenshot mkdirs
  // its write target — buildServer itself does not create dirs (so opt-less tests
  // don't materialize ./data).
  const screenshotsDir = opts.screenshotsDir ?? config.screenshotsDir;
  const snapshotsDir = opts.snapshotsDir ?? config.snapshotsDir;

  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });

  // Static shell (index.html, sw.js, manifest, icons) lives in ../public. The
  // browser-shipped JS modules stay under src/ (next to their node tests and the
  // descriptor module they import) and are served by the two explicit routes below.
  const publicDir = path.join(__dirname, "..", "public");
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    index: false,
    serve: true,
  });

  // The two browser entry points the page fetches live under src/ (no build step),
  // outside the public static root. Serve them explicitly with a plain route (same
  // pattern as /screenshots/* below) rather than a 2nd @fastify/static instance,
  // which would crash on decorateReply double-registration.
  const sendJs = (reply: FastifyReply, abs: string) => {
    if (!fs.existsSync(abs)) { reply.status(404); return { error: "Not found" }; }
    reply.type("text/javascript");
    return reply.send(fs.createReadStream(abs));
  };
  app.get("/collections-ui.js", async (_req, reply) =>
    sendJs(reply, path.join(__dirname, "collections-ui.js")));
  app.get("/descriptor/render-map.js", async (_req, reply) =>
    sendJs(reply, path.join(__dirname, "descriptor", "render-map.js")));

  // Screenshots now live OUTSIDE __dirname (under DATA_DIR), so the static root no
  // longer serves them. Stream them from screenshotsDir at the /screenshots/ prefix
  // the frontend still requests. A plain route (not a 2nd @fastify/static) avoids
  // the decorateReply double-registration crash and lets us guard path traversal.
  app.get<{ Params: { "*": string } }>("/screenshots/*", async (req, reply) => {
    const rel = path.basename(req.params["*"]); // basename → no traversal
    const abs = path.join(screenshotsDir, rel);
    if (!fs.existsSync(abs)) { reply.status(404); return { error: "Not found" }; }
    const ext = path.extname(abs).toLowerCase();
    const type =
      ext === ".png" ? "image/png" :
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
      ext === ".webp" ? "image/webp" : "application/octet-stream";
    reply.type(type);
    return reply.send(fs.createReadStream(abs));
  });

  // --- Settings: runtime-editable config (the analysis lens) ---
  // The store is a generic key/value table; this route is NOT. Only prompts may be
  // written, so an open PATCH can't scribble arbitrary keys into the same file the
  // collection lives in.
  const WRITABLE_SETTING = /^[a-z0-9-]+\.system_prompt$/;

  app.get("/api/settings", async () => ({
    settings: getAllSettings(opts.db ?? getDb()),
    // Served so the UI can show the built-in text as placeholder and offer a restore,
    // instead of making "empty" and "default" look the same.
    defaults: { "inspiration.system_prompt": DEFAULT_INSPIRATION_PROMPT },
  }));

  app.patch<{ Body: { settings?: Record<string, unknown> } }>(
    "/api/settings",
    async (req, reply) => {
      const incoming = req.body?.settings;
      if (!incoming || typeof incoming !== "object") {
        reply.status(400);
        return { error: "settings object required" };
      }
      for (const key of Object.keys(incoming)) {
        if (!WRITABLE_SETTING.test(key)) {
          reply.status(400);
          return { error: `"${key}" is not a writable setting` };
        }
        if (typeof incoming[key] !== "string") {
          reply.status(400);
          return { error: `"${key}" must be a string` };
        }
      }
      const handle = opts.db ?? getDb();
      for (const [key, value] of Object.entries(incoming)) setSetting(handle, key, value as string);
      return { settings: getAllSettings(handle) };
    }
  );

  // --- Backup: the whole collection as a streamed tar (metadata + image bytes) ---
  // Named "backup", not "archive": `archive` already means page-snapshot archival here.
  // Registered in its own plugin scope so the raw-body parser and the large body limit
  // apply ONLY to the restore route and never loosen the rest of the API.
  await app.register(async (backupApp) => {
    // Hand the request stream through untouched — a restore can be hundreds of MB and
    // must never be buffered into a string.
    backupApp.addContentTypeParser("application/x-tar", (_req, payload, done) => {
      done(null, payload);
    });

    backupApp.get("/api/backup", async (_req, reply) => {
      const stamp = new Date().toISOString().slice(0, 10);
      reply.header("Content-Type", "application/x-tar");
      reply.header("Content-Disposition", `attachment; filename="board-backup-${stamp}.tar"`);
      return reply.send(createArchiveStream(opts.db ?? getDb(), screenshotsDir));
    });

    backupApp.post(
      "/api/backup",
      // A restore is inherently large; the global 20MB limit would reject a real one.
      { bodyLimit: 4 * 1024 * 1024 * 1024 },
      async (req, reply) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-restore-"));
        const tmpTar = path.join(tmpDir, "upload.tar");
        try {
          await pipeline(req.body as NodeJS.ReadableStream, fs.createWriteStream(tmpTar));
          const { document, filesRestored } = await extractArchive(tmpTar, screenshotsDir);
          const handle = opts.db ?? getDb();
          const ctx = buildCtx({ db: handle, queue, logger, llm });
          const result = await importDocumentSkill.run({ document }, ctx);
          return { ...result, filesRestored };
        } catch (err) {
          reply.status(400);
          return { error: (err as Error).message };
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    );
  });

  // Story 5.3: live status stream (native SSE; poll fallback is the items API).
  // Optional ?boardId= scopes events to one board (the UI shows one at a time).
  app.get<{ Querystring: { boardId?: string } }>("/events", async (req, reply) => {
    startSseStream(req, reply, undefined, { boardId: req.query.boardId });
  });

  // Story 8.3: per-item curation actions on the SQLite store (board-agnostic, item
  // -scoped). PATCH only user-owned fields (notes/favorite/enrichable:false); DELETE
  // removes the item + asset rows + asset files. (REST, not skills — the v1 skill
  // list excludes these.) ctx.db is built lazily so opt-less callers never open the DB.
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/items/:id",
    async (req, reply) => {
      const handle = opts.db ?? getDb();
      const updated = await patchItemFields(handle, req.params.id, (req.body ?? {}) as Record<string, unknown>);
      if (!updated) { reply.status(404); return { error: "Not found" }; }
      return updated;
    }
  );
  app.delete<{ Params: { id: string } }>("/api/items/:id", async (req, reply) => {
    const handle = opts.db ?? getDb();
    const res = await deleteItemWithAssets(handle, req.params.id, screenshotsDir);
    if (!res.deleted) { reply.status(404); return { error: "Not found" }; }
    reply.status(204);
    return null;
  });

  // Story 8.5/8.6: the authoritative provider-configured signal (Story 4.4) — true
  // when a real LLM transport is selected, false in no-AI mode. The frontend keys
  // the "enrichment disabled" dignified state + the first-run nudge off THIS, never
  // off field-emptiness (an enabled box can legitimately return empty).
  // `provider` is the configured provider's identity (or null) so the UI can label the
  // add button and list ONLY what's wired up — never a phantom agent. Derived from the
  // same config selectProvider used, so it can't disagree with `providerConfigured`.
  app.get("/api/meta", async () => ({
    providerConfigured: llm !== disabledLlm,
    provider: llm === disabledLlm ? null : describeProvider(config),
  }));

  // Board edit actions (the "Edit board" modal). Creation is via the compose-board /
  // create-board skills; these cover rename + delete-with-cascade.
  app.patch<{ Params: { id: string }; Body: { name?: string; descriptor?: unknown } }>(
    "/api/boards/:id",
    async (req, reply) => {
      const handle = opts.db ?? getDb();
      const hasName = typeof req.body?.name === "string";
      const hasDescriptor = req.body?.descriptor !== undefined;
      if (!hasName && !hasDescriptor) { reply.status(400); return { error: "name or descriptor required" }; }
      try {
        // Descriptor first. Run the SAME composer guardrails as create/compose
        // (reserved system-column keys, duplicate keys, field cap) — validateDescriptor
        // alone only checks closed types, which would let the editor create a `notes`/
        // `title` field that collides with a system column. Then persist (single-writer).
        if (hasDescriptor) {
          const check = validateDescriptorProposal(req.body!.descriptor, {});
          if (!check.ok) {
            reply.status(400);
            return { error: check.errors.map((e) => e.message).join("; "), errors: check.errors };
          }
          try {
            await enqueueTransaction(handle, () =>
              updateBoardDescriptor(handle.db, req.params.id, req.body!.descriptor as BoardDescriptor)
            );
          } catch (err) {
            const msg = (err as Error).message;
            reply.status(/unknown board/i.test(msg) ? 404 : 400);
            return { error: msg };
          }
        }
        if (hasName) {
          const name = (req.body!.name ?? "").trim();
          if (!name) { reply.status(400); return { error: "name is required" }; }
          await renameBoard(handle, req.params.id, name);
        }
        const b = handle.db.select().from(boardsTable).where(eq(boardsTable.id, req.params.id)).get();
        return { id: b?.id, name: b?.name, view: b?.view, descriptor: b?.descriptor };
      } catch (err) {
        reply.status(404);
        return { error: (err as Error).message };
      }
    }
  );
  app.delete<{ Params: { id: string } }>("/api/boards/:id", async (req, reply) => {
    // Inbox is the system fallback board — every capture lands there first, and it's
    // the one board guaranteed to exist. Refuse to delete it so the app can never end
    // up with zero boards (the UI's "no boards" state is then purely defensive).
    if (req.params.id === INBOX_BOARD_ID) {
      reply.status(409);
      return { error: "The Inbox board can't be deleted." };
    }
    const res = await deleteBoardCascade(opts.db ?? getDb(), req.params.id, screenshotsDir);
    if (!res.deleted) { reply.status(404); return { error: "Not found" }; }
    return res;
  });

  // Batch re-run AI over a board's items (after editing fields). Enrich-only (no
  // re-capture); fire-and-forget — SSE (Story 5.3) drives the live per-item updates.
  app.post<{ Params: { id: string } }>("/api/boards/:id/reenrich", async (req, reply) => {
    const handle = opts.db ?? getDb();
    const board = handle.db.select().from(boardsTable).where(eq(boardsTable.id, req.params.id)).get();
    if (!board) { reply.status(404); return { error: "Not found" }; }
    const { queued } = reenrichBoardItems(handle, { boardId: req.params.id, llm, registry: captureRegistry });
    return { queued };
  });

  // Story 11.1: PURE LIVENESS probe — a cheap 200 with NO DB check (a DB-reachable
  // check would make it a readiness probe that flaps during a WAL checkpoint / long
  // write → systemd restart loop). A DB-reachable check, if ever wanted, is a separate
  // /readyz. Used by the systemd unit + the container healthcheck (Story 11.2).
  app.get("/healthz", async () => ({ ok: true }));

  // Story 16.3 — read-only archive footprint ({totalBytes,count} over kind='snapshot'
  // files). Surfaced for settings/board-info so "no storage limit" is never a silent
  // surprise. Read-only; mutates nothing.
  app.get("/api/archive/footprint", async () => archiveFootprint(opts.db ?? getDb(), snapshotsDir));

  app.get("/", async (_req, reply) => reply.sendFile("index.html"));

  // Story 13.2 — the bookmarklet help surface. Read-only: it serves a small page that
  // builds a draggable `javascript:` bookmarklet client-side. The instance URL is
  // derived from the request (works behind a reverse proxy); the token is NEVER
  // supplied by the server (12.1 holds only the hash) — the page ships a placeholder
  // the operator replaces with their own BOARD_API_TOKEN in the browser.
  app.get("/bookmarklet", async (req, reply) => {
    // SECURITY: `Host` is attacker-controllable. Escape it for the HTML context and
    // embed all script-side strings with `<` → < so a malicious Host can neither
    // break out of <code> nor terminate the <script> via "</script>" (JSON.stringify
    // alone does NOT escape "/"). trustProxy is off, so req.protocol is socket-derived.
    const htmlEscape = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
    const host = req.headers.host ?? `${config.host}:${config.port}`;
    const instanceUrl = `${req.protocol}://${host}`;
    const template = buildBookmarklet({ instanceUrl, token: TOKEN_PLACEHOLDER });
    const tokenConfigured = config.apiTokenHash !== null;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Board — Save bookmarklet</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;color:#222}
input{width:100%;padding:.5rem;font:inherit;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
a.bm{display:inline-block;margin:1rem 0;padding:.6rem 1rem;background:#222;color:#fff;border-radius:8px;text-decoration:none}
code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}.muted{color:#777;font-size:13px}</style>
</head><body>
<h1>Save to Board</h1>
<p>Paste your <code>BOARD_API_TOKEN</code>, then drag the button to your bookmarks bar. Clicking it on any page saves that tab to your Inbox.</p>
<input id="tok" type="text" placeholder="BOARD_API_TOKEN" autocomplete="off" spellcheck="false">
<p><a class="bm" id="bm" href="#">📥 Save to Board</a></p>
<p class="muted">Instance: <code>${htmlEscape(instanceUrl)}</code> · Server token configured: ${tokenConfigured ? "yes" : "no — set BOARD_API_TOKEN"}</p>
<p class="muted">Your token is filled in entirely in your browser; it is never sent to or stored by this page.</p>
<script>
var TEMPLATE=${scriptJson(template)},PH=${scriptJson(TOKEN_PLACEHOLDER)};
var a=document.getElementById('bm'),t=document.getElementById('tok');
function upd(){a.href=TEMPLATE.split(PH).join(t.value||PH);}
t.addEventListener('input',upd);upd();
</script>
</body></html>`;
    reply.type("text/html");
    return html;
  });

  // Story 13.3 — the PWA Web Share Target handler. The installed PWA's manifest
  // (manifest.webmanifest) declares share_target → POST /share, so any app's share
  // sheet can hand board-oss a URL. We reuse the EXACT create path the authed API uses
  // (addItemSkill → no target board → Inbox + cheap tier, Story 13.1) — not a second
  // capture path. The server holds only the token HASH (Story 12.1), so it literally
  // cannot re-POST to the bearer-guarded /api/v1/items; reusing the skill in-process is
  // the faithful equivalent. The route is intentionally unauthed — the OS share POST
  // carries no token — which matches the existing root-app posture (the SPA's own
  // /api/items and /api/collections mutations are likewise unauthed, gated by the
  // deployment's network boundary, Story 2.4). Encapsulated in its own plugin so its
  // urlencoded body parser stays scoped and the root app's JSON parser is untouched (NFR-BC).
  await app.register(async (shareApp) => {
    // The share_target posts application/x-www-form-urlencoded; parse it to a plain
    // object. Scoped to this plugin — no @fastify/formbody dependency, no root change.
    shareApp.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (err) {
          (err as { statusCode?: number }).statusCode = 400;
          done(err as Error, undefined);
        }
      },
    );

    shareApp.post<{ Body: { url?: string; text?: string; title?: string } }>(
      "/share",
      async (req, reply) => {
        const b = req.body ?? {};
        // Prefer an explicit http(s) `url`; Android frequently puts the shared link in
        // `text` (sometimes amid prose), so fall back to the first URL found in text or
        // title. A share with no resolvable URL saves nothing (cheap capture needs a URL).
        // First http(s) URL in the string, with trailing sentence punctuation trimmed
        // (shared prose like "see https://a.com." must not store the dangling dot).
        const firstUrl = (s: string | undefined) =>
          (s ?? "").match(/https?:\/\/\S+/)?.[0].replace(/[).,;:!?\]}'"]+$/, "");
        const explicit = (b.url ?? "").trim();
        const url = (/^https?:\/\//i.test(explicit) ? explicit : "") || firstUrl(b.text) || firstUrl(b.title) || "";

        const returnUser = (message: string) => {
          reply.type("text/html");
          // A tiny confirmation that returns the user where they came from (one tap,
          // zero trap): go back if there is history, else land on the app shell.
          return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Board</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0c0c0c;color:#e8e8e8}</style>
</head><body><p>${message}</p>
<script>setTimeout(function(){if(history.length>1){history.back()}else{location.replace('/')}},700)</script>
</body></html>`;
        };

        if (!url) {
          reply.status(400);
          return returnUser("Nothing to save — no link was shared.");
        }
        try {
          const handle = opts.db ?? getDb();
          const ctx = buildCtx({ db: handle, queue, logger, llm, boardId: INBOX_BOARD_ID });
          await addItemSkill.run({ boardId: INBOX_BOARD_ID, source: url }, ctx);
        } catch (err) {
          logger.error?.(`[share] capture failed: ${(err as Error).message}`);
          // Still return the user — a failed save must not trap them in the share view.
          return returnUser("Couldn’t save that link.");
        }
        return returnUser("Saved to your Inbox.");
      },
    );
  });

  // --- Collections manifest (SQLite-backed cutover) ---
  // Lists the SQLite board rows so composed boards (create-board) appear and deleted
  // boards disappear. `type` is derived (seeded ids keep their identity; composed
  // boards map by view) to pick the frontend's renderer + chrome. The seeded boards
  // exist because boot seeds them (server.ts entrypoint); tests inject a seeded db.
  app.get("/api/collections", async () => {
    const handle = opts.db ?? getDb();
    return handle.db.select().from(boardsTable).all().map((b) => ({
      id: b.id,
      name: b.name,
      view: b.view,
      type:
        b.id === INSPIRATION_BOARD_ID ? "inspiration"
        : b.id === LIBRARY_BOARD_ID ? "library"
        : b.view === "grid" ? "inspiration" : "library",
      descriptor: b.descriptor,
    }));
  });

  // --- Taxonomy (Inspiration vocabulary; unchanged) ---
  app.get("/api/taxonomy", async () =>
    JSON.parse(fs.readFileSync(TAXONOMY_FILE, "utf-8"))
  );

  // --- Collection-scoped item routes ---

  // Story 8.x CUTOVER: these are now SQLite-backed (the running app reads/writes the
  // SQLite store via the skills + item-actions built in Epics 1–10), presented to the
  // unchanged frontend renderers through the hydration adapter (db/hydrate). The
  // flat-JSON storage path is retired from the UI's data plane.

  app.get<{ Params: { cid: string } }>(
    "/api/collections/:cid/items",
    async (req) => listBoardItemsForUi(opts.db ?? getDb(), req.params.cid)
  );

  app.post<{ Params: { cid: string }; Body: { url?: string; analysisAgent?: string } }>(
    "/api/collections/:cid/items",
    async (req, reply) => {
      const url = (req.body?.url ?? "").trim();
      if (!url) { reply.status(400); return { error: "url is required" }; } // before getDb (no pollution)
      const handle = opts.db ?? getDb();
      const ctx = buildCtx({ db: handle, queue, logger, llm, boardId: req.params.cid });
      try {
        // add-item creates the pending item + (fire-and-forget) enqueues capture+enrich.
        const { itemId } = await addItemSkill.run({ boardId: req.params.cid, source: url }, ctx);
        // Return the optimistic pending item; SSE (Story 5.3) drives the live fill.
        return getItemForUi(handle, itemId) ?? { id: itemId, url, status: "pending" };
      } catch (err) {
        reply.status(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.patch<{ Params: { cid: string; id: string }; Body: PatchBody }>(
    "/api/collections/:cid/items/:id",
    async (req, reply) => {
      const handle = opts.db ?? getDb();
      const updated = await patchItemFields(handle, req.params.id, (req.body ?? {}) as Record<string, unknown>);
      if (!updated) { reply.status(404); return { error: "Not found" }; }
      return getItemForUi(handle, req.params.id);
    }
  );

  app.delete<{ Params: { cid: string; id: string } }>(
    "/api/collections/:cid/items/:id",
    async (req, reply) => {
      const handle = opts.db ?? getDb();
      const res = await deleteItemWithAssets(handle, req.params.id, screenshotsDir);
      if (!res.deleted) { reply.status(404); return { error: "Not found" }; }
      reply.status(204);
      return null;
    }
  );

  // Per-item move (Inbox triage / re-filing). Same-origin twin of the v1 assign verb
  // (api/v1.ts) — the SPA can't carry the v1 bearer token, and a move is no more
  // sensitive than the unauthed delete/patch routes beside it (gate parity). Reuses
  // assignItems (single-FK reassign + fire-and-forget earned-tier re-enrich against
  // the TARGET descriptor). UNLIKE the v1 route we do NOT await result.settled: this
  // is an interactive triage action, and blocking on serial LLM enrichment would make
  // it sluggish; the target board fetches fresh fields on navigation. An unknown
  // target board (incl. any view id — views live in a separate table, never in
  // `boards`) throws → 400; an unknown item → 404.
  app.post<{ Params: { cid: string; id: string }; Body: { boardId?: string } }>(
    "/api/collections/:cid/items/:id/move",
    async (req, reply) => {
      const boardId = (req.body?.boardId ?? "").trim();
      if (!boardId) { reply.status(400); return { error: "boardId is required" }; }
      const handle = opts.db ?? getDb();
      try {
        const result = await assignItems(handle, {
          itemIds: [req.params.id],
          boardId,
          llm,
          registry: captureRegistry,
          enqueueSnapshot: opts.enqueueSnapshot, // archives-on-promote boards snapshot the moved item
        });
        if (result.notFound.length) { reply.status(404); return { error: "Not found" }; }
        return { assigned: result.assigned, skipped: result.skipped, failed: result.failed };
      } catch (err) {
        reply.status(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.post<{ Params: { cid: string; id: string }; Body: { instructions?: string; analysisAgent?: string } }>(
    "/api/collections/:cid/items/:id/refetch",
    async (req) => {
      const handle = opts.db ?? getDb();
      // Fire-and-forget refetch (capture+enrich); SSE drives the live update. Guarded
      // so an unknown-item rejection can't crash the worker (Story 7.3 review).
      void refetchItem(handle, { itemId: req.params.id, registry: captureRegistry, llm, screenshotsDir })
        .catch((e) => logger.error(`refetch "${req.params.id}" failed to start: ${(e as Error).message}`));
      return getItemForUi(handle, req.params.id) ?? { id: req.params.id, status: "processing" };
    }
  );

  // Manual image upload → SQLite asset (works for composed boards too).
  app.post<{ Params: { cid: string; id: string }; Body: { dataUrl?: string } }>(
    "/api/collections/:cid/items/:id/screenshot",
    async (req, reply) => handleScreenshot(opts.db ?? getDb(), req.params.id, req.body, reply, screenshotsDir)
  );

  // --- Legacy aliases (delegate to collection handlers with cid="inspiration") ---

  app.get("/api/bookmarks", async () => loadCollection<Bookmark>("inspiration"));

  app.post<{ Body: { url?: string; analysisAgent?: string } }>(
    "/api/add",
    async (req, reply) => handleAddItem("inspiration", req.body, reply)
  );

  app.patch<{ Params: { id: string }; Body: PatchBody }>(
    "/api/bookmarks/:id",
    async (req, reply) => handlePatchItem("inspiration", req.params.id, req.body, reply)
  );

  app.delete<{ Params: { id: string } }>(
    "/api/bookmarks/:id",
    async (req, reply) => handleDeleteItem("inspiration", req.params.id, reply, screenshotsDir)
  );

  app.post<{ Params: { id: string }; Body: { instructions?: string; analysisAgent?: string } }>(
    "/api/refetch/:id",
    async (req, reply) => handleRefetchItem("inspiration", req.params.id, req.body, reply)
  );

  app.post<{ Params: { id: string }; Body: { dataUrl?: string } }>(
    "/api/bookmarks/:id/screenshot",
    async (req, reply) => handleScreenshot(opts.db ?? getDb(), req.params.id, req.body, reply, screenshotsDir)
  );

  // --- Story 3.2: the ONE generic skill-invocation route (AD11/FR-19) ---
  // Adding a capability = registering a Skill, not adding a bespoke route.
  const registry = opts.registry ?? (() => {
    const r = createRegistry();
    registerAllSkills(r);
    return r;
  })();
  const logger: Logger = opts.logger ?? console;
  const queue: JobQueue = opts.queue ?? { enqueueWrite };
  // Story 4.4: pick the transport from config (or disabledLlm = no-AI default).
  const llm: LLMProvider = opts.llm ?? selectProvider(config);

  app.post<{ Params: { name: string }; Body: unknown }>(
    "/skills/:name",
    async (req, reply) => {
      const skill = registry.get(req.params.name);
      if (!skill) {
        reply.status(404);
        return { error: `Unknown skill: "${req.params.name}"` };
      }

      // Input validation = 400 (client error); run is NOT called on failure.
      const parsedInput = skill.inputSchema.safeParse(req.body);
      if (!parsedInput.success) {
        reply.status(400);
        return { error: "Invalid skill input", issues: parsedInput.error.issues };
      }

      // ctx is built lazily here (per request) so opt-less buildServer() callers
      // that never hit /skills never open the real DB.
      // Only accept a real string boardId; a null/numeric/missing value → undefined
      // (don't coerce `null` to the string "null").
      const rawBoardId =
        req.body && typeof req.body === "object"
          ? (req.body as { boardId?: unknown }).boardId
          : undefined;
      const boardId = typeof rawBoardId === "string" && rawBoardId.length > 0 ? rawBoardId : undefined;
      const ctx = buildCtx({ db: opts.db ?? getDb(), queue, logger, llm, boardId });

      let result: unknown;
      try {
        result = await skill.run(parsedInput.data, ctx);
      } catch (err) {
        // Skill bug / runtime failure = 500. Log server-side; never leak the
        // stack/message to the client body.
        logger.error(`skill "${skill.name}" threw: ${(err as Error).message}`);
        reply.status(500);
        return { error: "Skill execution failed" };
      }

      // Output validation = 500 (the skill is broken, distinct from the 400 case).
      const parsedOutput = skill.outputSchema.safeParse(result);
      if (!parsedOutput.success) {
        logger.error(`skill "${skill.name}" produced invalid output`);
        reply.status(500);
        return { error: "Skill produced invalid output" };
      }
      return parsedOutput.data;
    }
  );

  // Story 12.1 — the encapsulated /api/v1 surface (bearer guard + CORS). Registered
  // as a prefixed plugin so its hook/CORS apply ONLY to v1 routes (NFR-BC). The token
  // is injectable for hermetic tests; production defaults to the configured hash.
  // undefined → use the configured hash; any falsy-but-defined value ("" or null) →
  // fail-closed null; otherwise hash the injected plaintext.
  const apiTokenHash =
    opts.apiToken === undefined
      ? config.apiTokenHash
      : opts.apiToken
        ? sha256Hex(opts.apiToken)
        : null;
  await registerV1Api(app, {
    apiTokenHash,
    corsOrigins: opts.corsOrigins ?? config.corsOrigins,
    // Story 12.2 — CRUD collaborators. resolveDb is lazy (opts.db ?? getDb()) so
    // opt-less callers/tests never open the real DB; queue/logger/llm are the same
    // instances the rest of the app uses (one store, one set of helpers — NFR-BC).
    resolveDb: () => opts.db ?? getDb(),
    queue,
    logger,
    llm,
    screenshotsDir,
    enqueueSnapshot: opts.enqueueSnapshot,
  });

  return app;
}

// Entrypoint guard — only listen when run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureDataDir(); // Story 2.2: create DATA_DIR + screenshots on real boot (AC 2)
  // Story 1.2/8.6: idempotently seed the boards on EVERY boot so a fresh DATA_DIR
  // (container / LXC first-run) has the Inspiration + Library boards — without this,
  // zero-config first-run (UJ-3/SM-1) and any add-item/capture 500 with "unknown board".
  seed(getDb().db);
  // Story 5.2: sweep items orphaned in `processing` by a crash/OOM before serving.
  reconcileInterruptedItems(getDb());
  // Story 6.1: register capture adapters (6.2–6.4 populate the registry).
  registerAllCaptureAdapters(captureRegistry);
  const app = await buildServer();
  // Story 2.4: bind is config-driven; default HOST (2.1) is 127.0.0.1 (secure
  // default — only an explicit non-empty HOST exposes it).
  const listenOpts = getListenOptions();
  warnIfExposed(listenOpts);
  await app.listen(listenOpts);
  console.log(`🎨  Board running at http://${listenOpts.host}:${listenOpts.port}`);
}
