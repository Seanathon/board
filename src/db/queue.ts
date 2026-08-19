import { eq, sql } from 'drizzle-orm';

import { assets, boards, items, type NewAsset, type NewItem } from './schema.js';
import { buildSearchBlob } from './search-blob.js';
import { EnrichmentDisabledError } from '../skills/types.js';
import { statusHub } from '../sse.js';
import type { BoardDescriptor } from '../descriptor/types.js';
import type { DbHandle } from './index.js';

// Story 1.3 — the single-writer queue (write-safety spine).
//
// All writes serialize through one async worker so two write *operations* never
// interleave — preventing logical write races (lost updates) that `busy_timeout`
// alone cannot. `better-sqlite3` is synchronous per call; the serialization here
// orders *logical* operations that have an `await` between read and write.
//
// READS DO NOT GO THROUGH THE WRITER. WAL allows concurrent readers + one writer;
// routing reads through the queue would serialize everything and kill the browse /
// SSE read path. Only writes serialize.
//
// TWO LANES, NOT ONE (revises AD6's "one serializer, not two").
//
// Jobs used to run on this same chain, so a capture held the WRITE lane for its whole
// duration (Chrome launch + LLM round-trip). That made every interactive write wait on
// unrelated network I/O: `addItemSkill`'s one-row INSERT — and so POST /api/collections
// /:cid/items — blocked for the length of the running capture (measured: 42s with one
// job in flight; up to CAPTURE_TIMEOUT_MS), which read to users as the add
// silently hanging.
//
// The two constraints being collapsed were never the same constraint:
//   • concurrency 1 for JOBS — Chromium is ~400-520MB resident, so two concurrent
//     captures OOM the 512MB-1GB LXC (NFR-1/C1). Bounds MEMORY.
//   • single-writer for SQLITE (AD6) — orders logical read-modify-writes. Bounds
//     WRITE INTERLEAVING, and every such write is sub-millisecond.
// Separate lanes honor both: jobs still run strictly one at a time, and a write never
// queues behind one. Writes issued from inside a job go through `enqueueWrite` like any
// other — with the lanes split that no longer deadlocks (see `writeItemDirect`).
type Lane = { tail: Promise<unknown> };

// A promise chain is the serializer: each enqueued op waits for the previous to
// settle. Errors are swallowed from the *chain* (so one failure can't wedge the
// queue) but propagated to the *caller* via the returned promise.
const writeLane: Lane = { tail: Promise.resolve() };
const jobLane: Lane = { tail: Promise.resolve() };

function serialize<T>(lane: Lane, fn: () => T | Promise<T>): Promise<T> {
  const run = lane.tail.then(() => fn());
  lane.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Serialize a write operation. Returns a promise resolving with `fn`'s result (or
 * rejecting with its error). Only one `fn` runs at a time, in enqueue order.
 */
export function enqueueWrite<T>(fn: () => T | Promise<T>): Promise<T> {
  return serialize(writeLane, fn);
}

// --- Story 5.1: the JOB layer, on its OWN lane ---
//
// Capture/enrichment jobs (Epics 6/7) run here, serially (concurrency 1) — a job holds
// the job slot for its full duration (Chrome launch + LLM round-trip) and never
// overlaps another job. It does NOT hold the write lane; see the two-lane note above.
//
// Concurrency 1 is load-bearing: Chromium is ~400-520MB resident, so two concurrent
// captures OOM the 512MB-1GB LXC (NFR-1/C1).

/** A schedulable unit of work. `run` receives an AbortSignal it must honor. */
export interface Job {
  type: string;
  timeoutMs: number;
  run(signal: AbortSignal): Promise<void> | void;
  /**
   * Optional teardown awaited (after a timeout abort) BEFORE the worker releases the
   * slot — the 5.1↔6.5 seam: a timed-out capture's browser must be force-closed
   * (Story 6.5) and its memory released before the next memory-heavy job starts, so
   * two Chromiums never coexist (AC3). Status is marked failed immediately; only the
   * SLOT release waits on this.
   */
  teardown?: (signal: AbortSignal) => Promise<void>;
}

