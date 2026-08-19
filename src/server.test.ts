import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildServer, getListenOptions, warnIfExposed } from "./server.js";
import { loadConfig } from "./config.js";
import { BOOKMARKS_FILE, saveCollection } from "./storage.js";
import { eq } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// library.json / bookmarks.json are gitignored personal-capture files (absent in
// CI). snapshotFile tolerates a missing file (returns null); restoreFile puts the
// original contents back, or removes a file the test created — keeping the tree clean.
function snapshotFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
function restoreFile(file: string, snap: string | null): void {
  if (snap === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, snap);
}

// --- GET /api/collections ---

test("GET /api/collections returns all collections including library (SQLite)", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/collections" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as any[];
    assert.ok(Array.isArray(body), "should return an array");
    assert.ok(body.some((c) => c.id === "inspiration"), "should include inspiration");
    assert.ok(body.some((c) => c.id === "library"), "should include library");
    assert.ok(body.every((c) => c.id && c.name && c.type && c.view), "each entry should have id/name/type/view");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- SQLite cutover: the collection item routes are now SQLite-backed (hydrated for
// the UI). These replace the old flat-JSON-contract tests for the same routes. ---

async function seededSqliteApp() {
  const { initDb } = await import("./db/index.js");
  const { seed } = await import("./db/seed.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-cut-"));
  const handle = initDb(path.join(dir, "c.db"));
  seed(handle.db);
  const app = await buildServer({ db: handle });
  return { app, handle, dir };
}

test("GET /api/collections/:cid/items returns SQLite items hydrated for the UI", async () => {
  const { writeItem } = await import("./db/queue.js");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    await writeItem(handle, { id: "lib-1", boardId: "library", source: "https://x", title: "T", fields: { summary: "S", topics: ["a"] } });
    const res = await app.inject({ method: "GET", url: "/api/collections/library/items" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as any[];
    assert.equal(body.length, 1);
    assert.equal(body[0].id, "lib-1");
    assert.equal(body[0].title, "T");
    assert.equal(body[0].summary, "S"); // flat field hydrated to top level
    assert.deepEqual(body[0].topics, ["a"]);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PATCH /api/collections/:cid/items/:id updates notes (SQLite)", async () => {
  const { writeItem } = await import("./db/queue.js");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    await writeItem(handle, { id: "lib-2", boardId: "library", source: "https://x", title: "T" });
    const res = await app.inject({ method: "PATCH", url: "/api/collections/library/items/lib-2", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: "my research notes" }) });
    assert.equal(res.statusCode, 200);
    assert.equal((JSON.parse(res.body) as any).notes, "my research notes");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DELETE /api/collections/:cid/items/:id removes the item (204, SQLite)", async () => {
  const { writeItem } = await import("./db/queue.js");
  const { eq } = await import("drizzle-orm");
  const { items } = await import("./db/schema.js");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    await writeItem(handle, { id: "lib-3", boardId: "library", source: "https://x", title: "T" });
    const res = await app.inject({ method: "DELETE", url: "/api/collections/library/items/lib-3" });
    assert.equal(res.statusCode, 204);
    assert.equal(handle.db.select().from(items).where(eq(items.id, "lib-3")).get(), undefined);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/collections/:cid/items/:id/move reassigns the item's home board (SQLite)", async () => {
  const { writeItem } = await import("./db/queue.js");
  const { eq } = await import("drizzle-orm");
  const { items } = await import("./db/schema.js");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    await writeItem(handle, { id: "mv-1", boardId: "inbox", source: "https://x", title: "T" });
    const res = await app.inject({
      method: "POST",
      url: "/api/collections/inbox/items/mv-1/move",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId: "library" }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((JSON.parse(res.body) as any).assigned, ["mv-1"]);
    assert.equal(handle.db.select().from(items).where(eq(items.id, "mv-1")).get()?.boardId, "library");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST .../move returns 400 for a missing boardId", async () => {
  const { writeItem } = await import("./db/queue.js");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    await writeItem(handle, { id: "mv-2", boardId: "inbox", source: "https://x", title: "T" });
    const res = await app.inject({
      method: "POST",
      url: "/api/collections/inbox/items/mv-2/move",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.statusCode, 400);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST .../move returns 400 for an unknown target board", async () => {
  const { writeItem } = await import("./db/queue.js");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    await writeItem(handle, { id: "mv-3", boardId: "inbox", source: "https://x", title: "T" });
    const res = await app.inject({
      method: "POST",
      url: "/api/collections/inbox/items/mv-3/move",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId: "no-such-board" }),
    });
    assert.equal(res.statusCode, 400);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST .../move returns 404 for an unknown item", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/collections/inbox/items/ghost/move",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId: "library" }),
    });
    assert.equal(res.statusCode, 404);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Unknown cid ---

