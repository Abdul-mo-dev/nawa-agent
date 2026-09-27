# Directory chat review fixes

Implemented against the review of 2026-09-27. This document supplements the original [review](directory-agentic-chat-review.md), which records the behavior before these fixes.

| Finding | Implementation | Regression evidence |
| --- | --- | --- |
| F1: validation skipped after correction/finalization | Mandatory `validateResponse` is separate from the bounded semantic correction hook; integrity failure is terminal. | `agent-core/tests/final-validation.test.ts`: correction, finalizing, empty/cutoff, late reset. |
| F2: unversioned plain-text evidence | Main-process run-scoped paginated reads enforce selection, cancellation and pre/post hashes; final receipts include the file. | `directory-review-fixes.test.ts`: reads beyond 12,000 characters, source changes, unselected paths and stale runs. |
| F3: failed intermediate history restored | Schema 3 stores request phase/outcome; restore only completed user/final pairs with validated source receipts. | History persistence and renderer browser recovery scenario. |
| F4: cutoffs appear completed | Incomplete outcome/activity, retained partial text and explicit continuation. | Core cutoff test and browser continuation scenario. |
| F5: unconditional and repeated preparation | Metadata routing skips optional RAG; selected catalog uses one bounded metadata HTTP request and unchecked local mappings. Restoration batches checks and stops retries on outage. | Four-tool listing and no-RAG browser assertion; adapter offline/changed-mapping tests. |
| F6: whole-tree hashes gate chat | Directory comparisons are manual; actual evidence sources gate answer/history validity. Bounded user intent is retained separately. | No automatic comparison browser assertion; unrelated-file-change receipt test. |
| F7: repeated integrity work | Target-level pre/post checks belong to the adapter/service. Main retains receipts and validates all used sources at the final boundary, batching remote revisions. | Real manager/adapter regression: discovery + two executions + validation = four HTTP requests. |
| F8: broad/overlapping tools and repeated metadata | Intent-specific capability sets; explicit discovery fallback; bounded workbook catalog preparation/reuse; native inspection context is bounds-only. | Routing tests; browser count takes two scripted model turns and a follow-up reuses validated metadata. |
| F9: full selection prevents subset execution | Apply the 100-source server limit after narrowing within the 256-file selected allowlist. | 101-selected-path test succeeds for one target and rejects unbatched full scope. |
| F10: unsupported action claims | Structured action outcomes, rejection memory, immutable commit receipts and explicit claim/target/operation checks. | Decline/retry/claim regressions; browser approval, denial and save tests. |
| F11: inert citations | Bounded persisted citation registry; only registered links open the source viewer; file-version check, excerpt/location and open-file action. Local/MyAgent retrieval citations distinguish identical copies. | Browser link allowlist, navigation, stale source and history reload scenarios. |
| F12: incomplete diagnostics | Typed facts extracted before truncation; HTTP/cache/coverage/source/SQL fields, separate validation/checkpoint timings and checkpoint payload counts. | Large-result fact preservation, SQL diagnostics, persisted activity and copy/redaction tests. |

Additional fixes: per-message history deltas and SQLite upserts, at most four independent metadata reads in parallel, smaller root tool/error budgets, repeated-read limits, retained advertised schemas after file commits, scoped content search, and context-budget-aware neighbor expansion. Approvals and native editing remain serial and retain their existing authority checks.

## Validation

- 112 targeted shell tests passed across directory chat, history, MyAgent, RAG and analytics.
- 97 agent-core tests passed, including bounded read concurrency and mutation barriers.
- 30 standalone RAG tests passed.
- Shell and agent-core TypeScript checks passed. Shell production build passed.
- Both sidebar browser harnesses passed. Activity screenshots are under `.task/directory-chat-review/`; general sidebar screenshots are under `.task/sidebar-review/`.
- Read-only integration with the configured local MyAgent service selected all 23 sample files and targeted `employee-data.xlsx`. Catalog + SQL returned 500 rows, 500 non-empty IDs, 500 distinct IDs and zero blank IDs. Final validation checked the one used source. Total HTTP requests: four (metadata catalog, dataset catalog, SQL, final scoped revision validation); no per-file document probes. Artifact: `.task/directory-chat-fixes/live-check.json`. No source files were edited and no model-provider requests were made by this check.

The broader shell run also exposed 50 failures in untouched tests/modules: 12 headless-export tests with POSIX path assumptions on Windows, 37 tab-manager tests whose Electron mock lacks `ipcMain`, and one folder-tree symlink test denied by the Windows account. A separate workspace harness passed 29 tests, skipped its symlink test, and failed the existing overlapping-root registration case. These are outside this change. The directory inspection assertion affected by newly attached citations was updated and passes in the targeted run.

## Limits and rollout

Restart Nawa to load the rebuilt main process, preload and renderer. No MyAgent server change or restart is required for this patch; the live check used its existing scoped tool API. History migration preserves messages but older builds cannot reopen schema 3.

Tool routing is a heuristic with explicit capability discovery as a fallback. Browser model responses are scripted, so the observed two-turn count route demonstrates the supported flow rather than promising every model will use exactly two turns. The live check validates the real API and calculations, not a paid end-to-end model response. Claim detection covers conservative explicit English patterns; it is not a general proof of answer meaning.

A failed batched history revision check conservatively omits the affected batch instead of retrying each source. Old unversioned history remains readable but is not restored as verified factual context. Citations check the saved file version and show a returned locator; opening an editor does not automatically select the cited cell/page. Diagnostics and citation excerpts remain bounded, local and unencrypted.

## Listing shorthand follow-up — 2026-09-28

A user trace exposed a routing miss for `list file in this dir`: the initial matcher accepted plural `files` and the full location words, so this request loaded six MyAgent tools and advertised 17 tools overall. The listing matcher now covers singular/plural names, `dir`, whitespace, polite wording, and common directory-listing questions. It still matches the entire request, so content filters and additional analytical/editing instructions cannot be mistaken for a simple listing.

The exact reported phrase is now the browser regression scenario: four advertised metadata tools and zero MyAgent catalog requests. The dedicated routing suite covers 18 listing variants and eight content/combined-request exclusions. The routing and directory-review suites pass together (39 tests), alongside shell type checking, the activity browser harness and the production build.
