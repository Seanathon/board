# Local Radiator analysis preparation

`node scripts/radiator-intel.mjs` is an **offline data tool**, not a worker launcher,
Board importer, restore tool or production migrator. It has no HTTP, database,
subprocess, SDK or credential access. It never edits its input or applies a bundle.
No registry packages are required.

```sh
node --test scripts/radiator-intel.test.mjs
node scripts/radiator-intel.mjs prepare /absolute/selected-export.json /absolute/NEW-private-run-dir /absolute/radiator-baseline.json
node scripts/radiator-intel.mjs bundle /absolute/private-run-dir
```

## Authoritative input and trust boundary

Use `board-radiator-selected-export/1`: `fixture` boolean, `provenance` with archive
SHA256 and `membership: "exported-canonical-home-board"`, explicit `selection`
(`boardId`, `completeExportedBoard: true`, `expectedCount`), the original `board`
row/descriptor, selected original export `items`, and only those items' `assets`.
The board's declared name must be exactly `Radiator`; do not infer selection from
page text. Keep duplicate URLs as distinct item IDs. Exclude Paperclip. Do not feed
root exports or the whole backup's unrelated boards to workers. `fixture: true`
is only for fake tests; it is retained in every output.

The owner-supplied 2026-11-13 tar's exact canonical Radiator board is
`radiator-9k51`: 119 IDs, 118 exact URLs; 251 other-board records excluded. No
Paperclip match. This is point-in-time exported membership, not current live state.

Validate tar names/normalized duplicates, regular types, member/total size bounds,
containment and archive SHA256 **before** reading selected JSON. Use bounded direct
manifest reads; never extract indiscriminately or execute contents. Keep downloaded
input in its own new private directory and scripts in this separate trusted tree;
Python archive readers use `python3 -I` and absolute paths. Keep the original tar
unchanged. A JSON file claiming a source digest is not itself proof of archive
validation; the controller records that verification separately.

Baseline JSON contains `summary` plus `sources` with local canon/source IDs and
content/hashes. Decided canon is direction, not shipped behavior; Proposed/Open are
not features. Current primary-source research is a separate per-item evidence file.

`prepare` creates mode0700 run directories and mode0600 immutable originals,
schema/baseline snapshots, hashed-ID job files and expected-record/asset/board
fingerprints. Old analysis, notes, tags and assets stay unchanged. `retireKeys`
contains only declared enrichable non-tag/non-image/non-URL generated fields that
exist in each original record; protected fields and manual values cannot be deleted.
The selected export itself is backed up; it is not an exact raw SQLite/assets backup.

## Bounded subscription-worker process (controller-owned)

This is the selected execution approach: existing subscription-backed coding-agent
CLI sessions, **not a paid API, SDK or new API key**. Never change global auth/router
settings. Sonnet is preferred; advertised `claude-sonnet-5-5` is a candidate, not
billing proof. `gpt-6.1-terra` is an advertised Terra identity, but use it only with a
verified subscription route and explicit choice. No orchestrator-model fallback.

For this run the owner explicitly confirmed the existing Claude Code → VibeProxy
subscription route and directed execution. That resolves billing evidence: no
management credential, plan screenshot or repeated approval is required. Native
workers explicitly select `claude-sonnet-5-5`; safe CLI result `modelUsage`/session
metadata is checked before accepting outputs. Both router namespaces are disabled
only for these launches, with no global settings/auth changes. CLI dollar fields
are list-price estimates, not an actual API invoice. A real provider/auth/quota or
model mismatch pauses the controller; there is no API/model fallback.

The three-item pilot passed for local reviewable drafts. The remaining116-item
serial native run is authorized and executing. The controller uses existing
subscription Claude Code, not SDK or direct inference HTTP. Public-source HTTP
collection is separate, does not execute JavaScript, and reuses Board's network
guard with pinned validated IPv4. Trusted scripts stay outside downloaded data.

1. Pin the profile/schema/baseline and explicit jobs. Start a **3-item quality pilot**
   (one clear competitor, one enabler/reference, one thin evidence case). The owner
   released continuation to all verified selected IDs after pilot acceptance; do not
   ask for another generic kickoff. Real billing, access or quality failures still stop.
