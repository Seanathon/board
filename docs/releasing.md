# Releasing from a commit

A pinned release (an instance config that hashes every public file) must be built
from a **commit that is on the remote**, never from a working tree.

```bash
git fetch origin
npm run release:source -- --commit <sha-or-ref> --out /path/to/new-empty-dir --require-pushed
```

This writes `<out>/tree/**` (the tracked files at that commit) and
`<out>/manifest.json`:

```json
{ "commit": "<full sha>", "sourceState": "committed", "buildSha256": "…", "files": { "src/server.ts": "<sha256>" } }
```

`buildSha256` is the value `private-entry.mjs` checks (`publicBuildSha256` in the
instance config). Uncommitted changes and untracked files are ignored by
construction; `--require-pushed` fails when the commit is not reachable from a
`<remote>/*` branch, so the live source can always be recovered from the remote.

Why: `browser-discovery-20261115-r4` was assembled from an uncommitted worktree diff
(its manifest says `sourceState: "uncommitted-feature-on-merged-main"`), so no
commit, branch or PR matched what was running.

Do not edit a release directory in place; build a new one and regenerate the
instance's manifest hashes.
