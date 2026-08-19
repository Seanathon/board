import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnalysisCommand,
  normalizeUrl,
  parseJsonFromText,
  resolveAnalysisAgent,
  resolveTargetCollection,
  toCodexOutputSchema,
  validateAnalysis,
  systemPromptFor,
  DEFAULT_INSPIRATION_PROMPT,
} from "./add.js";

const validAnalysis = {
  title: "Example",
  meta: {
    audience: "consumer",
    form: "app",
    domain: null,
    tags: ["editorial", "warm"],
    tier: "reference",
    tone: ["warm", "focused"],
  },
  design: {
    steal_this: "Lead with one concrete product moment.",
    above_fold: "A focused hero with product proof.",
    nav_pattern: "Simple top navigation.",
    whitespace: "Balanced spacing around key sections.",
    color_story: "Warm neutrals with a crisp accent.",
    design_system_score: "semi-systematic",
  },
  reflection: {
    five_second_message: "This product helps you make progress.",
  },
};

test("normalizeUrl adds https and strips query params", () => {
  const parsed = normalizeUrl("example.com/path?utm_source=test#pricing");

  assert.equal(parsed.toString(), "https://example.com/path#pricing");
});

test("validateAnalysis accepts a complete analysis", () => {
  assert.deepEqual(validateAnalysis(validAnalysis), validAnalysis);
});

test("validateAnalysis rejects invalid taxonomy and array sizes", () => {
  assert.throws(
    () =>
      validateAnalysis({
        ...validAnalysis,
        meta: {
          ...validAnalysis.meta,
          audience: "everyone",
          tags: ["a", "b", "c", "d", "e", "f", "g"],
        },
      }),
    /meta\.audience must be one of:[\s\S]*tags must contain at most 6 items/
  );
});

test("resolveAnalysisAgent defaults to Claude Code on Sonnet", () => {
  // No --model means `claude -p` inherits the operator's interactive default (Opus on a
  // subscription box) for what is a schema-shaped extraction. Pin Sonnet, same as the
  // server path (llm/select-provider resolveCliAgent), so both headless callers agree.
  assert.deepEqual(resolveAnalysisAgent(undefined, {}), { id: "claude", model: "sonnet" });
});

test("resolveAnalysisAgent supports requested agents and env model overrides", () => {
  assert.deepEqual(resolveAnalysisAgent("claude", { BOARD_CLAUDE_MODEL: "claude-opus-4.5" }), {
    id: "claude",
    model: "claude-opus-4.5",
  });
  assert.deepEqual(resolveAnalysisAgent("codex", { BOARD_CODEX_MODEL: "gpt-5.2" }), {
    id: "codex",
    model: "gpt-5.2",
  });
});

test("resolveAnalysisAgent uses BOARD_ANALYSIS_AGENT and rejects invalid agents", () => {
  assert.deepEqual(resolveAnalysisAgent(undefined, { BOARD_ANALYSIS_AGENT: "codex" }), {
    id: "codex",
    model: null,
  });

  assert.throws(() => resolveAnalysisAgent("pi", {}), /Invalid analysis agent/);
  assert.throws(() => resolveAnalysisAgent("gemini", {}), /Invalid analysis agent/);
  assert.throws(() => resolveAnalysisAgent(undefined, { BOARD_ANALYSIS_AGENT: "gemini" }), /Invalid analysis agent/);
});

test("parseJsonFromText parses raw and fenced JSON output", () => {
  assert.deepEqual(parseJsonFromText(JSON.stringify(validAnalysis)), validAnalysis);
  assert.deepEqual(parseJsonFromText(`\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\``), validAnalysis);
  assert.deepEqual(parseJsonFromText(`Here is the JSON:\n${JSON.stringify(validAnalysis)}\nDone.`), validAnalysis);
});

test("toCodexOutputSchema makes nested object schemas strict", () => {
  const schema = toCodexOutputSchema({
    type: "object",
    required: ["meta"],
    properties: {
      meta: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          score: { type: "string" },
        },
      },
    },
  });

  assert.deepEqual(schema, {
    type: "object",
    properties: {
      meta: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          score: { type: "string" },
        },
        required: ["tags", "score"],
        additionalProperties: false,
      },
    },
    required: ["meta"],
    additionalProperties: false,
  });
});

test("buildAnalysisCommand constructs Claude command with disabled tools and schema", () => {
  const schema = { type: "object", properties: { title: { type: "string" } } };
  const systemPrompt = "custom system prompt for test";
  const command = buildAnalysisCommand({ id: "claude", model: "claude-model" }, "prompt", schema, systemPrompt);

  assert.equal(command.command, "claude");
  assert.deepEqual(command.args.slice(0, 6), ["-p", "prompt", "--tools", "", "--output-format", "json"]);
  const schemaIdx = command.args.indexOf("--json-schema");
  assert.ok(schemaIdx !== -1, "should have --json-schema");
  assert.equal(command.args[schemaIdx + 1], JSON.stringify(schema));
  const sysIdx = command.args.indexOf("--append-system-prompt");
  assert.ok(sysIdx !== -1, "should have --append-system-prompt");
  assert.equal(command.args[sysIdx + 1], systemPrompt);
  assert.deepEqual(command.args.slice(-2), ["--model", "claude-model"]);
});