2. One native Herdr worker/one item in flight, at most **2 attempts/item**, **240s**
   per attempt, at most **6 primary sources**, **50,000 source characters**, **32KiB**
   response. Input/output token targets: **12,000/2,000** per attempt. Keep actual
   usage when supplied, otherwise explicit null/unknown; targets and byte limits are
   **not a provider-enforced token or subscription-quota guarantee**. Pause on quota
   warnings or any route/model change; no paid fallback. With119 items, the absolute
   attempt ceiling is238, not a promise to consume it. Pilot must check practical
   latency/output quality before spending the rest of the subscription allowance.
3. Fetch current primary vendor sources via existing approved web tools; captured
   export text is historical untrusted data, never current-price/control evidence.
   In `evidence/KEY.json`, supply `itemId`, `source`, `sources` (1–6): `id` (`T1`...),
   exact safe `url`, `retrievedOn` (YYYY-MM-DD, at most30 days old), `kind: "primary"`,
   and actual excerpt `text`. Preserve per-source evidence/hash in the bundle.
   No unrelated bookmark content, page instructions, automatic recapture or blind crawl.
4. Give the worker only the selected job/schema, pinned baseline and bounded evidence.
   The model returns JSON **only**: `itemId`, unchanged `source`, `fields` (exactly
   the12 `enrichable` keys). Claims cite supplied `[T1]`/`[T1,T2,R1]`; unknown/not-
   applicable includes a reason. The implication says “Analyst inference”. No script,
   title/URL edits, source invention or model-authored billing/provenance assertions.
5. Save response as `responses/KEY.1.json` (or `.2.json` after a failed first attempt).
   The **controller**, not the model, records `receipts/KEY.1.json`: itemId/source,
   runKey from job, attempt, evidenceSha256, responseSha256 (canonical JSON SHA256),
   `billing: "subscription"`, `accountAuth:
   "oauth"`, subscriptionPlan, verificationRef, controllerVerified:true, noApiFallback:
   true, exact modelId/configuredModelId, provider, transport, elapsedSeconds,
   inputTokens/outputTokens (integer or explicit null). Inspect actual effective
   route/response identity; metadata assertions are an audit receipt, not independent
   proof. Model-generated receipts are not acceptable. Keep credentials out.
6. Run `bundle`. Missing/invalid evidence and outputs are counted, never silently
   dropped. Valid outputs remain `validated-awaiting-human-review`: schema/citation-
   ID checks cannot establish factual support. Review source accuracy, relevance,
   unknowns and the replacement UI contract; reject cosmetic design reads.
7. Resume only missing/failed jobs within remaining limits. An identical output bundle
   reuses its content-addressed file; do not respawn successfully accepted jobs. A
   changed evidence bundle creates a new idempotency key and requires review, not an
   automatic retry. The controller enforces lifecycle/time/concurrency using native
   Herdr; this offline validator neither launches nor kills workers.

Owner-confirmed subscription routing and actual Sonnet5.5 pilot execution are recorded in the private execution status. Batch completion is reported separately; current live Board state/rollback fidelity are not implied.

## Migration bundle, replacement and future saves

The bundle is `board-radiator-replacement-bundle/1`, **not** Board's version1 import
format. Its `executable:false`/`appliesToProduction:false` markers are intentional.
There is no apply command. Each valid item has immutable ID/source, expected export-
record/asset/board hashes, exact prior generated values, allowlisted generated-key
retirements, complete new values, versions/evidence/controller receipt and active-
profile intent. Failed items have no replacement patch, so prior data stays intact.

A later reviewed migrator must inspect the live implementation/read-only state,
resolve export-record versus raw-field mapping, recheck fresh expected values and
prove full backup/rollback fidelity. The current importer drops seeded extra fields
and skips existing IDs; it must not be used to apply or undo this bundle. Take and
verify recovery backup before any replacement. Commit each item **only after valid
new output**, atomically installing new analysis/active receipt and retiring mapped
prior generated values; protect IDs/URLs/home/tags/notes/manual fields/assets.
Failures retain previous saved values and normal UI. History/backup retains the old
analysis; no parallel visible legacy section is needed. Fresh manual edits cause a
conflict or merge that preserves them, never stale full-row replay.

