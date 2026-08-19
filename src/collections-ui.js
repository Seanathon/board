// Pure collection-UI helpers. No DOM, no window references — importable by node:test.
import { escHtml } from "./descriptor/render-map.js";

export function resolveActiveCollection(storedId, collections) {
  if (!storedId) return "inspiration";
  const found = collections.find((c) => c.id === storedId);
  return found ? found.id : "inspiration";
}

export const itemsUrl = (cid) => `/api/collections/${cid}/items`;
export const itemUrl = (cid, id) => `/api/collections/${cid}/items/${id}`;
export const addUrl = (cid) => `/api/collections/${cid}/items`;
export const refetchUrl = (cid, id) => `/api/collections/${cid}/items/${id}/refetch`;
export const screenshotUrl = (cid, id) => `/api/collections/${cid}/items/${id}/screenshot`;
// Per-item move: reassigns an item's home board (single-FK) via the same-origin
// twin of the v1 assign verb. POST { boardId } — see server.ts.
export const moveUrl = (cid, id) => `/api/collections/${cid}/items/${id}/move`;
// Story 3.2: client seam for the generic skill route (no UI behavior change yet).
export const skillsUrl = (name) => `/skills/${name}`;
// Story 5.3: live status stream (optionally scoped to a board). Poll fallback = itemsUrl.
export const eventsUrl = (cid) => (cid ? `/events?boardId=${encodeURIComponent(cid)}` : "/events");

// Story 8.1: layout is descriptor-driven — view comes from descriptor.view, not a
// per-board branch (FR-13/FR-3). Falls back to grid for a missing/odd descriptor.
export function selectView(descriptor) {
  return descriptor && descriptor.view === "list" ? "list" : "grid";
}

