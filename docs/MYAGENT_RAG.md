# MyAgent RAG on the same machine

Nawa can use the MyAgent HTTP API for document extraction, embeddings, indexing and hybrid retrieval. Nawa retains its chat provider, selected-file permissions, native editor tools and reviewed-table analytics.

## Setup

1. Build and restart MyAgent from the checkout containing the Nawa API additions. The running server must return `localPath` and ingestion limits from `/api/v1/rag/roots`, and `contentHash` plus `indexRevision` on documents, search hits and chunk windows.
2. Configure shared document folders and the embedding provider in **MyAgent.Server.UI**, or use Nawa's **Settings → MyAgent** once the server is connected. The MyAgent process must have read access. Shared-folder changes require a server restart.
3. In Nawa, open **Settings → MyAgent → Connection**, or **Knowledge → Setup → Connection and search**. Set its URL (normally `http://127.0.0.1:5187`), enter the MyAgent **service API key**, enable RAG, and test/save the connection. The service key grants administrator access; ordinary user sessions cannot start ingestion jobs. Keys are protected using Electron's OS-backed storage and are never returned to the renderer. The same directory Setup form supports choosing the local embedding backend.
4. Open a document folder. In **Knowledge → Files**, select individual files and choose **Check selected files** to inspect their index readiness. Confirm selected-file processing consent and choose **Refresh selected files**, or expand **Index the whole directory** for the separate directory controls. Nawa submits explicit root-relative file batches and polls jobs. No upload copies are needed.
5. Select individual files and ask the assistant. Indexing a directory does not grant the assistant permission to search all its children.

For example, the MyAgent root configuration can contain:

```json
{
  "MyAgent": {
    "Rag": {
      "Roots": [
        { "Id": "documents", "DisplayName": "Documents", "Path": "C:\\Documents" }
      ]
    }
  }
}
```

New Nawa settings default to MyAgent, initially disabled. Existing saved embedding settings migrate to **Local embeddings**, preserving their behavior until you switch. Changing backend or server identity requires replacing or explicitly removing a stored credential.

## MyAgent server settings in Nawa

The directory Knowledge panel has three views: **Files**, **Tables**, and **Setup**. Files is the default and contains index checks and refresh actions; Tables contains imports and review. Setup has one **Settings area** selector for connection/search, document tools, server status/readiness, models/embeddings, shared folders, extraction/indexing, server launch, and local table settings. The directory panel has one connection form. Controls appear first; explanations are collapsed under Help. Extraction settings are grouped into File limits, OCR and Office, Visual extraction, and Timeouts and retries, collapsed by default in the directory panel. Server settings use the same shared draft across their areas; switching views keeps drafts and admitted jobs, with notices linking back to hidden edits or background activity. Unsaved connection changes block server actions, and server work suspends the shared connection form. The file-search status **Enabled** describes the saved configuration; per-file checks establish snapshot readiness.

**Setup → Document tools** loads a searchable live catalog from the saved MyAgent connection. Choose selected file types or all server document tools, and load more pages as needed. Tool descriptions and parameter schemas start collapsed. Discovery uses only extension hints, never file paths, contents, hashes, or document mappings; indexing is unnecessary. Scope changes clear the prior list; Search/Refresh loads the new filter on demand. Saving a connection discards an earlier catalog or pending result. This browser lists definitions rather than enabling individual tools or executing them. The assistant still chooses tools and enforces selected-file permissions when reading content. The application-wide connection page offers the same catalog inside its MyAgent document tools disclosure.

The dedicated MyAgent page shares the protected connection used by file search. It reads `/api/v1/health`, `/api/v1/config`, `/api/v1/llama/profiles`, and `/api/v1/llama/status` in the main process. Administration is user-controlled; these endpoints and local service controls are not agent tools.

The page edits chat/classification and embedding provider settings, provider keys, shared RAG folders, indexing limits, supported extensions, and visual extraction policy. **Indexing and visual extraction** also exposes Tesseract OCR and LibreOffice executable paths, the page limit (zero means unlimited), embedded-image extraction, page rendering, image limits, visual extraction timeouts, and retries. Blank executable paths use MyAgent's installed defaults; these controls do not install dependencies. MyAgent stores its own provider keys; blank inputs keep them and explicit removal clears them. Configuration saves use `PUT /api/v1/config`, preserve unedited storage/runtime settings, and reject a draft if the connection or returned configuration changed. Changes eligible for live application call `/api/v1/server/reload-configuration`. Other changes display the server's restart requirement, with no automatic restart. MyAgent may normalize installation defaults on the first configuration save and report a restart requirement.

**Check readiness** makes two bounded, authenticated read-only requests to `/api/v1/health` and `/api/v1/readiness`. The report distinguishes an available chat provider from a managed model that starts on demand, shows reported RAG components and missing LibreOffice support, retains partial failures, and offers **Copy readiness diagnostics**. It never starts a model. This API probes the chat provider; embedding connectivity and OCR execution are checked during indexing/extraction, not by this report. Opening or refreshing settings does not trigger the provider readiness probe.