test("GET /api/collections/no-such-cid/items returns an empty list (unknown board)", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/collections/no-such-cid/items" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PATCH /api/collections/:cid/items/:id returns 404 for an unknown item (SQLite)", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/collections/no-such-cid/items/x",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "x" }),
    });
    assert.equal(res.statusCode, 404);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Manual image upload (SQLite, board-mode-agnostic) ---

test("POST /api/collections/:cid/items/:id/screenshot uploads to a composed (SQLite) board", async () => {
  // Regression: the upload route used the legacy JSON handler, which only knew the
  // three seeded boards and 400'd ("Unknown collection") on a composed board id — so a
  // manual re-upload after a failed og:image fetch was impossible. It now routes through
  // the SQLite upload-asset path and works for any board.
  const { initDb } = await import("./db/index.js");
  const { seed } = await import("./db/seed.js");
  const { writeItem } = await import("./db/queue.js");
  const { boards } = await import("./db/schema.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-cut-"));
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-shot-"));
  const handle = initDb(path.join(dir, "c.db"));
  seed(handle.db);
  try {
    // A composed grid board with one image-less item (auto-capture "failed").
    handle.db.insert(boards).values({ id: "wishlist", name: "Wish List", view: "grid", descriptor: { name: "Wish List", fields: [] } as any }).run();
    await writeItem(handle, { id: "wl-1", boardId: "wishlist", source: "https://x", title: "T" });
    const app = await buildServer({ db: handle, screenshotsDir: shotDir });

    const res = await app.inject({
      method: "POST",
      url: "/api/collections/wishlist/items/wl-1/screenshot",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    });
    assert.equal(res.statusCode, 200, "composed-board upload must not 400");
    const updated = JSON.parse(res.body) as any;
    assert.ok(updated.screenshot, "the hydrated item should now carry a screenshot path");

    // The file landed under the injected screenshotsDir and is served (assets don't 404).
    assert.ok(fs.existsSync(path.join(shotDir, "wl-1.png")), "image must be written under screenshotsDir");
    const served = await app.inject({ method: "GET", url: `/${updated.screenshot}` });
    assert.equal(served.statusCode, 200, "uploaded image should be served");
    assert.ok(served.rawPayload.length > 0);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(shotDir, { recursive: true, force: true });
  }
});

test("POST .../screenshot returns 404 for an unknown item", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/collections/inspiration/items/ghost/screenshot",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    });
    assert.equal(res.statusCode, 404);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST .../screenshot returns 400 for a non-image data URL", async () => {
  const { writeItem } = await import("./db/queue.js");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    await writeItem(handle, { id: "bad-shot", boardId: "inspiration", source: "https://x", title: "T" });
    const res = await app.inject({
      method: "POST",
      url: "/api/collections/inspiration/items/bad-shot/screenshot",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "not-a-data-url" }),
    });
    assert.equal(res.statusCode, 400);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- POST validation (no spawn) ---

test("POST /api/collections/inspiration/items returns 400 for missing url", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/api/collections/inspiration/items",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/collections/:cid/items accepts a url + creates a pending item (SQLite)", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    // analysisAgent is a prototype concept the SQLite path ignores (provider is configured
    // server-side) — it must NOT 400; the item is created pending.
    const res = await app.inject({ method: "POST", url: "/api/collections/inspiration/items", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", analysisAgent: "gpt" }) });
    assert.equal(res.statusCode, 200);
    assert.equal((JSON.parse(res.body) as any).status, "pending");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/collections/no-such-cid/items returns 4xx for unknown collection (SQLite)", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({ method: "POST", url: "/api/collections/no-such-cid/items", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }) });
    assert.ok(res.statusCode >= 400, `unknown board should 4xx, got ${res.statusCode}`);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Legacy alias: PATCH /api/bookmarks/:id ---

test("PATCH /api/bookmarks/:id (alias) updates favorite field and preserves other fields", async () => {
  const bmSnapshot = snapshotFile(BOOKMARKS_FILE);
  try {
    const testItem = { id: "bm-alias-test", url: "https://example.com", added: "2025-01-01", screenshot: null, title: "Test", meta: { audience: "consumer", form: "app", domain: null, tags: [], tier: "reference", tone: [] }, design: { steal_this: "x", above_fold: "x", nav_pattern: "x", whitespace: "x", color_story: "x", design_system_score: "bespoke" }, reflection: { five_second_message: "x", apply_to_naruki: "keep me" }, favorite: false, analysis_agent: "claude", analysis_model: null };
    saveCollection("inspiration", [testItem]);
    const app = await buildServer();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/bookmarks/${testItem.id}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: true }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as any;
    assert.equal(body.favorite, true);
    assert.equal(body.reflection.apply_to_naruki, "keep me", "other fields must not be clobbered");
  } finally {
    restoreFile(BOOKMARKS_FILE, bmSnapshot);
  }
});

// --- Legacy POST /api/add validation ---

test("POST /api/add returns 400 for missing url", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/api/add",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/add returns 400 for invalid analysisAgent", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/api/add",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com", analysisAgent: "gpt" }),
  });
  assert.equal(res.statusCode, 400);
});

