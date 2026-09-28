# Directory Knowledge panel navigation

Changed on 2026-09-28 to consolidate the scattered RAG controls.

- **Files** opens by default with selected-file readiness and refresh. Whole-directory indexing is a separate collapsed disclosure for MyAgent; mapping cleanup remains secondary.
- **Tables** contains local imports, table review, and a link to its settings.
- **Setup** is the single configuration destination. A settings-area selector shows connection/search, server status/readiness, models/embeddings, shared folders, extraction/indexing, server launch, or table settings. The duplicate MyAgent connection form was removed from this panel. Service-key generation remains available in the shared connection form.
- Server configuration areas share their draft. Hidden edits and active jobs have navigation notices; changing views does not cancel work. An unsaved connection disables server actions, and server work suspends connection editing. The search status says Enabled rather than implying that all selected files have verified indexes.
- The application-wide MyAgent settings page retains its full layout.

Verification:

- Seven focused test files: **44 tests passed**, including navigation, draft retention, a single connection form, action guards, connection suspension during readiness checks, and background refresh survival.
- Sidebar browser scenarios: **52 checks passed**, including individual server settings areas, draft recovery, selected-file checks, whole-directory disclosure, table review, keyboard/drawer behavior, and English/Arabic layouts at 300px. Screenshots: `.task/sidebar-review/knowledge-*.png`.
- MyAgent settings browser scenarios: **21 checks passed** for the full settings page, connection guards, extraction saves, readiness, and selected-file retry.
- Shell type check and production build passed. Existing import/chunk warnings remain.

Browser validation uses real renderer components with synthetic desktop bridges. It does not change the live MyAgent configuration or user files.

The subsequent [tool catalog and compact settings review](myagent-document-tool-catalog.md) records the live tool browser, collapsed help, and grouped extraction controls added after further feedback.
