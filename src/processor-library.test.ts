import assert from "node:assert/strict";
import test from "node:test";
import "./processor-library.js"; // registers the library processor as a module side-effect
import { captureLibrary, extractOgImage, extractReadableMarkdown, validateLibraryAnalysis } from "./processor-library.js";
import { getProcessor } from "./processors.js";

// HTML fixture: clear article plus nav/footer noise
const ARTICLE_HTML = `
<html>
<head><title>Building Better APIs</title></head>
<body>
  <nav>Site Navigation: <a href="/home">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav>
  <article>
    <h1>Building Better APIs</h1>
    <p>This article explores patterns for designing REST APIs that scale well across large teams.</p>
    <p>Key considerations include pagination strategies, consistent error handling, and versioning approaches.</p>
  </article>
  <footer>Copyright 2024 | Privacy Policy | Terms of Service | Cookie Policy</footer>
</body>
</html>
`;

// HTML fixture with no article-like content (fallback path)
const NO_ARTICLE_HTML = `
<html>
<head><title>Home</title></head>
<body>
  <nav>Home | Products | Services | Contact</nav>
  <div class="sidebar">Categories: Tech, Design, Business</div>
</body>
</html>
`;

const validLibraryAnalysis = {
  title: "Building Better APIs",
  summary: "An article about REST API design patterns that scale well.",
  topics: ["api", "rest", "design"],
  author: "Jane Doe",
  type: "article",
  key_points: [
    "Use consistent error formats",
    "Design for pagination from day one",
  ],
};

// --- extractReadableMarkdown ---

test("extractReadableMarkdown returns markdown with article heading and content", () => {
  const md = extractReadableMarkdown(ARTICLE_HTML, "https://example.com/article");
  assert.ok(md.includes("Building Better APIs"), "should include article heading");
  assert.ok(md.includes("REST APIs"), "should include article body text");
});

test("extractReadableMarkdown excludes nav and footer noise", () => {
  const md = extractReadableMarkdown(ARTICLE_HTML, "https://example.com/article");
  assert.ok(!md.includes("Site Navigation"), "should exclude nav text");
  assert.ok(!md.includes("Copyright 2024"), "should exclude footer text");
  assert.ok(!md.includes("Privacy Policy"), "should exclude footer links");
});

test("extractReadableMarkdown fallback: returns text content for non-article pages without throwing", () => {
  let result: string;
  assert.doesNotThrow(() => {
    result = extractReadableMarkdown(NO_ARTICLE_HTML, "https://example.com/");
  });
  assert.ok(typeof result! === "string", "should return a string");
});

test("extractReadableMarkdown truncates output to 10000 chars", () => {
  const longParagraph = `<p>${"x".repeat(15000)}</p>`;
  const html = `<html><body><article><h1>T</h1>${longParagraph}</article></body></html>`;
  const md = extractReadableMarkdown(html, "https://example.com/");
  assert.ok(md.length <= 10000, `output length ${md.length} exceeds 10000`);
});

// --- captureLibrary fetch + headless-render fallback ---

const SPA_SHELL_HTML = `<html><head><title>App</title></head><body><div id="root"></div></body></html>`;

function fetchReturning(html: string): typeof fetch {
  return (async () => ({ text: async () => html })) as unknown as typeof fetch;
}

test("captureLibrary falls back to headless render when fetch+readability yields too little text", async () => {
  let renderedUrl: string | null = null;
  const renderImpl = async (url: string) => {
    renderedUrl = url;
    return "Anytype is a local-first knowledge base. ".repeat(20);
  };
  const cap = await captureLibrary("https://anytype.io/", {
    fetchImpl: fetchReturning(SPA_SHELL_HTML),
    renderImpl,
  });
  assert.equal(renderedUrl, "https://anytype.io/", "should invoke headless render fallback with the url");
  assert.ok(cap.text.includes("Anytype is a local-first knowledge base"), "should return rendered text");
});

// The direct fetch was unbounded, so a server that accepts the connection and then
// never responds pinned the item in `processing` until the whole capture job expired
// (CAPTURE_TIMEOUT_MS, now 600s) — and the job lane is serial, so every queued add sat
// behind it. Longer budgets are only safe for BOUNDED waits; this one needs its own.
test("captureLibrary bounds the direct fetch with an abort signal", async () => {
  let sawSignal: AbortSignal | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sawSignal = init?.signal ?? undefined;
    return { text: async () => ARTICLE_HTML };
  }) as unknown as typeof fetch;

  await captureLibrary("https://example.com/article", { fetchImpl, renderImpl: async () => "" });

  assert.ok(sawSignal, "the direct fetch must carry an abort signal, or it can hang forever");
  assert.equal(sawSignal.aborted, false, "and must not be aborted before the request starts");
});