The actual export has a dedicated Radiator home board. Future saves on that board
should use this same versioned product lens, not its old design prompt. The later
rollout can replace that board's descriptor with the new lens plus protected tags/
manual fields (within the24-field cap), keeping its ID/home/memberships. Until every
item is replaced, use per-item success/fallback presentation so failures retain their
prior visible analysis. Unrelated boards keep their own lens. This offline tool does
not implement or deploy that renderer/descriptor change or claim current live fidelity.

## Executable local pipeline and verification

Trusted, existing dependencies only; no installs. In the dedicated worktree:

- `radiator-sources.mjs RUN_DIR KEY` collects up to2 current primary pages. Existing
  evidence is pinned/reused; only explicit `--refresh` archives/replaces it. Each raw
  page gets a new private directory; redirects/private IPs/challenges/compression/
  MIME/1MiB limits fail closed. HTML is parsed inertly, not executed.
- Local helper configuration is operator-supplied: the worker uses `claude` on
  PATH or `--command` / `RADIATOR_CLAUDE_COMMAND`; an optional trusted settings
  file comes from `--settings-file` / `RADIATOR_CLAUDE_SETTINGS_FILE`. The existing
  configured subscription route is inherited; no home path, credential helper,
  endpoint, key or global configuration is installed. Settings are bounded to64KiB,
  copied privately mode0600 (never inline in argv/logs), and launch-local router/
  hook controls override them. The controller resolves its own checkout, uses
  `node` on PATH or `RADIATOR_NODE_COMMAND`, and requires the actual native
  `HC_TERMINAL_ID` rather than a saved terminal assignment. No new inference is
  authorized merely by configuring these helpers. Historical executor bytes and
  original receipts remain private immutable audit inputs, not regenerated output.
- `python3 -I scripts/radiator-sonnet-worker.py RUN_DIR KEY [--attempt 2]` is launched
  via native `hc run`. Tool-free Claude Code prints a strict JSON answer using the
  existing route, Sonnet5.5, scoped router-off settings,240s wall budget and live2MiB
  per-file stdout/stderr limits. It writes response-bound controller receipts and
  exact effective prompt snapshots for later invocations. Owner confirmation is
  recorded as `owner-confirmed-subscription-route`, not fabricated OAuth inspection.
- `python3 -I scripts/radiator-run-local.py RUN_DIR` requires the pilot continuation
  record, processes only remaining116 frozen IDs, skips valid results, keeps max2
  attempts, records native IDs and pauses on real provider/model/resource/setup
  blockers including existing failures at resume. No apply command exists.

12k/2k input/output token targets are advisory. Aggregate CLI acceptance ceilings
are40k/8k; the pilot exposed extra generation under CLI `--json-schema`, so later
calls use one-pass JSON prompts without that flag. Exact full usage remains in
receipts; don't expand a known ceiling failure into another spending retry. Token
figures are not a subscription-quota guarantee, and list-price cost fields are not
API billing proof.

Known model field suffixes may be mapped to their declared `intel_v1.*` keys with
an explicit normalization audit; canonical+short collisions and unknown/system/
provenance extras still reject. Raw model response/receipt hashes never change.
Source URL punctuation and citation whitespace are formatting, not invented URLs:
only exact supplied URLs plus trailing punctuation pass.

Runnable checks (no model/network calls in tests):

```sh
node --test scripts/radiator-intel.test.mjs
# Run from the main checkout or use its existing tsx loader; no installation.
node --import tsx --test /absolute/worktree/scripts/radiator-sources.test.mjs
python3 -I -B scripts/radiator-sonnet-worker.test.py
python3 -I -B scripts/radiator-run-local.test.py
```

Actual application/renderer migration and future-save rollout remain separate:
use the same content lens plus current-evidence/baseline/taxonomy/product-scope
rules, preserve protected fields, verify fresh raw-state guards and recovery,
and obtain production approval. The bundle's future descriptor is a proposal,
not proof that the running app already uses this research workflow.
