import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportCommit, buildSha256 } from '../scripts/release-source.mjs';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();

describe('release-source: build a release from a commit, not the working tree', () => {
  let root: string;
  let repo: string;
  let committed: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'board-release-src-'));
    repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    git(root, 'init', '-q', repo);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'one');
    committed = git(repo, 'rev-parse', 'HEAD');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('exports exactly the committed files and a manifest a pinned-release loader can verify', () => {
    const out = join(root, 'out1');
    const m = exportCommit({ repo, ref: 'HEAD', outDir: out });
    assert.equal(m.commit, committed);
    assert.equal(m.sourceState, 'committed');
    assert.deepEqual(Object.keys(m.files).sort(), ['run.sh', 'src/a.ts']);
    assert.equal(m.files['src/a.ts'], createHash('sha256').update('export const a = 1;\n').digest('hex'));
    assert.equal(m.buildSha256, buildSha256(m.files));
    assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).buildSha256, m.buildSha256);
    assert.equal(readFileSync(join(out, 'tree', 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.ok((statSync(join(out, 'tree', 'run.sh')).mode & 0o111) !== 0, 'executable bit kept');
  });

  it('ignores uncommitted edits and untracked files', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 999; // uncommitted\n');
    writeFileSync(join(repo, 'src', 'new-untracked.ts'), 'x\n');
    const m = exportCommit({ repo, ref: 'HEAD', outDir: join(root, 'out2') });
    assert.deepEqual(Object.keys(m.files).sort(), ['run.sh', 'src/a.ts']);
    assert.equal(readFileSync(join(root, 'out2', 'tree', 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
    git(repo, 'checkout', '--', 'src/a.ts');
    rmSync(join(repo, 'src', 'new-untracked.ts'));
  });

  it('is deterministic for the same commit', () => {
    const a = exportCommit({ repo, ref: committed, outDir: join(root, 'det-a') });
    const b = exportCommit({ repo, ref: committed, outDir: join(root, 'det-b') });
    assert.equal(a.buildSha256, b.buildSha256);
  });

  it('refuses a commit that is not on the remote when --require-pushed is set', () => {
    assert.throws(() => exportCommit({ repo, ref: 'HEAD', outDir: join(root, 'np'), requirePushed: true }), /not on any origin branch/);
    git(repo, 'update-ref', 'refs/remotes/origin/main', committed);
    const m = exportCommit({ repo, ref: 'HEAD', outDir: join(root, 'pushed'), requirePushed: true });
    assert.equal(m.commit, committed);
  });

  it('refuses a non-empty output directory and unknown refs', () => {
    const dir = join(root, 'busy');
    mkdirSync(dir);
    writeFileSync(join(dir, 'x'), '1');
    assert.throws(() => exportCommit({ repo, ref: 'HEAD', outDir: dir }), /not empty/);
    assert.throws(() => exportCommit({ repo, ref: 'no-such-ref', outDir: join(root, 'nr') }));
  });

  it('refuses symlinks in the tree rather than following them', () => {
    const r2 = join(root, 'repo2');
    mkdirSync(r2);
    git(root, 'init', '-q', r2);
    symlinkSync('/etc/passwd', join(r2, 'link'));
    git(r2, 'add', '-A');
    git(r2, 'commit', '-q', '-m', 'link');
    assert.throws(() => exportCommit({ repo: r2, ref: 'HEAD', outDir: join(root, 'sym') }), /Unsupported tree entry/);
  });

  it('the CLI runs when invoked through a symlinked path (it used to exit 0 and do nothing)', () => {
    const real = fileURLToPath(new URL('../scripts/release-source.mjs', import.meta.url));
    const link = join(root, 'linked-release-source.mjs');
    symlinkSync(real, link);
    const out = join(root, 'cli-out');
    const stdout = execFileSync(process.execPath, [link, '--commit', 'HEAD', '--out', out], { cwd: repo, stdio: 'pipe' }).toString();
    assert.equal(JSON.parse(stdout).commit, committed);
    assert.ok(existsSync(join(out, 'manifest.json')));
  });
});
