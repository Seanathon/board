import type { RadiatorRuntimeOptions } from '../radiator/runtime.js';
import cors from "@fastify/cors";
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/index.js";
import { eq } from "drizzle-orm";
import { boards, items } from "../db/schema.js";
import { runSnapshotJob } from "../capture/url-snapshot.js";
import { getItemForUi, listItemsForApi } from "../db/hydrate.js";
import { patchItemFields, deleteItemWithAssets } from "../db/item-actions.js";
import { addItemSkill } from "../skills/add-item.js";
import { INBOX_BOARD_ID } from "../db/seed.js";
import { captureRegistry } from "../capture/adapter.js";
import { assignItems } from "../enrichment/assign.js";
import { suggestBoardForItem } from "../enrichment/suggest.js";
import { recordAssignmentChoice } from "../db/suggestion-override.js";
import { buildCtx, disabledLlm, type JobQueue, type LLMProvider, type Logger } from "../skills/types.js";

// Story 12.1 — the encapsulated `/api/v1` surface: a static bearer-token guard +
// CORS, both scoped to this plugin's routes only. Registering with a prefix gives
// Fastify-level encapsulation: the onRequest hook and CORS added INSIDE this plugin
// cannot reach the root app's routes (SPA, legacy /api/bookmarks, /api/collections,
// /skills). That structural boundary is how NFR-BC is guaranteed, not merely intended.
//
// 12.2 registers the CRUD routes inside this same plugin (behind this guard). 12.1
// ships a trivial GET /api/v1/ping probe so the surface is testable before CRUD lands.

export interface V1Options {
  /** SHA-256 hash (hex) of the configured bearer token, or null when unconfigured. */
  apiTokenHash: string | null;
  /** Allowlisted cross-origin origins; empty = no cross-origin allowed. */
  corsOrigins: string[];
  /**
   * Story 12.2 — CRUD collaborators. `resolveDb` is lazy (the established
   * `opts.db ?? getDb()` pattern) so opt-less callers never open the real DB.
   * All CRUD reuses existing helpers — no parallel write path (NFR-BC).
   */
  resolveDb: () => DbHandle;
  queue: JobQueue;
  logger: Logger;
  llm: LLMProvider;
  radiator?: RadiatorRuntimeOptions;
  screenshotsDir: string;
  /**
   * Story 16.2 — injectable archival snapshot enqueue (tests spy so no Chrome runs).
   * Used by the per-item archive action AND threaded into the assign verb's trigger.
   * Defaults to fire-and-forget the 16.1 snapshot job on the single worker.
   */
  enqueueSnapshot?: (args: { itemId: string; url: string | null }) => void;
}

/** SHA-256 hex of a string. Exported so the server can hash an injected test token. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header, or null.
 * The scheme match is case-insensitive (RFC 7235 auth schemes are case-insensitive);
 * the token itself is not whitespace-normalized (an exact-match secret).
 */
