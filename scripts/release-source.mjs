#!/usr/bin/env node
/**
 * Export a release's public source FROM A COMMIT (never the working tree) and write
 * the pinned manifest that private-entry.mjs verifies.
 *
 * Why: the browser-discovery-20261115-r4 release was assembled from an uncommitted
 * worktree diff, so no commit, branch or PR matched what was running. Building from a
 * commit makes "which source is live" answerable with `git show <commit>`.
 *
 *   node scripts/release-source.mjs --commit <ref> --out <empty dir> [--require-pushed] [--remote origin]
 *
 * Writes <out>/tree/** (the tracked files at that commit) and <out>/manifest.json:
 *   { commit, sourceState: "committed", buildSha256, files: { path: sha256 } }
 * `buildSha256` uses the exact formula private-entry.mjs checks. Uncommitted changes
 * are ignored by construction. With --require-pushed the commit must already be
 * reachable from a remote branch, so the source is recoverable from the remote.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (repo, args, options = {}) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 256 * 1024 * 1024, ...options });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {Record<string, string>} files path -> sha256 */
export function buildSha256(files) {
  return sha256(JSON.stringify(Object.keys(files).sort().map((key) => [key, files[key]])));
}

/**
 * @param {{ repo: string, ref: string, outDir: string, requirePushed?: boolean, remote?: string }} options
 * @returns {{ commit: string, sourceState: string, buildSha256: string, files: Record<string, string> }}
 */
export function exportCommit({ repo, ref, outDir, requirePushed = false, remote = 'origin' }) {
  const commit = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
  if (requirePushed) {
    const remotes = git(repo, ['branch', '-r', '--contains', commit, '--list', `${remote}/*`]).toString().trim();
    if (!remotes) throw new Error(`Commit ${commit} is not on any ${remote} branch; push it before releasing`);
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error(`Output directory is not empty: ${outDir}`);
  const entries = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString().split('\0').filter(Boolean);
  /** @type {Record<string, string>} */
  const files = {};
  const treeDir = path.join(outDir, 'tree');
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const [mode, type] = entry.slice(0, tab).split(' ');
    const name = entry.slice(tab + 1);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`Unsupported tree entry (${mode} ${type}): ${name}`);
    if (path.isAbsolute(name) || name.split('/').includes('..')) throw new Error(`Unsafe path in tree: ${name}`);
    const bytes = git(repo, ['cat-file', 'blob', `${commit}:${name}`]);
    mkdirSync(path.dirname(path.join(treeDir, name)), { recursive: true });
    writeFileSync(path.join(treeDir, name), bytes, { mode: mode === '100755' ? 0o755 : 0o644 });
    files[name] = sha256(bytes);
  }
  const manifest = { commit, sourceState: 'committed', buildSha256: buildSha256(files), files };
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
  const ref = value('--commit');
  const out = value('--out');
  if (!ref || !out) {
    console.error('usage: release-source.mjs --commit <ref> --out <dir> [--require-pushed] [--remote origin]');
    process.exit(64);
  }
  try {
    const manifest = exportCommit({ repo: process.cwd(), ref, outDir: path.resolve(out), requirePushed: args.includes('--require-pushed'), remote: value('--remote') ?? 'origin' });
    console.log(JSON.stringify({ commit: manifest.commit, buildSha256: manifest.buildSha256, files: Object.keys(manifest.files).length, out: path.resolve(out) }));
  } catch (err) {
    console.error(`release-source: ${err.message}`);
    process.exit(2);
  }
}