Start/stop/restart can control the installed `MyAgentServer` Windows service, subject to Windows permissions, or an explicitly selected `MyAgent.Server.exe`/`MyAgent.Server.dll`. Process mode uses fixed arguments and a hidden process. The configuration/data directory defaults to `%APPDATA%\MyAgent\server`; choose the directory used by your existing server. Nawa only creates `appsettings.json` if it is missing and requires a saved service key to do so. It preserves an existing configuration and does not copy or migrate legacy data into a newly created setup. A running server keeps running when Nawa closes; use Stop to shut it down. Restarting an externally started process requires its launch paths first.

Managed models can be started/stopped using their advertised profile IDs. Chat and embedding runtime selectors show the appropriate kinds. Enter the runtime's API URL and served alias separately; the profile API reports a model filename/repository, not necessarily its served alias. Use MyAgent.Server.UI's **Setup** and **Runtime** tabs to install dependencies, download models, and create/edit GGUF profiles. User-account setup and low-level service installation remain in MyAgent.Server.UI. Refresh Nawa to see those changes. After changing embeddings/extraction, index/refresh affected files through Knowledge.

Server drafts survive status refreshes and settings-section switches. Stop/restart shows a confirmation because it interrupts MyAgent work, including requests from other clients. Server actions are disabled while connection or server drafts are unsaved.

## Scope and freshness

Nawa stores only local-path/document-ID/fingerprint mappings in `rag/myagent-files-v1.json` under its application data directory. MyAgent owns the text, vectors and shared database.

- Search always sends explicit document IDs for mapped, individually selected files. Empty selections never reach the server because MyAgent interprets empty IDs as an unrestricted catalog search.
- MyAgent supports at most 100 selected documents per search. Nawa reports that limit instead of silently dropping files.
- Nawa compares local SHA-256 fingerprints with the indexed hashes and checks index revisions before/after retrieval. Changed files or server generations require refresh. Old servers missing fingerprint fields are rejected.
- Returned passages preserve file paths and page/sheet/row/slide/section citations. Neighbor reads share the same version checks and context budget.
- Hidden entries, links and `node_modules` are excluded. Server format/file-size/batch limits are honored. Interrupted jobs are canceled through the server's job API; completed mappings remain reusable.
- **Forget file mappings** removes only Nawa's mappings for the directory. It never deletes shared server documents, original files, or chat history. Manage the shared index in MyAgent.
- File badges reflect the last mapped generation and current local fingerprint; retrieval additionally verifies the server generation.

The selected-file controls check or refresh at most 256 individual files inside the opened directory. Selected folders are not expanded. **Check selected files** verifies local bytes and the mapped server snapshot on demand, with at most four concurrent bounded server requests; it distinguishes unindexed, stale, failed, verified, and indexed-but-unverified files. Connection changes discard the prior readiness display and consent. Content tools still recheck their targets when called.

**Refresh selected files** captures the files selected when the action starts, chooses each file's deepest available server root, and honors its format, size, and batch limits. It preserves unselected mappings and reprocesses selected files even when their bytes are unchanged, so applied extraction settings can take effect. Changing the Explorer selection does not cancel an admitted job; it requires new consent for the next action. Per-file progress shows failures, and **Retry failed files** retries only failed paths that remain selected. **Stop indexing** cancels the active job and keeps completed mappings. Whole-directory refresh retains its existing unchanged-file optimization.

MyAgent can use a remote embedding provider if configured to do so. Consent refers to MyAgent's configured processing and shared storage even when its API connection uses localhost.

Nawa's reviewed-table analysis retains explicit schema review and integer/decimal calculations. The assistant can also discover MyAgent's spreadsheet SQL and text-classification tools for exploratory analysis; their policies are different and results identify that distinction.

## Document and analysis tools

After enabling MyAgent, each directory request automatically loads up to six relevant MyAgent tools within a 3,500-token schema budget, chosen by the same `KnowledgeToolRelevance` policy as MyAgent's own agent. Selected extensions keep discovery available before indexing; ready document manifests add capabilities such as embedded images. Nawa also exposes two bridge tools for everything else:

- `discover_knowledge_tools`: defaults to `scope: "selected"`, returning up to eight applicable schemas and separate per-file `files` readiness (`ready`, `needs-index`, `unavailable`). Missing/stale files do not block the catalog. For **all tool names**, use `{ "scope": "server", "namesOnly": true }`, which skips files/mappings entirely and returns up to 100 names. Follow `nextOffset`. Both modes return `scopeChecked: false` and `sources: []`: tool metadata and advisory readiness are never content evidence.
- `use_knowledge_tool`: invokes a schema discovered during the current Nawa request. Optional `paths` narrows it to exact selected local files. Directly exposed tools accept the same selector as `_nawaFiles`; Nawa removes that field before sending provider arguments. Explicit `documentId`/`documentIds` also narrow an operation automatically. Dataset/analysis/result IDs alone do not narrow scope; supply paths for them. The main process supplies source fingerprints, and the server verifies them; arguments cannot expand the immutable selection.

