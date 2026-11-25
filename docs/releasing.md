# Releasing from a commit

A pinned release (a deployment that pins a hash of every source file and refuses to
start if any differs) must be built from a **commit that is on the remote**, never
from a working tree.

```bash
git fetch origin
npm run release:source -- --commit <sha-or-ref> --out /path/to/new-empty-dir --require-pushed
```

This writes `<out>/tree/**` (the tracked files at that commit) and
`<out>/manifest.json`:

```json
{ "commit": "<full sha>", "sourceState": "committed", "buildSha256": "…", "files": { "src/server.ts": "<sha256>" } }
```

`buildSha256` is the sha256 of the JSON of the sorted `[path, sha256]` pairs, so a
loader that pins it can verify the tree. Uncommitted changes and untracked files are ignored by
construction; `--require-pushed` fails when the commit is not reachable from a
`<remote>/*` branch, so the live source can always be recovered from the remote.

Why: a release assembled from an uncommitted worktree diff leaves no commit, branch or
PR that matches what is running, so "which source is live?" has no answer.

Do not edit a release directory in place; build a new one and regenerate the
pinned hashes.
