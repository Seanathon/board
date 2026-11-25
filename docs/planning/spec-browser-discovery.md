---
title: 'Optional per-board browser-assisted discovery'
type: 'feature'
created: '2026-11-15'
status: 'done'
baseline_commit: 'edd4faffbe21bbca196245dab5b4bbdcdba2f6f2'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** JavaScript-rendered sites can expose useful documentation behind Tutorial controls while static HTML is empty. Static-only research then fails successful captures.

**Approach:** Add general browser-assisted discovery, per-board and default-off. Reuse captured/lightweight sources first; when insufficient, a bounded agent selects first-party links or documentation controls and supplies evidence to existing enrichment. Enable only the requested private board.

## Boundaries & Constraints

**Always:** Preserve board-defined optional fields, capture/assets, curation, leases, cancellation, atomic adoption and configured provider identity. Reuse installed infrastructure; private inference retains its subscription route. Treat website content as untrusted. Store the opt-in in existing SQLite settings, separate from sealed descriptors. Provide an accessible Edit board checkbox and board-scoped API.

**Ask First:** New dependencies, extra paid API credentials, PR merges/pushes, cross-publisher exploration, authenticated browsing, or expanding beyond bounded read-only research.

**Never:** Publish private board data; enable other boards; mass-regenerate analyses; modify journals; disable global hooks; execute model-generated code; submit forms; bypass challenges; use personal browser sessions.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Opt-in absent/off | Any board | Existing save/enrichment behavior; no discovery/browser or extra model calls | Existing errors |
| Ordinary readable page | Opted-in board, adequate captured/static text | Reuse evidence without an exploration loop | Preserve source provenance |
| JS shell with Tutorial | Opted-in board; relevant information behind a control | Agent chooses Tutorial, reads documentation, returns evidence for declared fields | Bounded partial evidence accepted |
| Unsafe destination/action | Private address, credentials, external publisher, form/download/challenge | Deny action before network/action execution | Continue with available evidence or explain failure |
| Cancellation/stale job | Abort, deletion, move, curation or opt-out | Stop browser/model work; no stale writes | Existing lease guards remain authoritative |
| Exhausted budget | No more useful pages or time/actions exceeded | Use available evidence and express uncertainty | Never fabricate source authority |

</frozen-after-approval>

## Code Map

- `src/db/settings.ts`, `src/db/board-actions.ts`, `src/server.ts` — option storage, routes, metadata and deletion.
- `src/enrichment/worker.ts`, `src/skills/types.ts` — provider/context integration; `src/llm/cli-provider.ts`, `src/llm/http-provider.ts` cancellation.
- `src/browser.ts`, `src/capture/net-guard.ts` — browser and network helpers.
- `public/index.html` — Edit board UI. Private integration stays outside this repository.

## Tasks & Acceptance

**Execution:**
- [x] `src/db/board-options.ts`, `src/server.ts`, `src/db/board-actions.ts` — persist a strict boolean through serialized writes; check board identity, expose current state and clean up on deletion.
- [x] `public/index.html` — add an accessible checkbox with latency/privacy help; preserve unrelated settings.
- [x] `src/enrichment/discovery.ts` — reuse evidence, obtain provider-selected navigation through ordinary structured completion, enforce finite action/page/text/time budgets and return attributable sources.
- [x] `src/enrichment/discovery-browser.ts` — expose snapshots, candidate IDs, safe navigation/clicks and disposal; guard every request, redirect, subresource and popup against private networks, unsafe methods, downloads, forms and publisher escape.
- [x] `src/enrichment/worker.ts`, `src/skills/types.ts` — carry a distinct discovery-purpose context and evidence without changing field semantics; bypass when off; recheck freshness before work/adoption and propagate abort into transports.
- [x] `src/db/board-options.test.ts`, `src/enrichment/discovery.test.ts`, `src/server.test.ts` — test option isolation/persistence, off/fast paths, Tutorial clicks, sitemap candidates, cancellation, budgets and unsafe actions.
- [x] Private source-only decision/evidence adaptation and focused fake-provider tests outside the repository; no production configuration or data changed.
- [x] Private runtime files outside the repository — adapt research, preserve historical authority/receipts, enable only the requested board after backup/rehearsal; retry only the failed item, not screenshots or the whole board.

**Acceptance Criteria:**
- Given two boards, when one is opted in, then only that board may launch discovery, including after restart and backup/restore.
- Given a scripted fixture with a thin shell and Tutorial documentation, when discovery runs, then the model-selected click exposes usable cited evidence and optional fields adopt through normal ownership/lease checks.
- Given stale or cancelled work, when an exploration completes late, then no field, asset or status can be adopted by that stale job.
- Given the private rollout, when the option is enabled, then existing current/legacy presentation, journal authority, screenshots and unrelated items remain intact.