export interface JobResult {
  type: string;
  ok: boolean;
  timedOut?: boolean;
  error?: string;
}

/** Schedule a timeout; returns a cancel fn. Injectable for deterministic tests. */
export type TimeoutFn = (cb: () => void, ms: number) => () => void;

const defaultTimeoutFn: TimeoutFn = (cb, ms) => {
  const t = setTimeout(cb, ms);
  if (typeof t.unref === 'function') t.unref();
  return () => clearTimeout(t);
};

/**
 * Enqueue a job on the single worker. Returns its result (resolves when the job
 * finishes, fails, or times out). On timeout: fires the AbortController signal,
 * resolves the result as failed immediately, then holds the worker slot until the
 * job's optional `teardown` completes (so the next job can't start until memory is
 * released). Runs on the same serializer as `enqueueWrite` — concurrency 1.
 */
export function enqueueJob(job: Job, opts?: { timeoutFn?: TimeoutFn }): Promise<JobResult> {
  const timeoutFn = opts?.timeoutFn ?? defaultTimeoutFn;
  let resolveStatus!: (r: JobResult) => void;
  const status = new Promise<JobResult>((r) => (resolveStatus = r));

  serialize(jobLane, async () => {
    const controller = new AbortController();
    let settled = false;

    // Resolve with the job's outcome AND, on timeout, a teardown thunk the slot must
    // await. The thunk (not an already-invoked promise) is run later inside a guarded
    // await so a misbehaving teardown — even a synchronous throw — can't wedge the
    // worker chain.
    const outcome = await new Promise<{ result: JobResult; runTeardown?: () => Promise<void> | void }>((resolve) => {
      const cancel = timeoutFn(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        resolve({
          result: { type: job.type, ok: false, timedOut: true, error: `Job "${job.type}" timed out after ${job.timeoutMs}ms` },
          runTeardown: job.teardown ? () => job.teardown!(controller.signal) : undefined,
        });
      }, job.timeoutMs);

      Promise.resolve()
        .then(() => job.run(controller.signal))
        .then(
          () => { if (settled) return; settled = true; cancel(); resolve({ result: { type: job.type, ok: true } }); },
          (err: unknown) => { if (settled) return; settled = true; cancel(); resolve({ result: { type: job.type, ok: false, error: String((err as Error)?.message ?? err) } }); },
        );
    });

    resolveStatus(outcome.result); // mark failed/done immediately (status purpose)
    if (outcome.runTeardown) {
      // SLOT held until memory released (AC3); never let a bad teardown wedge the queue.
      try {
        await outcome.runTeardown();
      } catch {
        /* teardown failure must not block the worker */
      }
    }
  });

  return status;
}

/**
 * Serialize an ATOMIC write: `fn` runs inside a single better-sqlite3 transaction,
 * so a partway throw rolls back every step (NFR-2). `fn` must be synchronous (the
 * transaction boundary is synchronous in better-sqlite3).
 */
export function enqueueTransaction<T>(handle: DbHandle, fn: () => T): Promise<T> {
  return enqueueWrite(() => handle.sqlite.transaction(fn)());
}

/**
 * The single typed item-write choke-point. ALL item inserts/updates flow through
 * here, inside the serialized writer's transaction. `item` is treated as the full
 * desired state of the row (search_blob is recomputed from the fields provided).
 *
 * Inside the transaction it (1) upserts the item row, (2) recomputes `search_blob`
 * from the board's descriptor (descriptor-driven; safe fallback if absent), (3)
 * re-syncs the FTS5 row, and (4) — when `itemAssets` is provided — REPLACES the
 * item's assets with that list. All steps are atomic with each other — a partway
 * throw rolls back all of them — so the index can never drift from the row.
 *
 * `itemAssets` semantics: `undefined` leaves existing assets untouched (the FTS-only
 * callers from 1.4); an array (incl. `[]`) replaces them (idempotent re-import).
 */
export function writeItem(handle: DbHandle, item: NewItem, itemAssets?: NewAsset[]): Promise<void> {
  return enqueueWrite(() => writeItemDirect(handle, item, itemAssets));
}

