---
status: done
baseline_commit: 5453051bb58d71cbec3d48097accbc8efb5c444c
context: []
---
# Radiator future saves: local runtime implementation

## Goal and authorization
A URL explicitly saved or promoted to `radiator-9k51` receives a current-source, pinned-canon product analysis from exactly `claude-sonnet-5-5`, without changing other collections or requiring AI for capture. The owner released local implementation and one real new-save proof after fake tests. Existing 119-item inputs, 114 drafts and review exports are immutable; this work does not apply them. No production access, dependency changes, commits, publication or deployment is authorized. Preserve the root ignore-file edits and existing preparation files.

## Runtime contracts
The existing serial capture/job lane and separate SQLite write lane remain authoritative. A guarded local activation stores the original descriptor and pinned baseline in the existing settings table, then installs the approved 22-field descriptor for the exact board ID/name. It requires a before-image hash; no startup auto-migration or existing-owner-DB apply is permitted. Disposable fixture setup is explicit. The shared versioned JSON schema and execution rules remain the source of truth.

`src/radiator/contract.js` is the browser-safe shared vocabulary. Item fields may contain runner-owned `radiator_meta.receipt` and `radiator_meta.state`; neither is an editable descriptor field. Receipt version 1 contains `source`, `modelId`, `sessionId`, `schemaVersion`, `promptVersion`, `baselineSha256`, `reviewedOn`, `sources` (IDs, exact checked URLs, titles, retrieved date and bounded excerpts/hashes) and usage. State version 1 contains `status` (`researching`, `analyzing`, `error`, `disabled`) and a sanitized `message`. A successful replacement deletes obsolete generated fields only after validation, clears state, and merges fresh curation plus new fields/receipt in one guarded write. Prior generated values and receipt are retained in a runner-owned recovery value on successful replacement, never displayed as parallel active analysis. Failed attempts retain prior fields and receipts.

`GET /api/collections` adds `intelligence: {version:1, modelId, legacyDescriptor}` only for an activated Radiator collection. Hydrated nested metadata is `item.radiator_meta.receipt/state`. An active analysis requires a matching trusted receipt and all 12 analysis values; otherwise the UI uses legacyDescriptor when old analysis exists. Other collections keep incumbent presentation. Provenance and evidence links are read-only and escaped, with HTTP(S)-only checked URLs. Notes, tags, tone, favorite and assets remain user-owned.

The transport contract is `runRadiatorSonnet(prompt, options?) -> {text, modelId, sessionId, usage, elapsedMs}` in `src/llm/radiator-sonnet.ts`. Options expose `signal`, optional trusted local settings-file configuration and injected spawn for tests, never an overridable model. Default model is an exact constant, tools are disabled, router namespaces disabled launch-locally, argv/stdin/stdout/stderr and execution are bounded, usage identities must match exactly, and cancellation terminates the subprocess. No provider fallback, SDK or direct inference HTTP. No Mac path/proxy/auth assumption is embedded in portable application defaults.

Research fetches the selected public URL plus at most one useful same-origin primary page; a bounded same-origin llms.txt fallback is allowed when the first response is unusable. It reuses Board network guards, pins validated DNS, validates redirects, caps text/MIME/bytes/time and ignores webpage instructions. Source records and pinned canon are data fenced from instructions. Source IDs and supplied URLs, complete declared keys, unknown reasons and product edition boundaries are validated before persistence. The model never supplies stamps, title, source, home or curation.

Runtime dependencies are optional injected context options, propagated through add, assignment and refetch to the shared worker. The worker snapshots home/source/profile and rechecks them with existence and AbortSignal inside the serialized write. Late completion, deletion, timeout or changed home/source/profile cannot commit. Active Radiator refreshes do not recapture over existing curated assets. Inbox/default v1/share remain capture-only; explicit target and promotion select the new lens.

## Tasks & Acceptance
- [x] **Profile/configuration** — add `src/radiator/profile.ts`, pinned canon and disposable activation helper/tests. Given the exact target and matching before image, when activated locally, then 22 fields and original flags are installed atomically, existing records/assets remain unchanged, repeat activation is a no-op, and stale/wrong targets reject.
- [x] **Research/validation** — add `src/radiator/research.ts` and shared strict validation/tests. Given fresh primary documents and pinned canon, when preparing a prompt, then only bounded inspected sources enter it; SSRF/private redirects, unsupported bytes, thin/challenge pages and injection instructions cannot become trusted evidence. Missing/extra/conflicting fields, unknown source IDs/URLs and unsupported pricing claims reject or explicitly remain unknown.
- [x] **Exact subscription transport** — isolated worker owns only `src/llm/radiator-sonnet.ts` and its test. Given fake CLI streams, when called, then exact argv/model metadata, malformed/error/overflow/timeout/abort/late completion are exercised without real inference or credential logging.
- [x] **Runtime integration** — update `src/enrichment/worker.ts`, pipeline, assign/refetch, skills/context, server and mutation/hydration seams. Given new URL, explicit/default v1, share or promotion, when queued, then only activated Radiator performs new research/Sonnet; disabled/failure preserves capture and previous analysis. Concurrent notes/tags/assets survive and moved/deleted/cancelled items cannot accept stale fields.
- [x] **Visible state** — isolated worker owns `public/index.html`, `src/collections-ui.js` and focused UI tests. Given valid new, old fallback or missing/error/disabled states, when cards/detail render, then rationale/relevance lead, only one analysis is shown, safe sources/provenance are read-only, retry is useful, and editor flags survive. Preserve incumbent styling and accessibility; use Impeccable for judgment, no redesign.
- [x] **Evidence** — run focused fake/disposable tests first; Node 22 typecheck and at most one full suite when possible. Report ABI131/127 separately; an existing Node23 runtime may supply explicitly diagnostic native proof. After fakes pass perform one bounded real local new-save with a new DATA_DIR, record exact effective model, visible state and local review URL, and finish a durable handoff with limitations. No bulk inference or production action.