The bridge exports MyAgent's PDF/Word page and section readers, presentation slides/notes, visual and image inspection, text/Markdown, structured-data, message and archive readers, spreadsheet catalog/ranges/read-only SQL, saved text classification, and retained-result paging (`tools.read_result`). Availability depends on selected formats, server capabilities and provider configuration. Visual readers still require relevant rendering assets and configured extraction/model support. Unsupported capabilities return tool failures.

The assistant uses Nawa `search_contents` to locate evidence, direct MyAgent readers for detail, MyAgent SQL for exploratory counts/joins, and Nawa `query_data`/`analyze_data` for reviewed policies and exact decimal calculations. Native `inspect_file`/`query_file` remains available for formulas, formatting and saved Office structure. Editing still uses Nawa's existing approval/staging workflow.

MyAgent SQL aggregates indexed rows, which may include hidden rows and cached formula values; numeric fields may use floating point. Neither backend recalculates workbook formulas. Classification uses MyAgent's configured chat model (which may be remote), saves derived analysis on the server, and reports processed coverage and uncertain labels. It does not edit source workbooks. Follow-up classification queries reuse saved analysis IDs. A timeout/interruption can leave saved classification progress; discover `spreadsheet_analysis_list` and resume using `analysisId`.

Only the operation's target files need current mappings. A ready file can be read while another selected file needs indexing. A call targeting all files fails with per-file reasons if any target is unready; it never silently runs over a smaller scope. Results include `coverage` with selected count, requested/covered paths and `completeSelection` (file scope only, not row/page completeness). The assistant must explicitly report omitted files when answering an all-files question from a subset. Execution checks local hashes and server revisions before/after reads. Evidence from every executed subset is retained and verified before accepting the final answer or preparing an edit; catalogs pin no evidence. Each active request uses the selection captured when sent; selection changes apply to the next request. Switching chats or models, or choosing Stop, cancels preparation and execution. If automatic tool preparation fails, Nawa's native tools still load and the assistant receives the failure reason. Tool calls allow at least three minutes; classification allows at least ten. Retained-result paging must reuse the original target paths as well as the request/session; expired or changed-scope handles require re-reading.

The API additions are `POST /api/v1/rag/tools/catalog` and `POST /api/v1/rag/tools/execute`, both requiring a service/administrator credential. Catalog accepts `query`, `offset`, `limit` (1–20 for schemas, 1–100 with `namesOnly: true`). No scope or hints lists server metadata without touching manifests. Optional `extensions` and `documentIds` filter metadata using shared type/capability rules; missing manifests are tolerated and these hints never authorize execution. `initial: true` and optional `task` (up to 2,000 characters) add a compact `initialTools` bundle without changing normal pagination. `selectionFiltered` confirms the server understood the filter. The older strict catalog scope remains supported for evidence verification: `{ sessionId, sources: [{ documentId, contentHash, indexRevision, datasetRevision? }] }`. Execution always requires that scope plus `tool` and `arguments`; empty/missing scopes are rejected. Names alone do not authorize invocation without schemas. Tool failures are distinct from HTTP 409 source-version conflicts. Browser, shell, arbitrary MCP tools, editing and server-agent delegation are excluded. Nawa keeps its own chat provider and agent loop.

Rebuild/restart **both** applications to activate the new tools. Existing installations using local embeddings stay on that backend until switched; local mode reports MyAgent tools unavailable and retains Nawa's native tools. No live server configuration or credentials are changed by the integration tests.

## Validation

```powershell
npm run test -w @genoffice/shell -- tests/myagent-rag.test.ts tests/rag-service.test.ts tests/myagent-skill.test.ts tests/myagent-directory.test.ts
npm run test -w @genoffice/shell -- tests/myagent-settings.test.ts tests/settings-myagent.test.ts tests/selected-file-refresh.test.ts
npm run test -w @genoffice/shell -- tests/knowledge-navigation.test.ts
npm run test -w @genoffice/shell -- tests/myagent-document-tools.test.ts
node tools/rag/test.mjs
node tools/sidebar-review/test.mjs
node tools/myagent-settings-review/test.mjs
npm run typecheck -w @genoffice/shell
npm run build -w @genoffice/shell
```

`tools/rag/myagent-integration.mjs` starts an isolated real MyAgent HTTP server with temporary documents, deterministic embedding/classification fixtures and a separate data directory. Set `NAWA_MYAGENT_SERVER_DLL` to a built server DLL with its dependency/runtime files, then run the script. It checks administration settings, readiness, extraction controls, live reload, stale drafts, restart requirements, authentication, metadata-only tool search/filtering/pagination before indexing, indexing/search, selected-file refresh and preserved unselected mappings, snapshot verification, direct text readers, tool discovery, scope/schema rejection, complete SQL counts, mutation rejection, classification and saved analysis reuse, retained-result paging and session isolation, stale-file rejection, refresh and preservation of shared records. It verifies integration behavior, not real-model classification accuracy or visual quality. The isolated server sets `MyAgent:MigrateLegacyData=false` so it does not migrate the desktop user's legacy databases or model assets. This setting defaults to true for existing deployments. Local service/process controls are tested with mocked launchers; these checks do not start or stop the user's installed Windows service.