// --- Story 2.4: localhost bind default + reverse-proxy posture ---

test("getListenOptions defaults to 127.0.0.1:3141 (secure default)", () => {
  const opts = getListenOptions(loadConfig({}));
  assert.deepEqual(opts, { host: "127.0.0.1", port: 3141 });
});

test("getListenOptions binds an explicit HOST override", () => {
  assert.equal(getListenOptions(loadConfig({ HOST: "0.0.0.0" })).host, "0.0.0.0");
  // empty/whitespace HOST must NOT bind-all — it falls back to localhost (2.1 AC1)
  assert.equal(getListenOptions(loadConfig({ HOST: "" })).host, "127.0.0.1");
  assert.equal(getListenOptions(loadConfig({ PORT: "8080" })).port, 8080);
});

test("warnIfExposed warns on a non-localhost bind, stays silent on localhost", () => {
  const warns: string[] = [];
  const logger = { warn: (m: string) => warns.push(m) };

  warnIfExposed({ host: "127.0.0.1", port: 3141 }, logger);
  assert.equal(warns.length, 0, "localhost must not warn");

  warnIfExposed({ host: "0.0.0.0", port: 3141 }, logger);
  assert.equal(warns.length, 1, "non-localhost must warn exactly once");
  assert.match(warns[0], /0\.0\.0\.0/);
  assert.match(warns[0], /reverse proxy|firewall/i);

  // ::1 and localhost are also safe
  warnIfExposed({ host: "::1", port: 3141 }, logger);
  warnIfExposed({ host: "localhost", port: 3141 }, logger);
  assert.equal(warns.length, 1, "::1 and localhost must not warn");
});

// --- Story 8.3: SQLite-backed per-item actions (REST) ---

test("PATCH /api/items/:id updates notes (SQLite-backed, injected db)", async () => {
  const { initDb } = await import("./db/index.js");
  const { boards, items } = await import("./db/schema.js");
  const { eq } = await import("drizzle-orm");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-itemroute-"));
  const handle = initDb(path.join(dir, "r.db"));
  try {
    handle.db.insert(boards).values({ id: "b", name: "B", view: "list", descriptor: { view: "list", ingest_mode: "url-readable", enrichment_prompt: "", fields: [] } }).run();
    handle.db.insert(items).values({ id: "it", boardId: "b", source: "x" }).run();
    const { assets } = await import("./db/schema.js");
    const shotDir = path.join(dir, "shots");
    fs.mkdirSync(shotDir, { recursive: true });
    const app = await buildServer({ db: handle, screenshotsDir: shotDir });

    // notes PATCH
    const res = await app.inject({ method: "PATCH", url: "/api/items/it", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: "hi" }) });
    assert.equal(res.statusCode, 200);
    assert.equal(handle.db.select().from(items).where(eq(items.id, "it")).get()?.notes, "hi");

    // favorite toggle via route
    await app.inject({ method: "PATCH", url: "/api/items/it", headers: { "content-type": "application/json" }, body: JSON.stringify({ favorite: true }) });
    assert.equal(handle.db.select().from(items).where(eq(items.id, "it")).get()?.favorite, 1);

    // disallowed field via route — status unchanged
    await app.inject({ method: "PATCH", url: "/api/items/it", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }) });
    assert.equal(handle.db.select().from(items).where(eq(items.id, "it")).get()?.status, "pending");

    // DELETE via route removes the item AND unlinks its asset file (non-grid board)
    handle.db.insert(assets).values({ id: "it-a", itemId: "it", kind: "screenshot", path: "screenshots/it.png" }).run();
    fs.writeFileSync(path.join(shotDir, "it.png"), "PNG");
    const del = await app.inject({ method: "DELETE", url: "/api/items/it" });
    assert.equal(del.statusCode, 204);
    assert.equal(handle.db.select().from(items).where(eq(items.id, "it")).get(), undefined);
    assert.equal(fs.existsSync(path.join(shotDir, "it.png")), false, "asset file unlinked via route DELETE");

    const missing = await app.inject({ method: "PATCH", url: "/api/items/nope", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(missing.statusCode, 404);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Story 8.5: provider-configured signal ---

test("GET /api/meta reports providerConfigured=false in no-AI mode (disabledLlm)", async () => {
  const app = await buildServer(); // no opts.llm → selectProvider(config) → disabledLlm in test env
  const res = await app.inject({ method: "GET", url: "/api/meta" });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).providerConfigured, false);
  assert.equal(JSON.parse(res.body).provider, null, "no provider identity in no-AI mode");
});