/**
 * The DIRECT item write (transaction + search_blob + FTS + optional asset replace),
 * with NO enqueue. Synchronous, so it is atomic on its own; what it does NOT get is
 * ordering against other writers.
 *
 * It exists for callers that must do `read → write` with no await between them —
 * `writeItemDirect` takes the FULL desired row, so a merge assembled from a stale
 * snapshot would revert whatever landed in between. Those callers wrap BOTH steps in a
 * single `enqueueWrite` and use this inside it (see capture/adapter.ts and
 * enrichment/worker.ts). That wrapping is what gives them ordering; calling this bare
 * skips the write lane.
 *
 * It used to exist for a different reason — jobs shared the write lane, so a job that
 * called the enqueueing `writeItem` self-deadlocked (the inner `enqueueWrite` waited on
 * the slot the job itself held). The lanes are separate now, so that deadlock is gone
 * and job code can enqueue writes freely. Other callers (importer, skills, routes) use
 * `writeItem`, which wraps this in the queue.
 */
export function writeItemDirect(handle: DbHandle, item: NewItem, itemAssets?: NewAsset[]): void {
  handle.sqlite.transaction(() => {
    const board = handle.db.select().from(boards).where(eq(boards.id, item.boardId)).get();
    const descriptor = (board?.descriptor as BoardDescriptor | undefined) ?? undefined;
    const searchBlob = buildSearchBlob(
      { title: item.title ?? null, notes: item.notes ?? null, fields: (item.fields as Record<string, unknown>) ?? null },
      descriptor,
    );

    const row = { ...item, searchBlob };
    const { id: _id, ...updatable } = row;
    handle.db.insert(items).values(row).onConflictDoUpdate({ target: items.id, set: updatable }).run();

    // Re-sync FTS5: delete any existing row for this item, then re-insert if the
    // blob is non-empty. Keyed on item_id (UNINDEXED column on the standalone table).
    handle.sqlite.prepare('DELETE FROM item_fts WHERE item_id = ?').run(item.id);
    if (searchBlob.length > 0) {
      handle.sqlite.prepare('INSERT INTO item_fts (item_id, search_blob) VALUES (?, ?)').run(item.id, searchBlob);
    }

    if (itemAssets !== undefined) {
      handle.db.delete(assets).where(eq(assets.itemId, item.id)).run();
      for (const a of itemAssets) handle.db.insert(assets).values(a).run();
    }
  })();
}

// --- Story 5.2: item status lifecycle (pending → processing → done | error) ---

type ItemStatus = 'pending' | 'processing' | 'done' | 'error';

/**
 * Set an item's status directly (no enqueue). MUST be called only from inside a job
 * that already holds the worker slot — otherwise use the queue. Synchronous
 * better-sqlite3 write; immediately visible to subsequent reads on the connection.
 */
function setItemStatusDirect(handle: DbHandle, id: string, status: ItemStatus, errorReason: string | null): void {
  handle.db
    .update(items)
    .set({ status, errorReason, updatedAt: sql`(unixepoch())` })
    .where(eq(items.id, id))
    .run();

  // Story 5.3: publish the transition for live SSE. `fields` is included on `done`
  // so the client renders the filled card without a refetch (8.4 contract).
  const row = handle.db.select().from(items).where(eq(items.id, id)).get();
  if (row) {
    statusHub.publish({
      itemId: id,
      boardId: row.boardId,
      status,
      error_reason: errorReason ?? undefined,
      fields: status === 'done' ? ((row.fields as Record<string, unknown>) ?? {}) : undefined,
    });
  }
}

/**
 * Map a thrown error to a SHORT, user-safe `error_reason` — never a raw stack or
 * secret-bearing string (NFR-3; rendered by Story 8.5). Classified by error name so
 * the storage layer stays decoupled from llm/.
 */
export function cleanErrorReason(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'LLMTransportError') return 'could not reach the AI provider';
  if (name === 'LLMSchemaError') return 'AI returned invalid output';
  const msg = String((err as Error)?.message ?? '');
  if (/timed out|timeout/i.test(msg)) return 'timed out';
  return 'processing failed';
}

