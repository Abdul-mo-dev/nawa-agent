# Essential MyAgent integration additions

Implemented on 2026-09-28 after reviewing the native MyAgent.Server.UI and the server API. Scope: readiness diagnostics, selected-file refresh/retry, and extraction settings.

## Behavior

- **Settings → MyAgent → Check readiness** requests health and provider readiness on demand. The report distinguishes provider availability from managed startup on demand, shows component failures and actionable next steps, preserves partial failures, and supports copying the report. It never starts a model. MyAgent's readiness endpoint probes the chat provider; live embedding and OCR checks occur during indexing/extraction.
- **Knowledge → File search → Selected files** checks local/server snapshot consistency only when requested. Refresh captures explicit individual files inside the opened directory, supports multiple configured server roots, and respects format, size, and batch limits. It never expands selected folders or removes unselected mappings.
- Selected refresh reprocesses unchanged files, allowing applied extraction changes to take effect. Per-file progress identifies failures. Retry intersects failures with the current selection. Selection changes preserve an admitted job and reset consent for the next one; connection changes clear readiness and consent. Stop uses existing job cancellation and retains completed mappings.
- **Indexing and visual extraction** adds OCR/LibreOffice paths, page/image limits, image extraction and rendering switches, timeout, and retry controls. API saves preserve unedited storage/runtime fields and enforce server-compatible bounds. Restart requirements remain explicit; dependency installation stays in MyAgent.Server.UI.

## Verification

- Ten focused MyAgent, RAG, settings, and directory-agent test files: **136 tests passed**. Covered consent, path boundaries, cross-root batches, unchanged-file refresh, cancellation, preservation, status verification, partial readiness failures, credentials, extraction validation, selection changes, and directory tool routing.
- `node tools/myagent-settings-review/test.mjs`: **21 checks passed**. Includes on-demand readiness without model startup, extraction saves, selected-file checks and consent, failure/retry scope, draft preservation, restart confirmation, English and Arabic layouts at 300px, and no renderer errors. Screenshots: `.task/myagent-settings-review/`.
- `node tools/sidebar-review/test.mjs`: **44 checks passed** for the existing sidebar, including Knowledge settings, persistent drafts, background jobs, narrow layouts, RTL, keyboard focus, and no renderer errors. Screenshots: `.task/sidebar-review/`.
- Isolated real MyAgent HTTP integration: readiness and extraction configuration, live reload and restart requirements, selected refresh of unchanged files, preserved unselected mappings, verified snapshots, and existing scoped retrieval/readers/SQL/classification scenarios passed.
- Shell type checking, production build, and whitespace checks passed. The build reports existing mixed static/dynamic import warnings in Office parsing and PDF code.

The HTTP integration uses a temporary server/data directory with deterministic test providers. It does not modify the live server configuration, user documents, index, or installed service. Dependency execution and real-model visual/classification quality are outside this validation.
