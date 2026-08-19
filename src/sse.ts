// Story 5.3 — in-process SSE status hub + framing + the stream wiring.
//
// Native SSE (no WebSocket, no broker — AD6/FR-18): one-way server→client push of
// item status transitions over plain HTTP. Single Node process → an in-process
// subscriber Set is sufficient. The frontend also has a poll fallback (the items
// API), so no state is SSE-only.

export interface StatusEvent {
  itemId: string;
  boardId: string;
  status: string;
  error_reason?: string;
  /** Populated on `done` so Story 8.4 renders the filled card without a refetch. */
  fields?: Record<string, unknown>;
  /**
   * Progressive reveal: capture writes title + screenshot before the LLM runs, so a
   * `captured` transition carries them and the card fills its image and heading while
   * the AI read is still outstanding. Absent on every other transition.
   */
  title?: string;
  screenshot?: string;
  /**
   * 1-based place in the job line, on transitions for an item that is enqueued but has
   * not started. Absent once the job begins — the client CLEARS it on absence rather
   * than only assigning it when present, so a card can't be stranded showing a stale
   * position. The line is global (one worker for all boards), so position 2 means two
   * captures ahead of you anywhere, not on this board.
   */
  queuePosition?: number;
}

/** A minimal write sink (the SSE response stream). */
export interface SseSink {
  write(chunk: string): void;
}

/** Format one transition as an SSE frame: `event: status` + a JSON `data:` line. */
export function formatSseEvent(event: StatusEvent): string {
  return `event: status\ndata: ${JSON.stringify(event)}\n\n`;
}

interface Subscriber {
  sink: SseSink;
  boardId?: string;
}

/**
 * The in-process status hub. The worker (Story 5.2) publishes every transition;
 * SSE connections subscribe. A subscriber whose `write` throws (dead stream) is
 * dropped — the most leak-prone path on the small box.
 */
export class StatusHub {
  private readonly subs = new Set<Subscriber>();

  /** Subscribe a sink (optionally scoped to a board). Returns an unsubscribe fn. */
  subscribe(sink: SseSink, boardId?: string): () => void {
    const sub: Subscriber = { sink, boardId };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  publish(event: StatusEvent): void {
    const frame = formatSseEvent(event);
    for (const sub of this.subs) {
      if (sub.boardId && sub.boardId !== event.boardId) continue;
      try {
        sub.sink.write(frame);
      } catch {
        // Backstop only: a real ServerResponse.write() after disconnect returns false
        // (doesn't throw), so the `close`/`error` handler in startSseStream is what
        // actually cleans up. This drop covers a sink that does throw.
        this.subs.delete(sub);
      }
    }
  }

  size(): number {
    return this.subs.size;
  }
}

/** Process-wide hub the worker publishes to and the SSE route subscribes from. */
export const statusHub = new StatusHub();

const HEARTBEAT_MS = 15_000;

// Minimal shapes so this is unit-testable with fakes (no real Fastify/socket).
interface SseReply {
  hijack(): void;
  raw: {
    writeHead(code: number, headers: Record<string, string>): void;
    write(chunk: string): void;
    on(event: 'error', cb: () => void): void;
  };
}
interface SseReq {
  raw: { on(event: 'close', cb: () => void): void };
}

/**
 * Wire an SSE stream onto a (hijacked) Fastify reply. Must `hijack()` first —
 * writing to `reply.raw` without it triggers a Fastify double-send. Subscribes to
 * the hub, sends heartbeats, and removes the subscriber on disconnect (AC5).
 */
export function startSseStream(
  req: SseReq,
  reply: SseReply,
  hub: StatusHub = statusHub,
  opts?: { boardId?: string },
): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Flush headers + establish the stream immediately (Node buffers headers until the
  // first body write; this also opens the stream through proxies).
  reply.raw.write(': connected\n\n');

  const unsubscribe = hub.subscribe({ write: (s) => reply.raw.write(s) }, opts?.boardId);

  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(': ping\n\n'); // comment frame keeps the connection alive through proxies
    } catch {
      /* will be cleaned up by the close handler */
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.raw.on('close', cleanup);
  // An async socket 'error' (e.g. in the disconnect→publish race) with no listener
  // can surface as an unhandled error and crash the process — register one.
  reply.raw.on('error', cleanup);
}
