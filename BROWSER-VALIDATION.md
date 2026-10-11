# Browser refactor validation

## Result and limitations

**Review update, 2026-10-10: 25 dependency-free Node tests and 8 browser bridge/navigation regression tests passed.** The native host and all six rich-editor renderer bundles built successfully on Linux. Windows launch, installation and complete rich-editor save/reopen workflows remain unverified in this environment.

The review used a Linux filesystem with the repository's npm dependencies installed. Linux is not a runtime requirement of the Windows launchers. Chromium was unavailable; standard Playwright Chromium and headless-shell installation attempts both returned invalid download archives. The real-browser networking test could not run. The DOM race regressions use JSDOM, and native-host tests use mock Electron/editor handlers with a real mounted Workspace.

## Executed checks

| Check                                        | Result                 | Scope                                                                                           |
| -------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `node tools/browser/test.mjs`                | 25 passed              | Actual Node HTTP service and filesystem operations                                              |
| `npm run test:native -w @genoffice/browser`  | 8 passed               | NativeHost with real Workspace and mocked editor handlers; actual workspace JavaScript in JSDOM |
| `npm run build -w @genoffice/browser`        | Passed                 | Bundled native host and empty identity preload                                                  |
| `node tools/browser/build-editors.mjs`       | Passed                 | Docs, Sheets, Slides, PDF, Markdown and HTML browser renderer/preload bundles                   |
| Real-browser loopback navigation regression  | Not run                | No installed Chromium; browser downloads returned invalid archives                              |
| Windows execution and C++/Rust sidecar build | Not run                | No Windows runtime in review environment                                                        |
| Windows CI workflow                          | Supplied, not run here | Must be run in the repository                                                                   |

### Automated core coverage

Mount persistence, missing roots, Windows names and path traversal; file/folder creation, listing and reads; revision-checked replacement; duplicate creation and concurrent writers; overlapping mounts sharing a file lock; UTF-8/BOM/CRLF decoding; binary and size rejection; readonly mounts, including Markdown/HTML asset pickers; symlink/junction/hardlink boundaries; lock recovery after errors; authentication, Host, Origin and CSRF validation; safe attachment download; binary wire encoding and malformed payload rejection; scoped/blocked RPC channels and unsafe names/paths; direct automation-save restrictions; tab ownership/resource revocation; multiplexed SSE and event replay; CSV/TSV/XLS routing without mislabeled XLSX creation.

**The native-relay API tests use a fake engine.** They validate the transport contract and authorization, not actual DOCX/XLSX/PPTX/PDF editing.

### Native-host and DOM regression coverage

The native-host regressions verify Markdown/HTML Save As preserves the source and updates native reload/image identity; CSV/TSV/XLS imports retain the mounted source identity while native Sheets uses temporary XLSX sessions; save results update the correct target; and a Docs replacement confirmation can await a nested Save without a tab-lock deadlock.

The DOM tests run the actual `workspace.js` and markup against delayed API responses. They verify that a mount switch during a file read does not redirect its later Save; stale file rows are cleared during navigation; and a late folder response cannot replace the current folder listing. These are deterministic logic regressions, not browser networking, cookie, CSP or visual checks.

A separate reproducible Playwright test at `apps/browser/e2e/workspace.spec.mjs` uses actual browser navigation to the service, including token removal, cookies, refresh/persistent-mount behavior and unsaved-change prompts. It was written and syntax-checked but could not be executed here.

## Required Windows acceptance checks

Use a new test directory on a local NTFS volume and copies of real documents. First run `setup-windows.cmd`, then the browser regression command in `BROWSER-README.md`. Launch the full service with a mounted test directory and verify the following manually before trusting native saves:

| Area                          | Required verification                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launcher                      | Build succeeds with Node/npm/Rust MSVC; service starts without a visible editor window; default browser connects; Ctrl+C exits cleanly                                |
| Directory access              | Paths with spaces/non-ASCII characters, nested folders, persisted mounts, folder picker, readonly/locked files, junction rejection                                    |
| DOCX                          | Open an existing file with text/table/image; edit; Save; close/reopen; new DOCX; Save As; external-change conflict                                                    |
| XLSX / XLSM / CSV / TSV / XLS | Sidecar starts/exits; edit cell/formula/style; Save and reopen; new XLSX; Save As; macro-enabled file round-trip; CSV identity retained; TSV/XLS imports save as XLSX |
| PPTX                          | Open, edit slide text/shape, Save/reopen, create a blank deck, Save As, conflict behavior                                                                             |
| PDF                           | Open/annotate/form edit, Save/reopen; Save As writes a copy and retains source state; external source change prevents stale saving                                    |
| Markdown                      | Rich text/source load, edit/save/reopen, existing local images, same-folder Save As                                                                                   |
| HTML                          | Source edit, preview refresh, relative images/styles, save/reopen; preview cannot access authenticated filesystem API                                                 |
| Multiple tabs                 | More than six editor tabs without RPC starvation; independent sessions; dirty-close prompts; one tab's save cannot alter another's file                               |
| Failure handling              | Stop/restart service, expire a session, cancel a file picker, remove a mount directory, exceed limits; retain unsaved browser content on failed saves                 |

Rich-editor limitations are documented in the README. In particular, print/export/AI/automation/desktop-only commands are intentionally restricted rather than silently emulated.

## Remaining engineering risks

Original native handlers are reused. Their hidden-view lifecycle, WASM assets, native dialogs and full rich-editor feature coverage still need Windows execution even though the bundles build. New-path native saves are not all implemented by the same no-clobber transaction as the source writer. Filesystem revision checks reduce accidental overwrites but cannot make unrelated OS writers participate in the process's lock. These tests do not establish performance or fidelity for large or unusual office documents.

The browser policy deliberately restricts desktop-only capabilities. Passing these core tests does not establish complete desktop feature parity or suitability as a public server.