test("captureLibrary uses fetch result and skips render when readability yields enough text", async () => {
  let renderCalled = false;
  const cap = await captureLibrary("https://example.com/article", {
    fetchImpl: fetchReturning(ARTICLE_HTML),
    renderImpl: async () => {
      renderCalled = true;
      return "should not be used";
    },
  });
  assert.equal(renderCalled, false, "render fallback must not run when fetch text is sufficient");
  assert.ok(cap.text.includes("Building Better APIs"), "should return the fetched article text");
});

test("captureLibrary folds a thrown render error (e.g. timeout) into the clear, specific error", async () => {
  await assert.rejects(
    () =>
      captureLibrary("https://anytype.io/", {
        fetchImpl: fetchReturning(SPA_SHELL_HTML),
        renderImpl: async () => {
          throw new Error("Navigation timeout of 30000 ms exceeded");
        },
      }),
    (err: Error) => {
      assert.match(err.message, /anytype\.io/, "error should name the url");
      assert.match(err.message, /JS-rendered|blocked/i, "error should explain the likely cause");
      assert.match(err.message, /Navigation timeout/, "error should include the underlying render failure reason");
      return true;
    }
  );
});

test("captureLibrary throws a clear, specific error when both fetch and render yield too little text", async () => {
  await assert.rejects(
    () =>
      captureLibrary("https://anytype.io/", {
        fetchImpl: fetchReturning(SPA_SHELL_HTML),
        renderImpl: async () => "",
      }),
    (err: Error) => {
      assert.match(err.message, /anytype\.io/, "error should name the url");
      assert.match(err.message, /JS-rendered|blocked/i, "error should explain the likely cause");
      return true;
    }
  );
});

// --- validateLibraryAnalysis ---

test("validateLibraryAnalysis accepts a valid library analysis", () => {
  assert.deepEqual(validateLibraryAnalysis(validLibraryAnalysis), validLibraryAnalysis);
});

test("validateLibraryAnalysis rejects bad type enum", () => {
  assert.throws(
    () => validateLibraryAnalysis({ ...validLibraryAnalysis, type: "tweet" }),
    /type must be one of/
  );
});

test("validateLibraryAnalysis rejects topics exceeding 6 items", () => {
  assert.throws(
    () => validateLibraryAnalysis({ ...validLibraryAnalysis, topics: ["a", "b", "c", "d", "e", "f", "g"] }),
    /topics must contain at most 6 items/
  );
});

test("validateLibraryAnalysis rejects missing summary", () => {
  const { summary: _s, ...withoutSummary } = validLibraryAnalysis;
  assert.throws(
    () => validateLibraryAnalysis(withoutSummary),
    /summary must be a non-empty string/
  );
});

test("validateLibraryAnalysis rejects key_points below minimum (< 2)", () => {
  assert.throws(
    () => validateLibraryAnalysis({ ...validLibraryAnalysis, key_points: ["only one"] }),
    /key_points must contain at least 2 items/
  );
});

test("validateLibraryAnalysis rejects key_points exceeding 6 items", () => {
  assert.throws(
    () => validateLibraryAnalysis({ ...validLibraryAnalysis, key_points: ["a", "b", "c", "d", "e", "f", "g"] }),
    /key_points must contain at most 6 items/
  );
});

// --- libraryProcessor.buildEntry ---