test("buildAnalysisCommand constructs Codex command with read-only schema output files", () => {
  const schema = { type: "object" };
  const systemPrompt = "system";
  const command = buildAnalysisCommand(
    { id: "codex", model: "gpt-5.2" },
    "prompt",
    schema,
    systemPrompt,
    { schemaFile: "/tmp/schema.json", resultFile: "/tmp/result.json" }
  );

  assert.equal(command.command, "codex");
  assert.deepEqual(command.args, [
    "--ask-for-approval", "never",
    "exec",
    "--ephemeral",
    "--sandbox", "read-only",
    "--output-schema", "/tmp/schema.json",
    "--output-last-message", "/tmp/result.json",
    "--model", "gpt-5.2",
    "prompt",
  ]);
});

// --- resolveTargetCollection ---

test("resolveTargetCollection defaults to inspiration when no flag or env", () => {
  const { collection, processor } = resolveTargetCollection(["node", "add.ts"], {});
  assert.equal(collection.id, "inspiration");
  assert.equal(collection.type, "inspiration");
  assert.equal(processor.type, "inspiration");
});

test("resolveTargetCollection uses --collection flag", () => {
  const { collection } = resolveTargetCollection(
    ["node", "add.ts", "--collection", "inspiration"], {}
  );
  assert.equal(collection.id, "inspiration");
});

test("resolveTargetCollection uses BOARD_COLLECTION env when no flag", () => {
  const { collection } = resolveTargetCollection(
    ["node", "add.ts"], { BOARD_COLLECTION: "inspiration" }
  );
  assert.equal(collection.id, "inspiration");
});

test("resolveTargetCollection flag beats BOARD_COLLECTION env", () => {
  // flag=inspiration (registered), env=library (would throw at getProcessor if resolved)
  const { collection, processor } = resolveTargetCollection(
    ["node", "add.ts", "--collection", "inspiration"],
    { BOARD_COLLECTION: "library" }
  );
  assert.equal(collection.id, "inspiration");
  assert.equal(processor.type, "inspiration");
});

test("resolveTargetCollection throws on unknown collection id", () => {
  assert.throws(
    () => resolveTargetCollection(["node", "add.ts", "--collection", "no-such-id"], {}),
    /Unknown collection/
  );
});

test("resolveTargetCollection succeeds for registered 'library' collection", () => {
  const { collection, processor } = resolveTargetCollection(
    ["node", "add.ts", "--collection", "library"], {}
  );
  assert.equal(collection.id, "library");
  assert.equal(processor.type, "library");
});

// The analysis prompt was a hardcoded brief for the author's own product. It is now
// the built-in DEFAULT, overridable per processor type from the settings store, so a
// user can retune the AI's lens without editing source.
test("systemPromptFor falls back to the built-in default when nothing is stored", async () => {
  const { initDb } = await import("./db/index.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-prompt-"));
  const handle = initDb(path.join(dir, "p.db"));
  try {
    assert.equal(systemPromptFor(handle, "inspiration", DEFAULT_INSPIRATION_PROMPT), DEFAULT_INSPIRATION_PROMPT);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("systemPromptFor prefers a stored override, and ignores a blank one", async () => {
  const { initDb } = await import("./db/index.js");
  const { setSetting } = await import("./db/settings.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-oss-prompt2-"));
  const handle = initDb(path.join(dir, "p.db"));
  try {
    setSetting(handle, "inspiration.system_prompt", "Analyze for brutalist typography only.");
    assert.equal(systemPromptFor(handle, "inspiration", DEFAULT_INSPIRATION_PROMPT), "Analyze for brutalist typography only.");

    // Clearing the box in the UI must restore the default rather than send an empty
    // system prompt to the model.
    setSetting(handle, "inspiration.system_prompt", "   ");
    assert.equal(systemPromptFor(handle, "inspiration", DEFAULT_INSPIRATION_PROMPT), DEFAULT_INSPIRATION_PROMPT);
  } finally {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the built-in default names no personal project and keeps the untrusted-content guard", () => {
  assert.ok(!/naruki/i.test(DEFAULT_INSPIRATION_PROMPT), "the shipped default must be generic");
  assert.match(DEFAULT_INSPIRATION_PROMPT, /untrusted/i, "the prompt-injection guard must survive generalization");
});
