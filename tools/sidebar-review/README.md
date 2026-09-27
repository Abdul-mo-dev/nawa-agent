# Sidebar regression checks

Run from the repository root:

```sh
node tools/sidebar-review/test.mjs
```

Requires the installed workspace dependencies and Playwright Chromium. This starts an isolated Vite server, renders the real sidebar, chat, settings, history and table-review components, runs browser interaction/layout assertions, then closes the browser and server. It uses synthetic desktop API responses; it does not read user files, write application settings, or call model providers.

Screenshots are written to `.task/sidebar-review/`. The checks cover narrow and wide panels, a short-window drawer, English/light and Arabic/dark, keyboard focus, history recovery controls, settings errors/discard, preservation of drafts, background status, table-review discard and stale-source rejection.

This is renderer regression coverage. Electron IPC and worker behavior are covered by the shell tests; live model/embedding services and assistive technology still require separate integration/manual checks.
