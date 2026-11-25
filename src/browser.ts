// Shared headless-Chrome helpers. Used by both the inspiration (screenshot)
// and library (JS-render fallback) capture paths.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { config } from "./config.js";

// macOS dev default (the prototype's old hardcoded path) kept as a last-resort
// candidate. The Debian LXC deploy target uses chromium/chromium-browser, so those
// are probed first.
const MACOS_DEFAULT = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CANDIDATES = ["chromium", "chromium-browser", "google-chrome", MACOS_DEFAULT];

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  // matters on the small LXC (limited /dev/shm) — do not drop.
  "--disable-dev-shm-usage",
];

/** Resolve a candidate to an absolute path, or null. */
export type ChromeLookup = (candidate: string) => string | null;

// Default lookup: absolute paths via existsSync; bare names via a which-style PATH
// search. ONE lookup for both kinds so autodetect is fully injectable for tests
// (no branch hits the real environment when a fake lookup is passed).
const defaultLookup: ChromeLookup = (candidate) => {
  if (candidate.includes("/")) return existsSync(candidate) ? candidate : null;
  try {
    const out = execFileSync("which", [candidate], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out.length > 0 && existsSync(out) ? out : null;
  } catch {
    return null;
  }
};

/**
 * Resolve the Chrome/Chromium executable path. `chromePath` (the configured value)
 * wins; otherwise probe CANDIDATES in order via `lookup`; otherwise throw a clear,
 * named error telling the user to set CHROME_PATH. Pure + injectable for tests.
 */
export function resolveChromePath(
  opts: { chromePath?: string | null; lookup?: ChromeLookup } = {},
): string {
  const { chromePath, lookup = defaultLookup } = opts;
  if (chromePath) return chromePath;
  for (const candidate of CANDIDATES) {
    const found = lookup(candidate);
    if (found) return found;
  }
  throw new Error(
    "No Chrome/Chromium found. Set CHROME_PATH to your browser binary " +
      "(e.g. /usr/bin/chromium), or install chromium.",
  );
}

/**
 * The single headless-Chrome launch seam. Resolution happens HERE (at launch time),
 * not at module load — so a box with no Chrome still boots and serves the UI
 * (NFR-4); only an actual capture surfaces the missing-Chrome error. Both capture
 * paths (add.ts screenshot + renderPageText) call this.
 */
export async function launchBrowser(
  overrides?: { chromePath?: string | null; lookup?: ChromeLookup; extraArgs?: string[]; timeoutMs?: number },
): Promise<import("puppeteer-core").Browser> {
  // Honor an EXPLICIT chromePath override (incl. `null`) so tests are hermetic and
  // independent of the ambient CHROME_PATH env. `??` would swallow an explicit null
  // and fall back to config — reintroducing real-env dependence in tests.
  const chromePath =
    overrides && "chromePath" in overrides ? overrides.chromePath : config.chromePath;
  const executablePath = resolveChromePath({ chromePath, lookup: overrides?.lookup });
  const puppeteer = await import("puppeteer-core");
  return puppeteer.default.launch({ executablePath, headless: true, args: [...LAUNCH_ARGS, ...(overrides?.extraArgs ?? [])], timeout: overrides?.timeoutMs });
}

/**
 * Render a URL in headless Chrome and return its visible text (document.body.innerText).
 * Used as a fallback for JS-rendered pages (SPAs) whose server HTML has no readable body.
 * Uses `domcontentloaded` + a short settle delay rather than `networkidle2`, which times
 * out on pages with persistent connections (analytics, ads, websockets).
 */
export async function renderPageText(url: string): Promise<string> {
  let browser: import("puppeteer-core").Browser | undefined;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));
    const text = await page.evaluate(() =>
      (document.body.innerText || "").substring(0, 10000)
    );
    return text;
  } finally {
    await browser?.close().catch(() => {});
  }
}