test("libraryProcessor.buildEntry assembles correct library entry shape", () => {
  const p = getProcessor("library");
  const entry = p.buildEntry({
    id: "example-com-12345",
    url: "https://example.com/article",
    analysis: validLibraryAnalysis,
    captured: { text: "article text", screenshotPath: null },
    agent: { id: "claude", model: null },
  });
  assert.equal(entry.id, "example-com-12345");
  assert.equal(entry.url, "https://example.com/article");
  assert.match(entry.added as string, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(entry.title, validLibraryAnalysis.title);
  assert.equal(entry.summary, validLibraryAnalysis.summary);
  assert.deepEqual(entry.topics, validLibraryAnalysis.topics);
  assert.equal(entry.author, validLibraryAnalysis.author);
  assert.equal(entry.type, validLibraryAnalysis.type);
  assert.deepEqual(entry.key_points, validLibraryAnalysis.key_points);
  assert.equal(entry.notes, "", "notes should start as empty string");
  assert.equal(entry.analysis_agent, "claude");
  assert.equal(entry.analysis_model, null);
  assert.ok(!("screenshot" in entry), "should have no screenshot key");
});

test("libraryProcessor.buildEntry sets notes to empty string", () => {
  const p = getProcessor("library");
  const entry = p.buildEntry({
    id: "x",
    url: "https://x.com",
    analysis: validLibraryAnalysis,
    captured: { text: "", screenshotPath: null },
    agent: { id: "codex", model: "gpt-5" },
  });
  assert.equal(entry.notes, "");
  assert.equal(entry.analysis_agent, "codex");
  assert.equal(entry.analysis_model, "gpt-5");
});

test("libraryProcessor.buildEntry refetch branch: preserves notes from existing", () => {
  const p = getProcessor("library");
  const existing: Record<string, unknown> = {
    id: "x",
    url: "https://x.com/old",
    added: "2025-03-01",
    title: "Old",
    summary: "Old summary",
    topics: ["old"],
    author: null,
    type: "article",
    key_points: ["old point one", "old point two"],
    notes: "user research notes",
    analysis_agent: "claude",
    analysis_model: null,
  };
  const entry = p.buildEntry({
    id: "x",
    url: "https://x.com",
    analysis: validLibraryAnalysis,
    captured: { text: "", screenshotPath: null },
    agent: { id: "claude", model: null },
    existing,
  });
  assert.equal(entry.notes, "user research notes", "existing notes must be preserved");
  assert.equal(entry.id, "x");
  assert.equal(entry.added, "2025-03-01");
  assert.equal(entry.title, validLibraryAnalysis.title);
});

// --- summarize ---

test("libraryProcessor.summarize returns type, topics, and summary lines", () => {
  const p = getProcessor("library");
  assert.ok(typeof p.summarize === "function", "library processor must implement summarize");
  const entry: Record<string, unknown> = {
    type: "article",
    topics: ["ai", "agents", "llm"],
    summary: "An article about AI agents.",
    key_points: ["Point one", "Point two", "Point three"],
  };
  const lines = p.summarize!(entry);
  assert.ok(Array.isArray(lines) && lines.length > 0, "should return non-empty array");
  assert.ok(lines.some((l) => l.includes("article")), "should include type");
  assert.ok(lines.some((l) => l.includes("ai")), "should include topics");
  assert.ok(!lines.some((l) => l.includes("steal_this")), "should not reference inspiration design fields");
  assert.ok(!lines.some((l) => l.includes("audience")), "should not reference inspiration meta fields");
});

// --- extractOgImage (hero image for screenshot-less captures) ---

test("extractOgImage prefers og:image and returns an absolute URL", () => {
  const html = `<html><head><meta property="og:image" content="https://cdn.example/p/r1280t.jpg"></head><body>x</body></html>`;
  assert.equal(extractOgImage(html, "https://shop.example/r1280t"), "https://cdn.example/p/r1280t.jpg");
});

test("extractOgImage resolves a relative og:image against the page URL", () => {
  const html = `<html><head><meta property="og:image" content="/img/hero.png"></head></html>`;
  assert.equal(extractOgImage(html, "https://shop.example/products/r1280t"), "https://shop.example/img/hero.png");
});

test("extractOgImage falls back to twitter:image when og:image is absent", () => {
  const html = `<html><head><meta name="twitter:image" content="https://cdn.example/t.webp"></head></html>`;
  assert.equal(extractOgImage(html, "https://shop.example/x"), "https://cdn.example/t.webp");
});

test("extractOgImage reads a JSON-LD product image (string, array, or {url})", () => {
  const ld = (img: string) => `<html><head><script type="application/ld+json">${img}</script></head></html>`;
  const base = "https://shop.example/x";
  assert.equal(extractOgImage(ld(JSON.stringify({ "@type": "Product", image: "https://cdn.example/a.jpg" })), base), "https://cdn.example/a.jpg");
  assert.equal(extractOgImage(ld(JSON.stringify({ "@type": "Product", image: ["https://cdn.example/b.jpg"] })), base), "https://cdn.example/b.jpg");
  assert.equal(extractOgImage(ld(JSON.stringify({ "@type": "Product", image: { url: "https://cdn.example/c.jpg" } })), base), "https://cdn.example/c.jpg");
});

test("extractOgImage returns undefined when the page has no image and ignores malformed JSON-LD", () => {
  assert.equal(extractOgImage(`<html><head><title>No image here</title></head></html>`, "https://x.example"), undefined);
  assert.equal(extractOgImage(`<html><head><script type="application/ld+json">{ not json </script></head></html>`, "https://x.example"), undefined);
});
