# MyAgent tool catalog and compact directory settings

Updated on 2026-09-28 after feedback that the document tools section contained explanations and that settings were too wordy and scattered.

- Knowledge → Setup has a dedicated Document tools area with a live catalog, selected-type/server scope, explicit search/refresh, and pagination. Names remain visible; descriptions, schemas, connection details, and help start collapsed.
- Catalog requests use the saved protected connection in the main process. Requests contain only query, pagination, and optional extension hints. They do not send file paths, content, document IDs, or evidence scope. Responses must attest metadata-only behavior, and selected-type filtering when requested. The catalog can be viewed before indexing.
- Connection, server, and local table settings show controls first in the directory panel. Explanatory copy is optional. Extraction controls use four collapsed groups: File limits, OCR and Office, Visual extraction, and Timeouts and retries. The embedding form starts collapsed alongside the chat model form.
- The connection remains shared. Navigation preserves drafts and admitted jobs; unsaved connection changes block catalog loading and server actions. Connection changes discard stale catalog results, including pending responses. Catalog browsing does not execute tools or change selected-file permissions.
- The application-wide settings layout retains its explanations and expanded server configuration. Its MyAgent document tools disclosure uses the same live catalog and loads only when opened.

Verification:

- Seven focused test files: **35 tests passed**, covering protected/bounded catalog requests, metadata response validation, lazy loading, stale response rejection, search, paging, settings drafts, action guards, and refresh behavior.
- Directory sidebar browser scenarios: **58 checks passed**, including collapsed descriptions and extraction groups, search/filtering/paging, draft retention, and English/Arabic layouts at 300px. Screenshots are under `.task/sidebar-review/`, including `myagent-document-tools-300.png` and `knowledge-extraction-groups-300.png`.
- Application-wide MyAgent settings browser scenarios: **21 checks passed**.
- The isolated real MyAgent HTTP integration passed, including authenticated catalog search/filtering/paging before indexing and the existing configuration, refresh, retrieval, SQL, and classification scenarios.
- Type check and production build passed; existing bundler import warnings remain. Whitespace checks passed.

Browser scenarios use real renderer components with synthetic desktop bridges. HTTP scenarios use an isolated server with temporary documents and configuration. They do not change the user's live server, credentials, or documents.