// Read a field value from an item by descriptor key, bridging BOTH data shapes:
// the SQLite item model (flat `item.fields[key]`, dotted keys) and the prototype
// flat-JSON item (nested, e.g. key "meta.audience" → item.meta.audience; or a
// top-level "summary"/"favorite_reason"). Returns undefined if absent.
export function getFieldValue(item, key) {
  if (item && item.fields && Object.prototype.hasOwnProperty.call(item.fields, key)) {
    return item.fields[key];
  }
  // dotted-path lookup into the (possibly nested) item
  let cur = item;
  for (const part of key.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function hasValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// Story 8.1: pure field iteration for the generic detail modal — descriptor order,
// present values only, each resolved via the shape bridge. Returns `{ field, value }[]`
// for the renderer (Story 7.2 render-map) to turn into markup.
export function itemFieldEntries(item, descriptor) {
  if (!descriptor || !Array.isArray(descriptor.fields)) return [];
  const out = [];
  for (const field of descriptor.fields) {
    const value = getFieldValue(item, field.key);
    if (!hasValue(value)) continue;
    out.push({ field, value });
  }
  return out;
}

// Story 8.2: filters are DESCRIPTOR-DRIVEN — derived from the board's enum/tags
// fields (FR-14/FR-3), so a composed board filters with no code. Returns
// `[{ key, label, type }]` for each filterable field. NOTE: free-text `q` is NOT a
// filter here — full-text search is Story 9.1 (server FTS5); don't reintroduce a
// second client text search.
/** @returns {Array<{ key: string, label: string, type: string, values: string[] | null }>} */
export function buildFilters(descriptor) {
  if (!descriptor || !Array.isArray(descriptor.fields)) return [];
  return descriptor.fields
    .filter((f) => f.type === "enum" || f.type === "tags")
    .map((f) => ({ key: f.key, label: f.label, type: f.type, values: f.values || null }));
}

// Pure filter predicate: an item matches when, for EVERY active filter, its value
// for that field (resolved via the shape bridge) matches — enum: equality; tags:
// array-includes. An empty filter set passes all. (AND across filters.)
export function matchesFilters(item, activeFilters, descriptor) {
  if (!activeFilters) return true;
  const byKey = new Map((descriptor && descriptor.fields ? descriptor.fields : []).map((f) => [f.key, f]));
  for (const [key, sel] of Object.entries(activeFilters)) {
    if (sel == null || sel === "") continue; // inactive filter
    const field = byKey.get(key);
    if (!field) continue;
    const value = getFieldValue(item, key);
    if (field.type === "tags") {
      if (!Array.isArray(value) || !value.includes(sel)) return false;
    } else if (value !== sel) {
      return false;
    }
  }
  return true;
}

// Story 8.4: pure card-update for optimistic save. Given the card the user already
// owns and an SSE `status` event (Story 5.3), compute the card's NEXT state — fields
// filled on `done` (from the event payload, no refetch), errorReason on `error`. The
// caller mutates the SAME card node in place (never re-keys/re-sorts — UJ-1). Returns
// the card unchanged if the event isn't for this card (id mismatch).
export function applySseEvent(card, event) {
  if (!card || !event || card.id !== event.itemId) return card;
  const next = { ...card, status: event.status };
  if (event.fields && typeof event.fields === "object") {
    next.fields = { ...(card.fields || {}), ...event.fields };
  }
  if (event.error_reason !== undefined) next.errorReason = event.error_reason;
  return next;
}

// Story 8.5: the dignified degraded/disabled/error state for an item's enriched
// section (UJ-2/FR-9 — never raw error text, disabled ≠ failed). Pure: (item,
// descriptor, {providerConfigured}) → markup string for the enriched-section state
// (empty string when enriched fields exist and should just render normally).
//
// The set of user-safe error reasons Story 5.2 (cleanErrorReason) can produce. Any
// OTHER error_reason value (raw/stack/sentinel) is NOT shown — it falls back to a
// generic message, so internals can never leak to the card (the UJ-2 guarantee).
const SAFE_ERROR_REASONS = new Set([
  "could not reach the AI provider",
  "AI returned invalid output",
  "timed out",
  "processing failed",
  "interrupted", // reconcileInterruptedItems (boot sweep of stuck `processing`)
]);

export function renderEnrichmentState(item, descriptor, opts = {}) {
  if (!item) return "";
  const providerConfigured = !!opts.providerConfigured;

  if (item.status === "error") {
    const raw = item.errorReason ?? item.error_reason ?? "";
    const safe = SAFE_ERROR_REASONS.has(raw) ? raw : "Couldn't analyze this item";
    return (
      `<div class="enrich-state enrich-error">` +
      `<span class="enrich-reason">${escHtml(safe)}</span>` +
      `<button class="retry-analysis" data-id="${escHtml(item.id ?? "")}">Retry analysis</button>` +
      `</div>`
    );
  }
  // Only `done` gets a degraded placeholder; pending/processing show the live shimmer.
  if (item.status && item.status !== "done") return "";

  const enrichableKeys = (descriptor && descriptor.fields ? descriptor.fields : [])
    .filter((f) => f.enrichable)
    .map((f) => f.key);
  const hasEnriched = enrichableKeys.some((k) => hasValue(getFieldValue(item, k)));
  if (hasEnriched) return ""; // real analysis present → render fields, no placeholder

  // Empty enriched fields: disabled (no provider) vs neutral (provider on, returned
  // empty). Drive off the PROVIDER signal, not emptiness — an enabled box can return empty.
  return providerConfigured
    ? `<div class="enrich-state enrich-empty">No analysis</div>`
    : `<div class="enrich-state enrich-disabled">Enrichment disabled</div>`;
}

// Story 8.6: warm zero-config first-run. An empty board must explain itself + invite
// a paste — never a cold blank grid or a CLI string (UJ-3). The purpose line is a
// DEFINED, sourced artifact: descriptor.purpose/description if present, else a
// per-board fallback, else a generic invite (NEVER just the bare name).
const BOARD_PURPOSE = {
  inspiration: "Designs worth studying. Paste a URL to capture a site you admire.",
  library: "Things worth keeping. Paste a link to save and summarize an article or paper.",
};

export function boardPurpose(collection) {
  if (!collection) return "Paste a URL to add your first item.";
  return (
    collection.purpose ||
    (collection.descriptor && collection.descriptor.purpose) ||
    collection.description ||
    BOARD_PURPOSE[collection.id] ||
    `Paste a URL to add your first item to ${collection.name || "this board"}.`
  );
}

// Per-board "voice" for the first-run empty state: a short stance headline + a body
// line that states the board's point of view. The body is AI-AWARE — with no provider
// wired in, it promises a clean bookmark instead of the AI read (graceful degradation).
function emptyVoice(collection, aiOn) {
  const id = collection && collection.id;
  const type = collection && collection.type;
  // Composer-written copy wins for ANY board that carries it. This MUST come before the
  // type-based branches below: a composed grid board inherits type "inspiration" (for
  // card chrome), which would otherwise shadow its bespoke empty_state with the seeded
  // Inspiration copy. The seeded boards have no empty_state, so they skip this and keep
  // their hardcoded, AI-aware voice.
  const es = collection && collection.descriptor && collection.descriptor.empty_state;
  if (es && es.head && es.body) return { head: es.head, body: es.body };
  if (id === "inbox") {
    return {
      head: "Inbox zero.",
      body: "Everything is where it should be. New captures land here first, then you file them onto a board.",
    };
  }
  if (id === "inspiration" || type === "inspiration") {
    return {
      head: "Nothing pinned yet.",
      body: aiOn
        ? "Inspiration is for designs worth stealing from. Capture a site and the AI reads its taste back to you."
        : "Inspiration is for designs worth stealing from. Capture a site and it is kept as a clean visual bookmark.",
    };
  }
  if (id === "library" || type === "library") {
    return {
      head: "Nothing shelved yet.",
      body: aiOn
        ? "Library is for things worth reading twice. Save a link and it comes back summarized."
        : "Library is for things worth reading twice. Save a link and it is kept as a clean, readable bookmark.",
    };
  }
  // Composed / custom board with no bespoke copy (e.g. created with AI off): fall back
  // to the generic stance + purpose line.
  return { head: "This board is ready.", body: boardPurpose(collection) };
}

// Empty-state markup. Two conditions, one helper:
//   - filtered: the board HAS items but the active filters exclude them all → offer a
//     way back (Clear filters), never the first-run capture invite.
//   - first-run: the board is genuinely empty → board voice + a "+ Add" CTA, a quiet
//     "Where to begin" link (opens the welcome guide), a faint aria-hidden preview of
//     the board's own layout, and an honest AI-off note when no provider is configured.
// Pure: returns a string. Callers (index.html) wire the [data-empty-*] affordances via
// one delegated listener.
export function renderEmptyState(collection, opts = {}) {
  if (opts.filtered) {
    return (
      `<div class="empty-state empty-state--filtered" data-variant="filtered">` +
      `<div class="empty-copy">` +
      `<h2 class="empty-head">No matches.</h2>` +
      `<p class="empty-body">Nothing on this board fits the current filters.</p>` +
      `<div class="empty-actions">` +
      `<button type="button" class="empty-cta empty-cta--ghost" data-empty-clear>Clear filters</button>` +
      `</div></div></div>`
    );
  }
  const aiOn = opts.providerConfigured !== false; // default to AI-on unless told otherwise
  const v = emptyVoice(collection, aiOn);
  const isGrid = !!(collection && collection.view === "grid");
  const ghostKind = isGrid ? "grid" : "list";
  const cells = isGrid ? 6 : 4;
  const ghost =
    `<div class="empty-ghost empty-ghost--${ghostKind}" aria-hidden="true">` +
    Array.from({ length: cells }).map(() => "<span></span>").join("") +
    `</div>`;
  const degraded = aiOn
    ? ""
    : `<p class="empty-degraded">AI is off, so items arrive as clean bookmarks. Add an LLM anytime for the design read.</p>`;
  return (
    `<div class="empty-state" data-variant="first-run">` +
    ghost +
    `<div class="empty-copy">` +
    `<h2 class="empty-head">${escHtml(v.head)}</h2>` +
    `<p class="empty-body">${escHtml(v.body)}</p>` +
    degraded +
    `<div class="empty-actions">` +
    `<button type="button" class="empty-cta" data-empty-add>+ Add</button>` +
    `<button type="button" class="empty-link" data-empty-guide>Where to begin <span aria-hidden="true">&rarr;</span></button>` +
    `</div>` +
    `<p class="empty-hint">Paste a URL above, drop a link, or share to your Inbox from your phone.</p>` +
    `</div></div>`
  );
}

// Board-level fallback states — "degrade with dignity" at the whole-board level, so the
// app never white-screens or dead-ends (Design Principle 3). Two variants, same calm
// visual language as renderEmptyState (ghost grid + empty-copy), pure markup:
//   - unavailable: the boards couldn't be fetched (server down / error) → Retry.
//   - no-boards:   the fetch succeeded but there are zero boards (defensive once Inbox
//                  is protected) → an invite to compose the first board.
// Callers wire the [data-boards-retry] / [data-boards-new] affordances.
export function renderBoardsFallback(opts = {}) {
  const unavailable = opts.unavailable === true;
  const ghost =
    `<div class="empty-ghost empty-ghost--grid" aria-hidden="true">` +
    Array.from({ length: 6 }).map(() => "<span></span>").join("") +
    `</div>`;
  if (unavailable) {
    return (
      `<div class="empty-state" data-variant="unavailable">` +
      ghost +
      `<div class="empty-copy">` +
      `<h2 class="empty-head">Can't reach the server.</h2>` +
      `<p class="empty-body">Board couldn't load your boards. Check that the service is running, then try again.</p>` +
      `<div class="empty-actions">` +
      `<button type="button" class="empty-cta" data-boards-retry>Retry</button>` +
      `</div></div></div>`
    );
  }
  return (
    `<div class="empty-state" data-variant="no-boards">` +
    ghost +
    `<div class="empty-copy">` +
    `<h2 class="empty-head">No boards yet.</h2>` +
    `<p class="empty-body">Describe what you collect and Board composes one: its capture mode, the fields worth keeping, the layout.</p>` +
    `<div class="empty-actions">` +
    `<button type="button" class="empty-cta" data-boards-new>Describe a board</button>` +
    `</div>` +
    `<p class="empty-hint">or press + in the header anytime.</p>` +
    `</div></div>`
  );
}

// Story 8.6: the enable-AI nudge shows ONLY when no provider is configured (Story
// 4.4 signal) AND it hasn't been dismissed (localStorage). Peripheral + dismissible
// — never re-shown after dismissal, never shown when AI is on (the board is the hero).
export function shouldShowEnableAiNudge(opts = {}) {
  return !opts.providerConfigured && !opts.dismissed;
}

export function collectionChrome(collection) {
  // The FIXED Inspiration controls (Audience/Form/Domain + tiers + design tags) belong
  // to the SEEDED Inspiration board only — a composed grid board inherits type
  // "inspiration" for card layout but must NOT show them (they'd be empty/irrelevant).
  // Match by id; composed boards get descriptor-driven filters (buildFilters) instead.
  const isInspiration = collection.id === "inspiration";
  const isGrid = collection.view === "grid";
  return {
    facets: isInspiration,
    tiers: isInspiration,
    tagCloud: isInspiration,
    viewToggle: true,
    screenshot: isGrid,
    refetch: true,
  };
}

// --- Library view helpers ---

export function libraryHaystack(item) {
  return [
    item.title,
    item.summary,
    ...(item.topics || []),
    item.author,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function matchesLibraryFilters(item, { q = "", topic = "", type = "" } = {}) {
  if (type && item.type !== type) return false;
  if (topic && !(item.topics || []).includes(topic)) return false;
  if (q && !libraryHaystack(item).includes(q.toLowerCase())) return false;
  return true;
}

/** @returns {Record<string, number>} topic → occurrence count across all items */
export function topicCounts(items) {
  const counts = {};
  for (const item of items) {
    for (const t of item.topics || []) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  return counts;
}