## Spec Change Log

- Tutorial negotiates inline Markdown. Accept bounded Markdown reads and render them as plain text, never downloads. Follow validated document anchors in the controlled tab; retain real clicks for same-document/modal controls.

- Actual Tutorial is on a documentation subdomain beneath the saved product hostname. Permit that first-party hierarchy, not parent/sibling/lookalike publishers; reuse the same URL policy in private evidence checks. Registration/sign-up controls remain denied.

- Real copied-DB rehearsal found a 2.09 MB SPA script rejected by the 1 MB document limit. Retain 1 MB documents; allow 4 MB script/style/JSON assets, 16 MB aggregate, 96 reads within the unchanged overall deadline.

- Review patches: use semantic evidence sufficiency rather than character length; prioritize active documentation over long background text; retain SPA fragments and response charsets. Keep bounded navigation and optional fields.
- Verified local Codex inventory behavior: an empty MCP table retains inherited entries. Restrict discovery/evidence calls with explicit per-server disables; preserve default-off CLI arguments.
- Explicit opt-out/manual edits settle interrupted jobs with a visible retryable cancellation reason; invalidated stale jobs cannot leave items processing indefinitely.
- Owner merged PR #17; active implementation moved to a new isolated branch based on merged main. Original worktree preserved.

## Design Notes

Use a controlled candidate-selection loop, not unrestricted tools. Existing capture guards cover only initial URLs: discovery must fail closed on DNS errors and pin connections, not merely pre-check DNS. Deny uncontrolled browser egress; serve checked reads through the controller. Keep this protection scoped to discovery. Separate settings preserve sealed descriptors. The owner merged PR #17 during implementation. The feature worktree base remains unchanged; the conductor owns moving it after handoff.

## Verification

**Commands:**
- Pinned local Node 22 with existing matching dependencies: focused new/affected tests, then `npm run typecheck`; no install required.
- Generic suite under the same runtime; report failures.
- Real local browser fixture: verify Tutorial and sitemap discovery plus checkbox persistence without a live model.
- Private copied-DB rehearsal and bounded live-item check; record real inference use privately.

Local verification: 228 focused public tests and 67 focused private tests passed with Node 22.23.2; `npm run typecheck` passed. Real local fixtures cover dynamic Tutorial anchor/modal clicking, sitemap selection, denied uncontrolled browser egress, and checkbox persistence. The full generic suite, production backup/rehearsal, enablement and live-item retry remain conductor-owned and have not run here.

## Suggested Review Order

**Entry and state**

- Build evidence before enrichment while retaining ordinary board semantics.
  [`worker.ts:134`](../../src/enrichment/worker.ts#L134)

- Store opt-in separately from sealed content descriptors.
  [`board-options.ts:8`](../../src/db/board-options.ts#L8)

**Browser boundary**

- Keep untrusted browser egress behind checked application reads.
  [`discovery-browser.ts:24`](../../src/enrichment/discovery-browser.ts#L24)

- Pin public connections and preserve documentation URLs and encodings.
  [`discovery-net.ts:21`](../../src/enrichment/discovery-net.ts#L21)

**Research routing**

- Let the agent assess sufficiency and select observed navigation candidates.
  [`discovery.ts:17`](../../src/enrichment/discovery.ts#L17)

**Cancellation and providers**

- Settle explicit cancellation without allowing stale job completion.
  [`queue.ts:305`](../../src/db/queue.ts#L305)

- Disable inherited MCP entries only for discovery-related calls.
  [`cli-provider.ts:151`](../../src/llm/cli-provider.ts#L151)

**Peripherals**

- Expose an accessible per-board checkbox using the existing editor.
  [`index.html:3220`](../../public/index.html#L3220)

- Exercise Tutorial modals, SPA routes, Markdown and blocked egress.
  [`discovery.test.ts:133`](../../src/enrichment/discovery.test.ts#L133)

- Verify persistence, isolation, backup and option ABA invalidation.
  [`board-options.test.ts:15`](../../src/db/board-options.test.ts#L15)

## Completion

719 generic tests, typecheck, 75 private tests and 24 on-host focused tests passed. Browser-assisted documentation traversal was verified on a disposable data copy. Private activation is complete with only the requested board enabled. No push or new pull request. Implementation remains uncommitted pending the owner's version-control instruction.