export interface RunItemJobArgs {
  itemId: string;
  type: string;
  timeoutMs: number;
  work: (signal: AbortSignal) => Promise<void> | void;
  teardown?: (signal: AbortSignal) => Promise<void>;
  timeoutFn?: TimeoutFn;
}

/**
 * Run a unit of work for an item, driving its status lifecycle on the single worker:
 * `processing` at start → `done` on success → `error` (+ clean reason) on a thrown
 * failure. `EnrichmentDisabledError` is classified as `done` (NOT error) so a no-AI
 * install shows dignified un-enriched cards, not error cards (Story 4.4 hand-off).
 *
 * The in-job `try/catch` lands a terminal status for throw/disabled while the slot
 * is held. A 5.1 TIMEOUT abandons the (possibly hung) work — its terminal `error`
 * status is written here, after the job result, so an item is never stuck
 * `processing`. (A hard crash/OOM where neither runs is swept by
 * `reconcileInterruptedItems` at boot.)
 *
 * The status writes below stay DIRECT (not enqueued) deliberately. They are
 * single-column updates, not read-modify-writes, so they are already atomic — and each
 * is guarded by a synchronous `signal.aborted` check that must not be separated from
 * its write. Enqueueing them would put an await between the check and the write, giving
 * abandoned work a window to clobber the timeout path's terminal `error` back to `done`
 * — the exact thing that guard exists to prevent.
 */
export async function runItemJob(handle: DbHandle, args: RunItemJobArgs): Promise<JobResult> {
  const job: Job = {
    type: args.type,
    timeoutMs: args.timeoutMs,
    teardown: args.teardown,
    run: async (signal) => {
      setItemStatusDirect(handle, args.itemId, 'processing', null);
      try {
        await args.work(signal);
        // If the job already timed out, the timeout path OWNS the terminal status —
        // a late-settling abandoned work must NOT clobber `error` back to `done`.
        if (signal.aborted) return;
        setItemStatusDirect(handle, args.itemId, 'done', null);
      } catch (err) {
        if (signal.aborted) return; // timeout already wrote the terminal status
        if (err instanceof EnrichmentDisabledError) {
          setItemStatusDirect(handle, args.itemId, 'done', null); // disabled = done, not error
        } else {
          setItemStatusDirect(handle, args.itemId, 'error', cleanErrorReason(err));
        }
        // swallowed: the terminal status is recorded; the job itself "succeeded" at
        // managing status.
      }
    },
  };

  const result = await enqueueJob(job, { timeoutFn: args.timeoutFn });

  // Timeout: the work was abandoned (possibly still `processing`) — record the
  // terminal error status through the writer so the item is never stuck.
  if (result.timedOut) {
    await enqueueWrite(() => setItemStatusDirect(handle, args.itemId, 'error', 'timed out'));
  }
  return result;
}

/**
 * Boot reconciliation (Story 5.2 AC4): move any item left `processing` by a hard
 * crash / OOM-kill (where the in-job `finally` never ran) to `error` with reason
 * "interrupted". The ONLY mechanism that honors C4's "never stuck processing" for
 * the crash case. Idempotent; indexed on `status`. Returns the number reconciled.
 */
export function reconcileInterruptedItems(handle: DbHandle): number {
  const res = handle.db
    .update(items)
    .set({ status: 'error', errorReason: 'interrupted', updatedAt: sql`(unixepoch())` })
    .where(eq(items.status, 'processing'))
    .run();
  return res.changes;
}

/**
 * Delete an item, its asset rows, and its FTS row atomically through the single
 * writer. The `asset.item_id` FK has no ON DELETE CASCADE, so the asset rows MUST be
 * removed first (else deleting an item that has assets fails the FK constraint).
 */
export function deleteItem(handle: DbHandle, id: string): Promise<void> {
  return enqueueTransaction(handle, () => {
    handle.db.delete(assets).where(eq(assets.itemId, id)).run();
    handle.db.delete(items).where(eq(items.id, id)).run();
    handle.sqlite.prepare('DELETE FROM item_fts WHERE item_id = ?').run(id);
  });
}