function extractBearer(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Constant-time compare of two SHA-256 hex digests. Both are fixed-length (64
 * chars), so the buffers are always equal length — no length-based early exit,
 * no timing oracle. Returns false if either side is missing.
 */
function hashesMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Register the encapsulated `/api/v1` plugin on `app`. The bearer guard + CORS live
 * inside the prefixed child context, so they apply to v1 routes only.
 */
export async function registerV1Api(app: FastifyInstance, opts: V1Options): Promise<void> {
  await app.register(
    async (v1) => {
      // CORS scoped to v1 only. Empty allowlist → `origin: false` (no cross-origin).
      await v1.register(cors, {
        origin: opts.corsOrigins.length > 0 ? opts.corsOrigins : false,
      });

      // Tolerant JSON body parsing scoped to v1: an empty body with a reflexive
      // `content-type: application/json` (common for fetch-based DELETE/PATCH clients)
      // parses to undefined instead of Fastify's default 400. Encapsulated to this
      // plugin — the root app's parser is unchanged (NFR-BC).
      v1.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
        const text = (body as string).trim();
        if (text.length === 0) {
          done(null, undefined);
          return;
        }
        try {
          done(null, JSON.parse(text));
        } catch (err) {
          (err as { statusCode?: number }).statusCode = 400;
          done(err as Error, undefined);
        }
      });

      // Bearer guard. Fail-closed: if no token is configured, the v1 surface rejects
      // everything (you cannot authenticate against an unset secret).
      v1.addHook("onRequest", async (req, reply) => {
        const provided = extractBearer(req.headers.authorization);
        const providedHash = provided ? sha256Hex(provided) : null;
        if (!hashesMatch(providedHash, opts.apiTokenHash)) {
          reply.code(401).send({ error: "Unauthorized" });
          return reply; // short-circuit — the route handler never runs
        }
      });

      // Story 16.2 — the archival enqueue (injectable for tests). Default: fire-and-forget
      // the 16.1 snapshot job on the single worker (status-neutral, graceful). Used by the
      // per-item archive action AND threaded into the assign verb's opt-in trigger.
      const enqueueSnapshot =
        opts.enqueueSnapshot ??
        ((a: { itemId: string; url: string | null }) => {
          if (a.url) void runSnapshotJob(opts.resolveDb(), { itemId: a.itemId, url: a.url });
        });

      // Trivial liveness probe so 12.1 has a guarded target (12.2 adds CRUD here).
      v1.get("/ping", async () => ({ ok: true }));

      // --- Story 12.2: token-authed CRUD over items + the board list ---
      // The stable contract every capture client (bookmarklet/PWA/extension) speaks.
      // REUSES the existing helpers verbatim (addItemSkill, the single-writer queue,
      // patchItemFields, deleteItemWithAssets) — no parallel write path, no new
      // delete/cleanup logic. Only the filtered list query (listItemsForApi) is new.

      // POST /items — create-from-URL, optimistic pending (async capture on the queue).
      v1.post<{ Body: { url?: string; boardId?: string } }>("/items", async (req, reply) => {
        const url = (req.body?.url ?? "").trim();
        if (!url) {
          reply.code(400);
          return { error: "url is required" };
        }
        // Story 13.1 — an omitted/blank target board defaults to the Inbox (the
        // capture funnel: save anything without deciding where it goes). A *provided*
        // unknown board still errors via addItemSkill's existence check below.
        const rawBoardId = typeof req.body?.boardId === "string" ? req.body.boardId.trim() : "";
        const boardId = rawBoardId || INBOX_BOARD_ID;
        const handle = opts.resolveDb();
        const ctx = buildCtx({
          db: handle,
          queue: opts.queue,
          logger: opts.logger,
          llm: opts.llm,
          radiator: opts.radiator,
          boardId,
        });
        try {
          const { itemId } = await addItemSkill.run({ boardId, source: url }, ctx);
          reply.code(201);
          return getItemForUi(handle, itemId) ?? { id: itemId, url, status: "pending" };
        } catch (err) {
          // Unknown board (FK insert fails) / invalid input → client error.
          reply.code(400);
          return { error: (err as Error).message };
        }
      });

      // GET /items — newest-first, filtered + paginated (recent-additions feed).
      v1.get<{
        Querystring: {
          board?: string;
          status?: string;
          since?: string;
          limit?: string;
          offset?: string;
        };
      }>("/items", async (req) => {
        const q = req.query;
        // Coerce to a finite number or drop to undefined — a junk param (?limit=abc)
        // must NOT produce NaN (which would yield a degenerate LIMIT NaN → 500, or a
        // silently-empty `since` filter). Malformed → ignored, not an error.
        const num = (v: string | undefined) => {
          if (v === undefined || v === "") return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        return listItemsForApi(opts.resolveDb(), {
          boardId: q.board,
          status: q.status,
          since: num(q.since),
          limit: num(q.limit),
          offset: num(q.offset),
        });
      });

      // PATCH /items/:id — user-field allowlist (reuses 8.3; disallowed keys ignored).
      v1.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
        "/items/:id",
        async (req, reply) => {
          const handle = opts.resolveDb();
          const updated = await patchItemFields(
            handle,
            req.params.id,
            (req.body ?? {}) as Record<string, unknown>,
          );
          if (!updated) {
            reply.code(404);
            return { error: "Not found" };
          }
          return getItemForUi(handle, req.params.id);
        },
      );

      // DELETE /items/:id — row cascade + asset-FILE unlink (reuses 8.3; no orphans).
      v1.delete<{ Params: { id: string } }>("/items/:id", async (req, reply) => {
        const res = await deleteItemWithAssets(opts.resolveDb(), req.params.id, opts.screenshotsDir);
        if (!res.deleted) {
          reply.code(404);
          return { error: "Not found" };
        }
        reply.code(204);
        return null;
      });

      // POST /items/assign — the ONE assign verb (Story 14.2). Thin adapter over the
      // shared `assignItems` helper (the same path the composer 15.2 reuses): single-FK
      // move to the target board THEN earned-tier enrich against the target descriptor.
      // Batch-capable. Awaits the earned enrichment so the manual caller gets the
      // settled (enriched) result; the bulk composer calls the helper directly and may
      // fire-and-forget instead.
      v1.post<{ Body: { itemIds?: unknown; boardId?: unknown } }>("/items/assign", async (req, reply) => {
        const rawIds = req.body?.itemIds;
        const itemIds = Array.isArray(rawIds)
          ? rawIds.filter((x): x is string => typeof x === "string" && x.length > 0)
          : [];
        const boardId = typeof req.body?.boardId === "string" ? req.body.boardId.trim() : "";
        if (itemIds.length === 0) {
          reply.code(400);
          return { error: "itemIds (a non-empty array of strings) is required" };
        }
        // Defensive cap on the manual route: it awaits enrichment (below), which runs
        // serially on the single writer, so an unbounded batch could block/timeout the
        // response. The bulk composer (15.2) calls assignItems directly (no cap, fire-
        // and-forget). 200 is far above any manual triage.
        if (itemIds.length > 200) {
          reply.code(400);
          return { error: "too many itemIds (max 200 per request); use the composer for bulk assignment" };
        }
        if (!boardId) {
          reply.code(400);
          return { error: "boardId is required" };
        }
        try {
          const result = await assignItems(opts.resolveDb(), {
            itemIds,
            boardId,
            llm: opts.llm,
          radiator: opts.radiator,
            registry: captureRegistry,
            enqueueSnapshot, // Story 16.2 — opt-in archival fires here iff the target board is flagged
          });
          await result.settled; // manual assign returns the enriched result
          return {
            assigned: result.assigned,
            skipped: result.skipped,
            notFound: result.notFound,
            failed: result.failed,
          };
        } catch (err) {
          reply.code(400);
          return { error: (err as Error).message };
        }
      });

      // GET /items/:id/suggestion — Story 14.3 READ-ONLY suggested home board for an
      // Inbox item. Returns {suggestedBoardId: null} when no provider is configured or
      // a suggestion can't be computed → the client shows the manual picker. Never
      // mutates the item.
      v1.get<{ Params: { id: string } }>("/items/:id/suggestion", async (req) => {
        const providerConfigured = opts.llm !== disabledLlm;
        return suggestBoardForItem(opts.resolveDb(), {
          itemId: req.params.id,
          llm: opts.llm,
          providerConfigured,
        });
      });

      // POST /suggestions/override — Story 14.3 records an assignment CHOICE as a
      // future-suggestion-quality signal (additive store). The move itself goes through
      // the 14.2 assign verb; this only captures suggested-vs-chosen. A confirm (chosen
      // === suggested) or a manual pick (no suggestion) records nothing.
      v1.post<{ Body: { itemId?: unknown; suggestedBoardId?: unknown; chosenBoardId?: unknown } }>(
        "/suggestions/override",
        async (req, reply) => {
          const itemId = typeof req.body?.itemId === "string" ? req.body.itemId : "";
          const chosenBoardId = typeof req.body?.chosenBoardId === "string" ? req.body.chosenBoardId : "";
          if (!itemId || !chosenBoardId) {
            reply.code(400);
            return { error: "itemId and chosenBoardId are required" };
          }
          const suggestedBoardId =
            typeof req.body?.suggestedBoardId === "string" ? req.body.suggestedBoardId : null;
          return recordAssignmentChoice(opts.resolveDb(), { itemId, suggestedBoardId, chosenBoardId });
        },
      );

      // POST /items/:id/archive — Story 16.2 per-item "archive this" action. A REST
      // action (NOT a skill — the v1 skill list is fixed, Story 8.3), sibling to the
      // per-item notes/favorite/delete. Enqueues exactly one 16.1 snapshot for the item
      // (status-neutral, graceful); returns 202 without blocking on the capture. Unknown
      // item → 404. Items with no source URL can't be snapshotted → 422.
      v1.post<{ Params: { id: string } }>("/items/:id/archive", async (req, reply) => {
        const item = opts.resolveDb().db.select().from(items).where(eq(items.id, req.params.id)).get();
        if (!item) {
          reply.code(404);
          return { error: "Not found" };
        }
        if (!item.source) {
          reply.code(422);
          return { error: "item has no source URL to archive" };
        }
        enqueueSnapshot({ itemId: item.id, url: item.source });
        reply.code(202);
        return { queued: true };
      });

      // GET /boards — lean targeting list ({id,name,view}); no descriptor needed.
      v1.get("/boards", async () =>
        opts.resolveDb().db.select({ id: boards.id, name: boards.name, view: boards.view }).from(boards).all(),
      );
    },
    { prefix: "/api/v1" },
  );
}