## Ownership and checks
Main t3p owns integration, profile/research/validation, server/mutation seams, fixture/proof and this spec. The transport and UI workers use separate GitButler worktrees and return uncommitted named paths only. No nested fan-out. Tests use existing dependencies only. Completed historical archive/output hashes remain unchanged. The known Node22 native ABI mismatch is an environment gate, not permission to reinstall or mislabel a diagnostic suite. Finish all runnable code/checks and state any residual gate precisely.

## Verification outcome

- Node22.23.2: typecheck;131 pure transport/UI/current-source tests;2 strict runtime validation tests;1 shared offline-validator regression pass.
- Existing Node23.11.0 ABI131: one diagnostic full suite667/667, before final review corrections; final focused runtime/research/capture35/35 afterward. Full suite was not repeated under the one-run limit.
- Node22 native gate remains blocked: installed better-sqlite3 ABI131, runtime ABI127. No install/rebuild or dependency change. Standalone Semgrep is unavailable; no standalone SAST result is claimed.
- Live Factory save succeeded in new disposable state through the actual UI/HTTP/capture/research/canon/CLI/validation/visible flow. Exact effective model claude-sonnet-5-5;14251 input/2420 output; session7380d00a-de5b-45c8-88b4-d5e49e702b63;19.37s CLI. Two bounded CLI attempts: first rejected without a receipt, second accepted. First-attempt usage was not retained; no fabricated total.
- Browser evidence1440/768/375: no horizontal document overflow, read-only runner fields, real curation PATCH200 with unchanged analysis, safe source links, light/dark, Escape close and zero console errors. Generic-card focus returns BODY after pointer-opened modal (incumbent behavior); no complete WCAG audit or redesign is claimed.
- Three independent native reviews found9 issues; all fixed and bounded-confirmed. Six exact cases were replayed independently; asset and blind-fix confirmations were static. No commit/push/PR, production action, backfill application or public publication.

## Suggested Review Order

**Routing and scope**

- Follow the common enrichment dispatcher used by saves, promotion and retry.
  [`worker.ts:97`](../src/enrichment/worker.ts#L97)

- Activate only the exact board behind an explicit before-image guard.
  [`profile.ts:66`](../src/radiator/profile.ts#L66)

**Evidence and replacement**

- Read only bounded current public material; redirects retain their trust boundary.
  [`research.ts:27`](../src/radiator/research.ts#L27)

- Validate declared fields, inspected citations and product-edition pricing scope.
  [`runtime.ts:56`](../src/radiator/runtime.ts#L56)

- Persist durable recovery before atomic fresh-field replacement.
  [`runtime.ts:142`](../src/radiator/runtime.ts#L142)

**Subscription transport**

- Verify exact effective model and bounded subprocess disposal without fallback.
  [`radiator-sonnet.ts:80`](../src/llm/radiator-sonnet.ts#L80)

**Presentation**

- Select receipt-bound product analysis or retained legacy fallback.
  [`collections-ui.js:11`](../src/collections-ui.js#L11)

- Render read-only checked sources and runner provenance.
  [`collections-ui.js:55`](../src/collections-ui.js#L55)

**Checks and local review**

- Start an isolated review with a new data root and a strict inference limit.
  [`radiator-local-demo.ts:8`](../scripts/radiator-local-demo.ts#L8)

- Exercise real HTTP routing with fake research and model collaborators.
  [`runtime.test.ts:162`](../src/radiator/runtime.test.ts#L162)

- Cover subprocess metadata, cancellation, disposal and finite budgets.
  [`radiator-sonnet.test.ts:49`](../src/llm/radiator-sonnet.test.ts#L49)

## Review-preview correction

The initial three-item proof fixture was not a useful library review. The local review now shows all119 authoritative Radiator snapshot listings/screenshots, with114 already-validated analyses projected in memory and5 retaining prior analysis. No replacement fields are written to SQLite; all mutation methods reject409, no model calls occur, and nothing is applied to production. The page is explicitly read-only, hides unavailable Add/Retry controls, opens Product analysis by default and avoids stale-shell ETag reuse. `scripts/radiator-preview-input.py` prepares a new private, path/type/size/hash-validated input directory; `scripts/radiator-local-preview.ts` serves it; `src/radiator/preview.ts` validates source guards and renders the non-applying projection. Three Node22 regressions/typecheck and desktop/mobile/search/relation-filter checks pass. Exact current evidence: full-preview-evidence.json in the local report directory. No extra full-suite run or inference was used.
