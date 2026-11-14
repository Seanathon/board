# Guarded Radiator migration

This tool only migrates the approved `radiator-9k51` selection. It does not import,
reenrich, call a model, deploy code, or authorize production access. Local rehearsal
is authorized; production reads/writes retain their separate approval gates.

## Preconditions

- Use a compatible Node/native SQLite installation. Do not rebuild shared dependencies.
- Pause/drain application writers and capture/enrichment jobs for apply/undo. The
  transaction locks SQLite, not external asset files. Keep assets quiescent too.
- Supply an existing database and absolute current asset directory explicitly.
  There is **no** `DATA_DIR`/owner default or database bootstrap.
- Retain the verified original export, approved bundle, pinned original baseline,
  and isolated reference asset directory with its verified `asset-manifest.json`.
  Supply their independently recorded SHA256 fingerprints, including the archive
  and asset manifest. Never create new provenance to make an input pass.
- Create a private, existing backup directory **outside** the target data directory.
  Run before-images contain private notes and generated analysis; do not publish them.
- Before production, separately take/verify the approved service and consistent
  SQLite/WAL/assets backups. Migrator before-images are scoped recovery, not a
  replacement for a full disaster-recovery backup.

## Commands

The shell variables below are operator-selected paths/fingerprints, not defaults.
`NODE` must name the verified matching runtime; `DB` and `DATA` identify the
**disposable rehearsal** first. Run from the checked release worktree.

```sh
INPUT=(--target radiator-9k51 --db "$DB" --data-dir "$DATA"
  --selection "$SELECTION" --bundle "$BUNDLE" --baseline "$BASELINE"
  --source-data-dir "$REFERENCE_ASSETS"
  --selection-sha256 "$SELECTION_SHA256" --bundle-sha256 "$BUNDLE_SHA256"
  --archive-sha256 "$ARCHIVE_SHA256" --asset-manifest-sha256 "$ASSET_MANIFEST_SHA256")

# Omission of the subcommand also means dry-run. SELECT-only; no ledger creation.
"$NODE" --import tsx scripts/radiator-migrate.ts dry-run "${INPUT[@]}"

# Copy the exact conflict-free dry-run planDigest, never an input hash.
"$NODE" --import tsx scripts/radiator-migrate.ts apply "${INPUT[@]}" \
  --backup-dir "$BACKUP" --plan-digest "$PLAN_DIGEST"

"$NODE" --import tsx scripts/radiator-migrate.ts verify \
  --target radiator-9k51 --db "$DB" --data-dir "$DATA" --run-id "$RUN_ID"

# Explicit guarded undo, not a full restore:
"$NODE" --import tsx scripts/radiator-migrate.ts undo \
  --target radiator-9k51 --db "$DB" --data-dir "$DATA" --run-id "$RUN_ID"
```

Exit status: `0` clean/completed; `2` reported dry-run/verification conflicts;
`1` invalid input or rejected/failed operation. No `--force` exists. Unknown or
irrelevant flags are rejected. The CLI never accepts a prepared JSON artifact in
place of the approved input loader.

## Guards and accounting

Every original ID remains separate, including duplicate URLs. The prepared input
must contain all 119 selected IDs, at most 114 eligible replacements and five
retained-prior outcomes. Dry-run compares the exact board ID/name/view/descriptor,
original export record hashes and asset metadata **and bytes**. Added, moved,
deleted, edited, missing-asset and already-configured states are conflicts. Item
edit reports include changed top-level export keys (including notes).

Dry-run distinguishes `approvedEligible` (the 114 approved candidates) from
`eligible` (candidates without fresh item/asset/in-flight conflicts, or zero when
the board/profile guard fails). `conflictedSelected` counts distinct selected IDs
with conflicts; a global board/profile conflict affects all selected IDs. `added`,
`deleted`, and `moved` are distinct ID counts, not numbers of conflict messages.
`executableChanges` is zero if **any** conflict exists; fresh eligibility never
permits partial execution. `retained` remains the five-item no-patch cohort;
`retentionReasons` reports blocked-evidence, invalid-output and unspecified counts.

The plan digest binds the validated input, current full selected rows, board,
profile state, assets, and canonical current data directory. Apply revalidates
and recomputes everything inside its single transaction; it never rebases an old
plan. A lifecycle-only change after planning also invalidates that exact plan.
Selected pending/processing items are explicit in-flight conflicts at planning, verification and undo; drain jobs first. Other boards and assets are never written.

Before retiring fields, apply writes a private before-image file and fsyncs the
file, containing directory and its parent directory. Profile activation, typed item/search-index writes,
and the dedicated `radiator_migration_run` ledger commit atomically. A failure
rolls back SQLite completely; an orphan before-image may remain. Do not treat
that file alone as proof of a committed migration. An interrupted temporary file
is likewise not a committed run.

After interruption, repeat the **same apply input and original plan digest**.
The deterministic run ID discovers a committed ledger and verifies its owned
post-state instead of applying twice; otherwise fresh guards still have to pass.
A run already undone cannot silently be reapplied. Keep the recorded plan digest
and run ID with the operator's private evidence.

## Guarded undo and verification

Verify checks run state, exact membership, source identity, asset references and
bytes, model/provider columns, legacy/generated/reserved fields, owned descriptor
fields/prompt, profile value, and durable before-image integrity. It deliberately
permits later user curation; it is not a claim that the entire database is byte
identical to its post-apply snapshot.

Undo checks those guards **before any write** and restores only fields retired or
installed by this run plus model/provider columns and owned configuration. Later
notes, title, favorite, tags, tone, opaque user fields and unowned top-level
board-descriptor flags survive. Retained-prior rows are never written. Later AI
changes (including retained-prior generated analysis), added/moved/deleted items,
asset changes, owned descriptor edits or profile changes reject the whole undo.
There is no partial rollback or forced full-row restore. Repeated undo verifies
the already-undone state and returns without further writes.

## Verification boundary

Focused synthetic tests are separate from actual selected-data rehearsal. A
synthetic fixture proves transaction/preservation mechanics, not provenance of
the owner's 114 approved outputs. Integration owns the actual archive mapping,
receipt normalization and selected-data rehearsal. Node23 ABI131 test results are
diagnostic only; a matching supported runtime result must be recorded separately.