test("GET /api/meta reports providerConfigured=true when an llm is injected", async () => {
  const app = await buildServer({ llm: { complete: async () => ({}) } as never });
  const res = await app.inject({ method: "GET", url: "/api/meta" });
  assert.equal(JSON.parse(res.body).providerConfigured, true);
});

// --- Story 8.6: warm zero-config first-run boot ---

test("first-run boot: serves with no LLM config + seeded boards present", async () => {
  // Boot seeds the boards (server.ts entrypoint); a seeded db models that fresh-boot state.
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const cols = await app.inject({ method: "GET", url: "/api/collections" });
    assert.equal(cols.statusCode, 200);
    const ids = JSON.parse(cols.body).map((c: { id: string }) => c.id);
    assert.ok(ids.includes("inspiration") && ids.includes("library"), "seeded boards present on first run");
    const meta = await app.inject({ method: "GET", url: "/api/meta" });
    assert.equal(JSON.parse(meta.body).providerConfigured, false, "no-AI by default (nudge will show)");
    const index = await app.inject({ method: "GET", url: "/" });
    assert.equal(index.statusCode, 200, "the app serves the board UI");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Story 9.1: search skill route ---

test("POST /skills/search returns board-scoped FTS hits", async () => {
  const { initDb } = await import("./db/index.js");
  const { boards } = await import("./db/schema.js");
  const { writeItem } = await import("./db/queue.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-searchroute-"));
  const handle = initDb(path.join(dir, "s.db"));
  try {
    handle.db.insert(boards).values({ id: "a", name: "A", view: "list", descriptor: { view: "list", ingest_mode: "url-readable", enrichment_prompt: "", fields: [] } }).run();
    await writeItem(handle, { id: "it", boardId: "a", source: "x", title: "zqxwv distinctive" });
    const app = await buildServer({ db: handle });
    const res = await app.inject({ method: "POST", url: "/skills/search", headers: { "content-type": "application/json" }, body: JSON.stringify({ boardId: "a", q: "zqxwv" }) });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.items.some((i: { id: string }) => i.id === "it"), "FTS hit returned via the skill route");
    // malformed query → no 500
    const bad = await app.inject({ method: "POST", url: "/skills/search", headers: { "content-type": "application/json" }, body: JSON.stringify({ boardId: "a", q: 'foo"bar' }) });
    assert.equal(bad.statusCode, 200);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Story 11.1: /healthz liveness ---

test("GET /healthz is a pure 200 liveness probe (no DB, no pollution)", async () => {
  const app = await buildServer(); // no opts.db → if /healthz touched the DB it would open ./data
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

// --- Story 11.2 review BLOCKER regression: boot must seed boards (zero-config first-run) ---

test("a seeded DB lets add-item succeed (first-run capture path, no 'unknown board' 500)", async () => {
  const { initDb } = await import("./db/index.js");
  const { seed } = await import("./db/seed.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-seedboot-"));
  const handle = initDb(path.join(dir, "s.db"));
  try {
    seed(handle.db); // what the boot entrypoint now does on a fresh DATA_DIR
    const app = await buildServer({ db: handle });
    const res = await app.inject({ method: "POST", url: "/skills/add-item", headers: { "content-type": "application/json" }, body: JSON.stringify({ boardId: "inspiration", source: "https://example.com" }) });
    assert.equal(res.statusCode, 200, "add-item must NOT 500 on a seeded board");
    assert.equal(JSON.parse(res.body).status, "pending");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Edit-board routes (rename / delete) ---

test("PATCH /api/boards/:id renames; DELETE /api/boards/:id cascades", async () => {
  const { createBoardSkill } = await import("./skills/create-board.js");
  const { buildCtx } = await import("./skills/types.js");
  const { enqueueWrite } = await import("./db/queue.js");
  const { boards } = await import("./db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    await createBoardSkill.run(
      { id: "wines", name: "Wines", descriptor: { view: "grid", ingest_mode: "url-screenshot", enrichment_prompt: "", fields: [] } },
      buildCtx({ db: handle, queue: { enqueueWrite }, logger: console })
    );
    const r = await app.inject({ method: "PATCH", url: "/api/boards/wines", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Fine Wines" }) });
    assert.equal(r.statusCode, 200);
    assert.equal(handle.db.select().from(boards).where(eq(boards.id, "wines")).get()?.name, "Fine Wines");
    assert.equal((await app.inject({ method: "PATCH", url: "/api/boards/wines", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "  " }) })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/boards/ghost", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) })).statusCode, 404);
    const d = await app.inject({ method: "DELETE", url: "/api/boards/wines" });
    assert.equal(d.statusCode, 200);
    assert.equal(handle.db.select().from(boards).where(eq(boards.id, "wines")).get(), undefined);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/boards/ghost" })).statusCode, 404);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DELETE /api/boards/inbox is refused (409) — Inbox is a protected system board", async () => {
  const { boards } = await import("./db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const d = await app.inject({ method: "DELETE", url: "/api/boards/inbox" });
    assert.equal(d.statusCode, 409);
    // The board is still there — the guard refused before cascade.
    assert.ok(handle.db.select().from(boards).where(eq(boards.id, "inbox")).get(), "inbox must survive the delete attempt");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- PATCH /api/boards/:id descriptor update (board field editor) ---

test("PATCH /api/boards/:id updates the descriptor (valid) and 400s on invalid", async () => {
  const { insertBoard } = await import("./db/seed.js");
  const { boards } = await import("./db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    insertBoard(handle.db, { id: "games", name: "Games", descriptor: { view: "grid", ingest_mode: "url-screenshot", enrichment_prompt: "", fields: [] } });
    const good = { view: "list", ingest_mode: "url-readable", enrichment_prompt: "Catalog it.", fields: [{ key: "rating", label: "Rating", type: "number", enrichable: true, description: "1-10" }] };
    const r = await app.inject({ method: "PATCH", url: "/api/boards/games", headers: { "content-type": "application/json" }, body: JSON.stringify({ descriptor: good }) });
    assert.equal(r.statusCode, 200);
    const stored = handle.db.select().from(boards).where(eq(boards.id, "games")).get();
    assert.equal((stored?.descriptor as any).fields[0].description, "1-10");
    assert.equal(stored?.view, "list", "view column synced from descriptor");
    // invalid: off-list field type → 400, descriptor unchanged
    const bad = { ...good, fields: [{ key: "x", label: "X", type: "boolean" }] };
    const b = await app.inject({ method: "PATCH", url: "/api/boards/games", headers: { "content-type": "application/json" }, body: JSON.stringify({ descriptor: bad }) });
    assert.equal(b.statusCode, 400);
    assert.equal((handle.db.select().from(boards).where(eq(boards.id, "games")).get()?.descriptor as any).fields.length, 1, "unchanged after invalid");
    // guardrails parity with the composer: a key shadowing a system column → 400
    const reserved = { ...good, fields: [{ key: "notes", label: "Notes", type: "text", enrichable: true }] };
    assert.equal((await app.inject({ method: "PATCH", url: "/api/boards/games", headers: { "content-type": "application/json" }, body: JSON.stringify({ descriptor: reserved }) })).statusCode, 400, "reserved system-column key rejected");
    // duplicate keys → 400
    const dup = { ...good, fields: [{ key: "dupe", label: "A", type: "text" }, { key: "dupe", label: "B", type: "text" }] };
    assert.equal((await app.inject({ method: "PATCH", url: "/api/boards/games", headers: { "content-type": "application/json" }, body: JSON.stringify({ descriptor: dup }) })).statusCode, 400, "duplicate key rejected");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- POST /api/boards/:id/reenrich (batch re-run AI) ---

test("POST /api/boards/:id/reenrich queues all items; 404 for unknown board", async () => {
  const { insertBoard } = await import("./db/seed.js");
  const { writeItem } = await import("./db/queue.js");
  const { app, handle, dir } = await seededSqliteApp();
  try {
    // no enrichable fields → enrichment is a fast no-op (deterministic, no LLM)
    insertBoard(handle.db, { id: "rb", name: "RB", descriptor: { view: "grid", ingest_mode: "url-screenshot", enrichment_prompt: "", fields: [] } });
    await writeItem(handle, { id: "r1", boardId: "rb", source: "https://a", title: "A" });
    await writeItem(handle, { id: "r2", boardId: "rb", source: "https://b", title: "B" });
    const r = await app.inject({ method: "POST", url: "/api/boards/rb/reenrich" });
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.body).queued, 2);
    assert.equal((await app.inject({ method: "POST", url: "/api/boards/ghost/reenrich" })).statusCode, 404);
    await new Promise((res) => setTimeout(res, 60)); // let fire-and-forget no-op jobs drain before close
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Story 13.3: PWA + Web Share Target (mobile capture) ---

// Task 1 (AC 1, 2, 5) — the served manifest is a valid PWA manifest declaring a
// share_target whose action is the in-app handler and whose params map the shared URL.
test("13.3: GET /manifest.webmanifest is a valid PWA manifest with a share_target", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
    assert.equal(res.statusCode, 200);
    const m = JSON.parse(res.body);
    // AC1 — installable: required manifest keys + at least one icon.
    assert.ok(m.name, "manifest has a name");
    assert.ok(Array.isArray(m.icons) && m.icons.length > 0, "manifest declares icons");
    assert.ok(m.start_url, "manifest has start_url");
    assert.ok(m.display, "manifest has display");
    // AC2 — share target: declares method/enctype, an in-app action, and params
    // mapping the shared url (plus text/title) so a shared URL reaches the handler.
    assert.ok(m.share_target, "manifest declares a share_target");
    assert.equal(m.share_target.action, "/share", "share_target posts to the in-app handler");
    assert.match(String(m.share_target.method), /post/i, "share_target uses POST (mutation)");
    // The declared enctype MUST match what the handler parses (urlencoded) — the one
    // integration seam a server-side test can't otherwise catch (a multipart decl would
    // break a real OS share while every server test still passed).
    assert.match(String(m.share_target.enctype), /x-www-form-urlencoded/i,
      "enctype matches the urlencoded parser the /share handler registers");
    assert.equal(m.share_target.params.url, "url", "params map the shared url");
    assert.ok(m.share_target.params.text, "params map text (Android often carries the URL here)");
    assert.ok(m.share_target.params.title, "params map title");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Task 2/3 (AC 1, 2) — the served app shell links the manifest and registers the
// service worker, so a supported browser can install the PWA.
test("13.3: served index.html links the manifest and registers the service worker", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<link[^>]+rel=["']manifest["'][^>]+href=["']\/manifest\.webmanifest["']/i,
      "head links the web manifest");
    assert.match(res.body, /navigator\.serviceWorker\s*\.\s*register\(\s*["']\/sw\.js["']/,
      "registers the /sw.js service worker");
    assert.match(res.body, /<meta[^>]+name=["']theme-color["']/i, "declares a theme-color");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Task 3 (AC 1, 4) — the service worker is served and is scoped so it passes through
// /api, /events (SSE), /screenshots, and /share. A SW that buffered text/event-stream
// would break the Story 5.3 live-fill (sse.ts) — so its pass-through is asserted here.
test("13.3: GET /sw.js serves a worker that passes through API/SSE/screenshots/share", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({ method: "GET", url: "/sw.js" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /javascript/i, "served as JavaScript");
    // The worker must not intercept these paths (it returns before respondWith).
    for (const p of ["/api/", "/events", "/screenshots/", "/share"]) {
      assert.ok(res.body.includes(p), `sw.js declares a pass-through for ${p}`);
    }
    assert.match(res.body, /addEventListener\(\s*["']fetch["']/, "registers a fetch handler");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Task 4 (AC 3, 5) — a shared payload POSTed (form-encoded, as the share_target sends)
// to /share creates a PENDING item in the INBOX via the same create path as the authed
// API (addItemSkill → no board → Inbox + cheap tier), and returns the user (no trap).
// NOTE: cheapness is structural (it routes through addItemSkill with no target board);
// a spy-LLM "complete === 0" assertion is deliberately omitted — no capture adapter is
// registered in this harness, so it would be a confounded trivial zero (see v1.test.ts).
test("13.3: POST /share creates a pending Inbox item and returns the user", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  const { eq } = await import("drizzle-orm");
  const { items } = await import("./db/schema.js");
  try {
    const res = await app.inject({
      method: "POST",
      url: "/share",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "url=https%3A%2F%2Fshared.example%2Fpost&title=Shared+Title",
    });
    assert.equal(res.statusCode, 200);
    // Returns the user: the confirmation page navigates back rather than trapping them.
    assert.match(res.body, /history\.back|location\.replace|location\.href/i,
      "the share page returns the user to where they were");
    const row = handle.db.select().from(items).where(eq(items.source, "https://shared.example/post")).get();
    assert.ok(row, "the shared URL was captured as an item");
    assert.equal(row.boardId, "inbox", "lands in the Inbox (no target board)");
    assert.equal(row.status, "pending", "optimistic pending (async capture on the queue)");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Task 4/5 (AC 3) — Android often shares the URL inside `text` (no `url` field), some-
// times with surrounding prose. The handler extracts the first URL from `text`.
test("13.3: POST /share extracts the URL from the shared text when no url field is sent", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  const { eq } = await import("drizzle-orm");
  const { items } = await import("./db/schema.js");
  try {
    const res = await app.inject({
      method: "POST",
      url: "/share",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "title=Cool&text=" + encodeURIComponent("Check this out https://from-text.example/x neat"),
    });
    assert.equal(res.statusCode, 200);
    const row = handle.db.select().from(items).where(eq(items.source, "https://from-text.example/x")).get();
    assert.ok(row, "the URL embedded in text was captured");
    assert.equal(row.boardId, "inbox");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Task 4/5 (AC 3) — a share with no resolvable URL returns the user, does not 500,
// and creates nothing.
test("13.3: POST /share with no link returns the user without creating an item", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  const { items } = await import("./db/schema.js");
  try {
    const before = handle.db.select().from(items).all().length;
    const res = await app.inject({
      method: "POST",
      url: "/share",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "title=Just+a+title&text=no+link+here",
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /history\.back|location\.replace/i, "still returns the user");
    assert.equal(handle.db.select().from(items).all().length, before, "no item created");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Task 6 (AC 4, 5) — desktop no-regression: with the manifest/SW/share additions in
// place, existing SPA + collection + item routes still serve unchanged, and the scoped
// urlencoded parser did NOT leak onto the root app (its JSON-only contract is intact).
// NOTE (scope honesty): the service worker never executes under inject() — there is no
// browser. This proves the additions are served additively and existing HTTP routes are
// untouched; the SW-vs-SSE pass-through (a SW must not buffer text/event-stream) is a
// browser-only property, verified manually in Chrome (see Completion Notes).
test("13.3 (NFR-BC): existing routes unchanged + the urlencoded parser stays scoped", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    // The SPA shell still serves.
    const spa = await app.inject({ method: "GET", url: "/" });
    assert.equal(spa.statusCode, 200);
    assert.match(spa.body, /<div id="app">|<title>Board<\/title>/i, "the SPA shell still serves");
    // Collection + meta routes unchanged.
    assert.equal((await app.inject({ method: "GET", url: "/api/collections" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/meta" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
    // Encapsulation: a urlencoded body on a ROOT JSON route is NOT parsed (the /share
    // plugin's parser did not leak) — the root app still rejects the media type (415).
    const leak = await app.inject({
      method: "POST",
      url: "/api/collections/inbox/items",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "url=https%3A%2F%2Fx.example",
    });
    assert.equal(leak.statusCode, 415, "root app has no urlencoded parser → 415, parser stayed scoped");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Task 5 (AC 3) — a URL embedded in shared text with trailing sentence punctuation is
// stored WITHOUT the punctuation (so the capture fetch hits the real URL).
test("13.3: POST /share strips trailing punctuation from a URL found in text", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  const { eq } = await import("drizzle-orm");
  const { items } = await import("./db/schema.js");
  try {
    const res = await app.inject({
      method: "POST",
      url: "/share",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "text=" + encodeURIComponent("loved this: https://punct.example/p."),
    });
    assert.equal(res.statusCode, 200);
    assert.ok(handle.db.select().from(items).where(eq(items.source, "https://punct.example/p")).get(),
      "stored URL has no trailing dot");
    assert.equal(handle.db.select().from(items).where(eq(items.source, "https://punct.example/p.")).get(), undefined,
      "the punctuation-suffixed URL was NOT stored");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Story 16.3: archive footprint read route ---

test("16.3: GET /api/archive/footprint reports snapshot-only bytes + count (read-only)", async () => {
  const { initDb } = await import("./db/index.js");
  const { seed } = await import("./db/seed.js");
  const { items, assets } = await import("./db/schema.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-foot-"));
  const snapshotsDir = path.join(dir, "snapshots");
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const handle = initDb(path.join(dir, "c.db"));
  seed(handle.db);
  const app = await buildServer({ db: handle, snapshotsDir });
  try {
    handle.db.insert(items).values({ id: "f1", boardId: "library", source: "https://a" }).run();
    fs.writeFileSync(path.join(snapshotsDir, "f1.html"), "z".repeat(200));
    handle.db.insert(assets).values({ id: "f1-snapshot", itemId: "f1", kind: "snapshot", path: "snapshots/f1.html" }).run();
    handle.db.insert(assets).values({ id: "f1-shot", itemId: "f1", kind: "screenshot", path: "screenshots/f1.png" }).run();

    const res = await app.inject({ method: "GET", url: "/api/archive/footprint" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { totalBytes: 200, count: 1 }, "snapshot-only total (screenshot excluded)");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Backup (streamed tar export/restore) ---
// Named "backup", not "archive": in this codebase `archive` already means the
// page-snapshot archival feature (/api/archive/footprint, archive-backfill).

test("GET /api/backup streams a tar backup; POST /api/backup restores it", async () => {
  // The round trip that makes an export a real backup: metadata AND image bytes, over
  // a transport that does not depend on holding ~110MB in a browser string.
  const { initDb } = await import("./db/index.js");
  const { seed } = await import("./db/seed.js");
  const { writeItem } = await import("./db/queue.js");
  const { boards, items } = await import("./db/schema.js");

  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-arcsrc-"));
  const srcShots = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-arcshots-"));
  const src = initDb(path.join(srcDir, "s.db"));
  seed(src.db);
  try {
    src.db.insert(boards).values({ id: "wishlist", name: "Wish List", view: "grid", descriptor: { name: "Wish List", fields: [], view: "grid", ingest_mode: "url-screenshot" } as any }).run();
    fs.writeFileSync(path.join(srcShots, "w1.png"), Buffer.alloc(300, 3));
    await writeItem(src, { id: "w1", boardId: "wishlist", source: "https://example.com/w", title: "W" },
      [{ id: "w1-shot", itemId: "w1", kind: "screenshot", path: "screenshots/w1.png" }]);

    const srcApp = await buildServer({ db: src, screenshotsDir: srcShots });
    const dl = await srcApp.inject({ method: "GET", url: "/api/backup" });
    assert.equal(dl.statusCode, 200);
    assert.match(String(dl.headers["content-disposition"]), /attachment; filename=/);
    const tar = dl.rawPayload;
    assert.ok(tar.length % 512 === 0, "a tar is whole 512-byte blocks");
    assert.equal(tar.subarray(257, 262).toString(), "ustar");

    // Restore into a DIFFERENT, empty install.
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-arcdest-"));
    const destShots = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-arcdshots-"));
    const dest = initDb(path.join(destDir, "d.db"));
    try {
      const destApp = await buildServer({ db: dest, screenshotsDir: destShots });
      const up = await destApp.inject({
        method: "POST", url: "/api/backup",
        headers: { "content-type": "application/x-tar" },
        payload: tar,
      });
      assert.equal(up.statusCode, 200, up.body);
      const body = JSON.parse(up.body) as any;
      assert.ok(body.boardsCreated >= 4, "every board is recreated on the empty install");
      assert.equal(body.itemsCreated, 1);
      assert.equal(body.filesRestored, 1, "the image bytes travel too");

      const row = dest.db.select().from(items).where(eq(items.id, "w1")).get();
      assert.ok(row, "the composed board item exists after restore");
      assert.ok(fs.existsSync(path.join(destShots, "w1.png")), "the screenshot file lands in the new install");

      // And the restored image actually serves (this is what 'not a backup' used to break).
      const served = await destApp.inject({ method: "GET", url: "/screenshots/w1.png" });
      assert.equal(served.statusCode, 200);
    } finally {
      dest.sqlite.close();
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.rmSync(destShots, { recursive: true, force: true });
    }
  } finally {
    src.sqlite.close();
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(srcShots, { recursive: true, force: true });
  }
});

// --- Settings (runtime-editable analysis prompt) ---

test("GET /api/settings exposes stored values and the built-in defaults", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as any;
    // The UI needs the default to show as placeholder text and to offer "restore".
    assert.ok(body.defaults["inspiration.system_prompt"].length > 0, "the built-in default is served");
    assert.ok(!/naruki/i.test(body.defaults["inspiration.system_prompt"]));
    assert.deepEqual(body.settings, {}, "nothing is overridden on a fresh install");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PATCH /api/settings saves an override and reads back", async () => {
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const save = await app.inject({
      method: "PATCH", url: "/api/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { "inspiration.system_prompt": "Only brutalist typography." } }),
    });
    assert.equal(save.statusCode, 200, save.body);
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    assert.equal(JSON.parse(res.body).settings["inspiration.system_prompt"], "Only brutalist typography.");
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PATCH /api/settings refuses a key outside the allowlist", async () => {
  // The store is generic; the ROUTE is not. An open write surface would let anything
  // scribble arbitrary keys into the same file the collection lives in.
  const { app, handle, dir } = await seededSqliteApp();
  try {
    const res = await app.inject({
      method: "PATCH", url: "/api/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { "evil": "x" } }),
    });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /not a writable setting|unknown/i);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
