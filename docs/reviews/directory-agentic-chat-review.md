# Directory agentic chat and tool-use review

Reviewed 2026-09-27 against the working tree based on `e577fb2`, including the uncommitted directory chat, MyAgent, and counting improvements. This is a review; no application behavior was changed during it.

Follow-up: the recommended changes are implemented; see [fixes and validation](directory-chat-fixes.md). The findings below describe the pre-fix behavior.

## Assessment

The architecture has useful boundaries: Nawa owns the conversation and approvals, MyAgent provides scoped knowledge/SQL tools, and native editors stage document changes. The main remaining problems are inconsistent evidence validation, unconditional preparation, overlapping tool choices, and diagnostics that hide much of the actual work.

The highest-priority fixes are **final validation on every exit path** and **bringing plain-text reads into the same source-tracking mechanism as other reads**. Efficiency improvements should preserve those checks while consolidating their implementation.

The supplied employee-count trace spent about 12 seconds in four model requests; the listed preparation and tool calls together took under one second. On those small files, removing an unnecessary model round trip matters more than shaving a few milliseconds off an API call. Large selections and server outages expose different bottlenecks.

## Findings

### F1 — P1: Final source validation can be skipped

**Evidence:** [loop.ts:641](../../packages/agent-core/src/loop.ts#L641), [loop.ts:647](../../packages/agent-core/src/loop.ts#L647), [WorkspaceChat.tsx:436](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L436).

Directory chat installs source validation as `AgentLoop.options.verifyResponse`. That callback runs only before the first nonempty, non-finalizing final answer. After one corrective response, `verifyRetryUsed` skips both the claim check and the source check. The turn-limit finalizing branch skips verification altogether. An empty final answer skips it too.

**Reproduction:** A scripted two-answer run invoked verification once and accepted the second unsupported claim. A run with `maxTurns: 1` read evidence and accepted its finalizing answer with zero verifier calls. A real source change during the corrective/finalizing model request would consequently miss the intended last check. Turn-limit answers are marked as errors by directory chat, but their text is still displayed.

**Recommendation:** Separate a bounded semantic-correction hook from mandatory source/permission validation. Always run the latter before accepting a final answer, including after correction, finalization, and an empty-response fallback. Keep hard failures terminal. Do not make an unlimited correction loop.

### F2 — P1: `read_file` evidence bypasses final source tracking

**Evidence:** [directory-skill.ts:74](../../apps/shell/src/renderer/src/ai/directory-skill.ts#L74), [workspace-ipc.ts:130](../../apps/shell/src/main/workspace-ipc.ts#L130), [controller.ts:167](../../apps/shell/src/renderer/src/directory-actions/controller.ts#L167), [manager.ts:352](../../apps/shell/src/main/directory-actions/manager.ts#L352).

`read_file` uses the older workspace IPC path. It rechecks workspace authorization around extraction, but returns no source hash and registers no read with the directory run. `rememberEvidence` retains text only in the renderer, without a hash. Final validation therefore knows about RAG, analytics, MyAgent, and native inspections, but not these reads. The same unversioned text can be forwarded to a child editing agent.

**Reproduction:** Read a temporary selected text file, call `rememberEvidence`, modify the file, then call `verifyInspections`. Verification returned `null`, accepting the answer. The post-response directory comparison is too late to replace this missing check.

**Recommendation:** Route plain-text reads through the run-scoped main-process service. Return a bounded, versioned evidence receipt and retain it in the same source registry used by other tools. Check the selected allowlist and cancellation there as well.

### F3 — P2: Failed runs can re-enter history through intermediate assistant text

**Evidence:** [WorkspaceChat.tsx:330](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L330), [WorkspaceChat.tsx:455](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L455).

Tool-turn commentary is sealed as an ordinary, non-error assistant message. When a later step fails or is stopped, only the current streaming message receives the error flag. The next request restores matching non-error messages independently, without checking whether their enclosing request completed successfully. A failed request with earlier commentary therefore looks like a valid user/assistant exchange. AgentLoop's own failed-run rollback cannot fix this because directory chat creates a new loop from the UI transcript each time.

**Reproduction:** Applying the current restore filter to a failed request retained its user instruction and intermediate assistant statement while dropping its final error.

**Recommendation:** Store request identity, message phase, and final outcome. Restore successful user/final-answer pairs and explicitly retained user preferences. Keep failed/intermediate text visible as history without treating it as verified answer context.

### F4 — P2: An output-limit cutoff is displayed and saved as completed

**Evidence:** [loop.ts:710](../../packages/agent-core/src/loop.ts#L710), [WorkspaceChat.tsx:460](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L460), [controller.ts:247](../../apps/shell/src/renderer/src/directory-actions/controller.ts#L247).

AgentLoop reports `truncated: true` for `max_tokens`. The directory root handler ignores this field and completes the activity and message normally. Its child editing handler already handles truncation correctly. Users can receive an incomplete answer or list labelled “Worked,” and that partial answer can be restored as successful history.

**Recommendation:** Represent the response as incomplete, retain the partial text, and offer continuation. Exclude it from successful-answer restoration until resolved. Keep the provider stop reason in diagnostics.

### F5 — P2: Every request waits for MyAgent preparation, including directory listings

**Evidence:** [WorkspaceChat.tsx:421](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L421), [myagent-skill.ts:12](../../apps/shell/src/renderer/src/rag/myagent-skill.ts#L12), [myagent.ts:239](../../apps/shell/src/main/rag/myagent.ts#L239).

Preparation happens before the first model request regardless of question or selection. Selected discovery sequentially hashes and requests metadata for every mapped selected file, then requests the catalog. It catches each document failure separately. A common outage or invalid credential can therefore be retried for every file before the optional integration is abandoned. Even zero-selected-file listings call the catalog; a deliberately disabled backend is recorded as a failed preparation step.

**Reproduction:** Three mapped files and a simulated shared connection failure produced four sequential connection attempts before preparation finished. With default 60-second request timeouts, a black-holed service can multiply the delay; a quick connection refusal is much faster.

**Recommendation:** Separate static capability/schema discovery from advisory readiness and content execution. Skip MyAgent preparation for clearly metadata-only requests and empty content selections; preserve a discovery path when intent is uncertain. Use one request-level availability check/circuit breaker, a small preparation deadline, and bounded concurrent or batched readiness. Show disabled/not-needed states separately from failure.

### F6 — P2: Whole-directory hashing adds work and invalidates unrelated conversation context

**Evidence:** [history-worker.cjs:333](../../apps/shell/src/main/history/history-worker.cjs#L333), [history-worker.cjs:372](../../apps/shell/src/main/history/history-worker.cjs#L372), [WorkspaceChat.tsx:320](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L320), [WorkspaceChat.tsx:294](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L294).

Before each request, the fingerprint walks the opened folder and selected folders recursively, including unselected files. The whole-tree hash gates conversation restoration. A completed request then starts another comparison scan, including after read-only work. There is also a comparison when opening history. An unrelated file edit drops all prior model context, while an unrelated oversized or inaccessible file makes the fingerprint incomplete. This is disclosed in the UI, but it is unnecessarily coupled to answering about selected files.

**Reproduction:** One selected file in a three-file directory caused three files to be hashed. Changing an unselected file changed the chat fingerprint while the selected-only fingerprint stayed identical. Lowering the fixture's byte limit demonstrated an unselected oversized file making the whole check incomplete. The implementation deduplicates paths; the larger file count in the supplied trace is not proof of duplicate hashing within one scan.

**Recommendation:** Separate directory change history from the evidence versions needed by a request. Keep directory comparison on demand or in the background; pin and revalidate the actual read sources. Metadata-only questions should not wait on file-content hashes. Preserve user intent/preferences when unrelated files change, while invalidating dependent factual claims.

### F7 — P2: Source checks are repeated across multiple layers

**Evidence:** [manager.ts:393](../../apps/shell/src/main/directory-actions/manager.ts#L393), [manager.ts:408](../../apps/shell/src/main/directory-actions/manager.ts#L408), [manager.ts:364](../../apps/shell/src/main/directory-actions/manager.ts#L364), [myagent.ts:303](../../apps/shell/src/main/rag/myagent.ts#L303), [myagent.ts:344](../../apps/shell/src/main/rag/myagent.ts#L344), [service.ts:193](../../apps/shell/src/main/rag/service.ts#L193).

For MyAgent execution, the manager first verifies all previous evidence. The adapter separately checks the current targets before and after HTTP execution. The manager then hashes returned sources again. MyAgent sources are also stored in the generic evidence map, so verification rehashes them after the MyAgent verification path already did so. RAG search similarly hashes returned hits in both the service and manager. Native verification hashes its retained source and then validates an open inspection before and after native claim checking.

**Reproduction:** Initial discovery for three selected files, two useful tools against one file, and final verification produced **16 HTTP requests**: 11 document metadata requests, 3 catalog requests, and 2 executions. This was an instrumented fixture using the actual adapter and manager, not a production latency measurement. Local hashing adds work beyond those HTTP requests.

**Recommendation:** Give one layer ownership of versioned evidence receipts and one final validation pass. Batch server revision validation instead of using catalog requests for it. Reuse validation within a defined operation boundary, while retaining checks across network waits, user approval, and final commit. Do not replace content integrity with a long-lived mtime-only cache or remove necessary pre/post checks indiscriminately.

### F8 — P2: Tool selection is still broad, with duplicate routes and no structured metadata reuse

**Evidence:** [WorkspaceChat.tsx:434](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L434), [myagent-skill.ts:39](../../apps/shell/src/renderer/src/rag/myagent-skill.ts#L39), [analytics/skill.ts:9](../../apps/shell/src/renderer/src/analytics/skill.ts#L9), [controller.ts:105](../../apps/shell/src/renderer/src/directory-actions/controller.ts#L105).

Every request advertises all 20 base tools, then up to 6 MyAgent tools. The base composed prompt is 14,348 characters and its serialized tool definitions are 11,884 characters in the probe, before the MyAgent schemas, readiness context, history, and worksheet guidance. These are character measurements, not provider token measurements.

Three reading routes and two analytical routes remain available together. Current prompts explain which to prefer, but there is no task/capability gating. Even questions about filenames receive analytics and editing schemas. MyAgent's own server agent has a spreadsheet metadata preparation shortcut; Nawa's initial context supplies readiness/document IDs, not SQL table/column identities. Follow-up requests retain prose but drop structured tool evidence, and the request-local catalog cache matches exact payloads only. Initial discovery and later schema discovery generally have different payloads.

The supplied `inspect_file` followed by `get_workbook_context` also rereads context that inspection already returned. Both originate from `buildWorkbookContext`; unless state/loading changed, that extra model/tool round trip adds no evidence. The earlier used-range count shortcut has now been removed from directory inspection, but the general redundant-call opportunity remains.

**Recommendation:** Use a small common tool set plus relevant capability bundles, with explicit discovery available for ambiguous requests. Reuse versioned dataset metadata and already-returned native context. For named-workbook analysis, optionally prepare a bounded scoped dataset catalog so the model can call SQL directly. Do not add another LLM request merely to classify an obvious intent. Keep routing policy in one place rather than expanding several overlapping prompt sections.

### F9 — P2: More than 100 selected files blocks even a one-file MyAgent target

**Evidence:** [myagent.ts:270](../../apps/shell/src/main/rag/myagent.ts#L270), [myagent.ts:277](../../apps/shell/src/main/rag/myagent.ts#L277), [manager.ts:76](../../apps/shell/src/main/directory-actions/manager.ts#L76).

The adapter rejects the overall selection before applying `paths` or document-ID narrowing. The directory run accepts up to 256 selected items, so selecting 101 files prevents a valid query against one of them. Selected catalog discovery also fails above 100.

**Reproduction:** Passing 101 selected paths with an explicit one-file target failed with “MyAgent tools support at most 100 selected files” before accessing the target.

**Recommendation:** Validate the requested subset against the full allowlist, then apply the API's 100-document limit to that subset. Page/batch readiness separately. A request truly covering more than 100 files needs explicit batching and coverage accounting, especially for aggregate results.

### F10 — P2: Root-level action claims are enforced only by prompts

**Evidence:** [controller.ts:283](../../apps/shell/src/renderer/src/directory-actions/controller.ts#L283), [controller.ts:338](../../apps/shell/src/renderer/src/directory-actions/controller.ts#L338), [skill.ts:79](../../packages/agent-core/src/skill.ts#L79).

The native child has claim verification, but the directory mutation skill supplies no `verifyResponse` guard. A declined action returns ordinary text with `mutated: false`, and the loop records it as `ok` because it is not an error. The root can consequently accept an unsupported “I updated the file” statement; source verification does not check commit receipts. Actual writes still require approval, so this is a reporting gap, not an approval bypass.

**Reproduction:** The composed directory skill returned no correction for a success claim accompanied by a failed `update_file` execution. This demonstrates the missing guard; it is not evidence that the pasted conversations falsely reported a write.

**Recommendation:** Return structured outcomes such as `committed`, `declined`, `discarded`, and `failed`. Track immutable commit receipts separately from generic tool success. Derive file-action completion UI from those receipts and reject unsupported final action claims.

### F11 — P2: Citations cannot open their supporting evidence

**Evidence:** [WorkspaceChat.tsx:61](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L61), [Markdown.tsx:42](../../packages/ui/src/Markdown.tsx#L42).

Directory answers use `Markdown` without a navigation handler. That renderer deliberately leaves links literal unless the host supplies an allowed navigation scheme. Consequently `[RAG 1](RAG:...)` is displayed as text. The new citation IDs distinguish identical file copies, but users still cannot click through to check a passage or workbook row.

**Reproduction:** Rendering a representative citation produced no anchor element.

**Recommendation:** Persist a bounded citation-to-source map separately from debug strings. Provide trusted in-app navigation to the returned file/location, with a stale-source indication when versions differ. Resolve only registered citation IDs; never treat arbitrary model URLs or paths as authority.

### F12 — P2: Diagnostics omit important work and truncate the evidence needed to debug it

**Evidence:** [WorkspaceChat.tsx:339](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L339), [WorkspaceChat.tsx:436](../../apps/shell/src/renderer/src/WorkspaceChat.tsx#L436), [activity.ts:8](../../apps/shell/src/renderer/src/directory-actions/activity.ts#L8), [ActivityTimeline.tsx:50](../../apps/shell/src/renderer/src/directory-actions/ActivityTimeline.tsx#L50).

The activity distinguishes model and tool calls, which is useful. However, final verification, HTTP request counts, source hashing, preparation cache misses, and save/check work are not individually timed. A two-tool operation can conceal the 16 requests measured above. Raw output is capped at about 2,400 characters; coverage, warnings, source details, or SQL outcome fields later in a response can disappear. “Copy diagnostics” copies the already-truncated activity, not a complete diagnostic receipt. Child timings also overlap parent timings, so adding all displayed durations would double-count work.

**Recommendation:** Record compact typed fields before truncating raw payloads: operation/backend, request and parent IDs, target counts, coverage, result ID, source revisions, truncation, cache status, validation duration, HTTP count, and terminal outcome. Keep raw excerpts optional and bounded. Show preparation, actual actions, model waits, validation, and user-wait time separately inside the existing collapsed activity row. Do not collect hidden model reasoning or unbounded file content.

## Additional efficiency issues

- **Whole-transcript checkpoint writes:** Every dirty 750 ms checkpoint sends the full conversation, and [history-worker.cjs:235](../../apps/shell/src/main/history/history-worker.cjs#L235) deletes/reinserts every message. This scales with historical activity size rather than the current response. Use per-message upserts and append/update activity deltas. Existing memoized rows and frame-buffered text are useful and should remain.
- **Independent reads run serially:** [loop.ts:731](../../packages/agent-core/src/loop.ts#L731) awaits each returned tool call. Add bounded concurrency only for tools explicitly marked independent/read-only. Editing, approvals, inspection state, retained results, and dependent discovery must remain ordered; blanket parallelization would be incorrect.
- **Runaway-read budget is loose:** The default is 100 tool turns plus a finalizing model call. The repeat guard compares full outputs, so changing timestamps/result IDs can defeat it. Use task-specific budgets and semantic repeat detection that ignores volatile metadata, while allowing legitimate paging. Eight all-error turns is also expensive for a simple lookup.
- **Commit invalidation causes avoidable rediscovery:** [manager.ts:318](../../apps/shell/src/main/directory-actions/manager.ts#L318) clears all discovered MyAgent tool names after changing a used source. The renderer still advertises its initial direct tools. A following tool against an unchanged file can fail until rediscovery. Invalidate affected evidence/readiness while keeping schema authorization synchronized.
- **Search lacks per-call targets:** `search_contents` only accepts a query, so even “find X in this one selected workbook” can search and validate every selected file. Add an optional selected subset with coverage reporting. Keep hybrid search labelled as candidate retrieval; exact-match or exhaustive questions may need `spreadsheet_search_text`, document-specific search, or SQL verification.
- **Automatic neighbor reads:** MyAgent retrieval fetches neighbors for the first two hits before checking whether they will fit the remaining context budget. Use them when they add useful context, and avoid redundant overlapping requests. Do not assume all top-k candidate files are exact matches.

## What is already correct or improved

- Listing an opened/selected directory is allowed with zero selected files; reading contents requires individual selection. Directory selection is not recursive content permission.
- Metadata-only server tool discovery does not require indexing. Selected catalogs report advisory readiness; executions can target ready subsets. Keep that separation.
- MyAgent calls pass explicit document scope and verify local/server revisions. Native inspection works on saved copies; native read policies reject write tools.
- Source hashes, index/dataset revisions, final validation, cancellation, and approval/commit checks are necessary work. Consolidate them rather than deleting them for speed.
- Reviewed Nawa analytics and MyAgent exploratory SQL have different policies. Keep the reviewed/exact-decimal route available; do not force simple lookups or ordinary counts through policy approval.
- The current name/phrase prompts avoid the earlier dataset-discovery detour. Search activity says “candidate files,” and duplicate-file citation identities are distinct.
- Directory inspection no longer instructs the model to infer employee counts from worksheet extent. This is a meaningful improvement, but prompt guidance alone is not a general numerical-proof mechanism.
- Updates/creation use preparation and save approval; deletion uses one explicit Recycle Bin approval. Those are purposeful boundaries. Read-only queries should not gain additional permission dialogs.
- The separate, initially collapsed activity row, real tool names, cancellation handling, bounded diagnostics, frame-buffered streaming, and shared composer are useful UX improvements.

## Recommended tool paths

Counts below are ordinary model-driven paths, assuming necessary schemas are active and no retries. Preparation and integrity checks are separate from semantic tool calls.

| Request | Preferred tools | Typical model requests | Avoid |
| --- | --- | ---: | --- |
| List the opened directory | `list_directory` | 2 | MyAgent readiness, content hashing on the critical path, dataset discovery |
| List selected filenames | Existing selection context or `list_files` for pagination | 1–2 | Content retrieval |
| List all knowledge tool names | `discover_knowledge_tools(scope=server, namesOnly=true)`; page if needed | 2+ | Indexing prerequisites or per-file readiness |
| Find a person's name across files | `search_contents`; targeted exact verification when needed | 2+ | Analytics discovery, guessed query fields, exhaustive claims from top-k hits |
| Count records in a known indexed workbook | Scoped dataset catalog → SQL aggregate; describe only if metadata is insufficient | 3; 2 with verified prepared/reused metadata | Native editor startup, duplicate context reads, used-range arithmetic |
| Count unique employees | Same route, checking non-empty/distinct identifiers and population | 3; 2 with verified prepared/reused metadata | Treating rows as people without checking identity |
| Reviewed financial/statistical calculation | Nawa discovery/description → `query_data`/`analyze_data`; receipt inspection as needed | Depends on metadata | Silently substituting different MyAgent policies |
| Inspect saved formulas/formatting | `inspect_file` → relevant `query_file` reader | 3+ | Re-querying unchanged initial context, using RAG samples as exhaustive evidence |
| Edit a file | Root action → prepare approval → native child → preview/save approval → commit receipt | Task dependent | Success claims based on child prose or a declined proposal |

MyAgent's own metadata shortcut is described in [RAG_SYSTEM.md, preparation and routing](C:/Dev/my-agent-feat-service/docs/RAG_SYSTEM.md#73-example-employee-count). Nawa currently shares tools through the API, but does not inherit that entire server-agent preparation/history policy.

## Recommended implementation order

1. **Evidence correctness:** F1–F4 and structured action outcomes from F10. Add one versioned evidence registry covering every reader, mandatory final validation, and request-level history outcomes.
2. **Routing and latency:** F5–F9. Narrow tool bundles, separate readiness from schema discovery, reuse dataset metadata, apply limits after scoping, and consolidate repeated validation. Preserve a discoverable fallback for ambiguous questions.
3. **Debugging and navigation:** F11–F12. Add structured receipts, trusted citations, phase timings and HTTP/cache counters; retain the compact default activity layout.
4. **Long-session efficiency:** Incremental persistence, bounded safe read concurrency, task budgets, and synchronized invalidation after commits.

Avoid another broad prompt-only patch. A shared routing/evidence contract will remove more redundancy and be easier to test than adding similar instructions to each skill.

## Validation and limits of this review

Executed against the current working tree:

- `npm run test -w @genoffice/agent-core`: **92 tests passed** in 6 files.
- Targeted shell MyAgent, RAG, inspection, activity, history-cancellation, and analytics-service suites: **64 tests passed** in 9 files.
- An isolated executable probe using actual AgentLoop, directory skills/client/manager, MyAgent adapter, history fingerprint code, and Markdown renderer. Files and transport responses were synthetic. It reproduced F1–F3, F5–F7, F9, and F11; measured F8; demonstrated the missing action-claim hook in F10; and confirmed AgentLoop's truncation signal for F4.

Probe: [probe.mjs](../../.task/directory-agent-review/probe.mjs). Raw results: [results.json](../../.task/directory-agent-review/results.json). These local `.task` artifacts are not tracked. Run with `node .task/directory-agent-review/probe.mjs` from the repository root. It creates/removes only its own temporary fixtures, uses fake HTTP/model transports, and does not read service credentials or modify user documents.

Source review also covered the MyAgent API bridge and relevance policy, directory approvals/staging, inspection lifecycle, conversation persistence, tool schemas/prompts, and activity rendering. Existing tests passing does not establish that a live model will follow the preferred route; this review did not make paid model calls, rerun a full desktop visual QA session, or change/restart either application.

Add behavioral regressions for: a changed source during correction/finalization; changed plain-text evidence; failed-run restoration; output cutoff; offline multi-file preparation; unrelated folder edits; a one-file target inside a 101-file selection; declined actions followed by success claims; citation navigation; and diagnostic coverage surviving large outputs. Then evaluate the user's listing, Hollie Parker, and employee-count prompts with recorded model/tool traces. Assert correctness and unnecessary-call counts, not merely that prompts contain preferred instructions.
