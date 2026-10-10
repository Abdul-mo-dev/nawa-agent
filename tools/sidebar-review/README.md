# Sidebar regression checks

Run from the repository root:

```sh
node tools/sidebar-review/test.mjs
node tools/sidebar-review/file-status-test.mjs
```

Requires the installed workspace dependencies and Playwright Chromium. This starts an isolated Vite server, renders the real sidebar, chat, settings, history and table-review components, runs browser interaction/layout assertions, then closes the browser and server. It uses synthetic desktop API responses; it does not read user files, write application settings, or call model providers.

Screenshots are written to `.task/sidebar-review/`. The checks cover chat header action placement, the direct Index action calling embeddings and table preparation for the same selected scope, the chat gear opening main Settings on Knowledge, llama.cpp model selection, collapsed advanced controls, narrow windows and drawers, English/light and Arabic/dark, focus restoration, history recovery, settings errors/discard, preservation of drafts, model save conflicts, and table review from the file panel.

This is renderer regression coverage. Electron IPC and worker behavior are covered by the shell tests; live model/embedding services and assistive technology still require separate integration/manual checks.

The file status checks render the main Explorer table alongside chat and verify search/analysis icons, queued files, measured embedding progress, hover and focus details, the simplified chat, optional settings, and narrow layouts. Screenshots are written to `.task/file-status-review/`.
