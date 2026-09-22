# Browser refactor validation

## Result and limitations

**22 dependency-free Node tests passed; 0 failed.** Source-editor DOM integration checks also passed using the real HTTP API through a test-only transport. The complete Electron service, six rich-editor bundles and Windows launch/build path were **not** executed in this environment. There is no compiled or certified Windows executable in the delivery.

The authoring environment had Node 22.16.0 and a Linux filesystem. That was used to validate portable code; Linux is not a runtime requirement of the Windows launchers. npm dependency downloads were unavailable. A system Chromium binary could render local test markup, but managed browser policy blocked navigation with `ERR_BLOCKED_BY_ADMINISTRATOR`, including loopback navigation. No browser policy was changed.

## Executed checks

| Check | Result | Scope |
| --- | --- | --- |
| `node tools/browser/test.mjs` | 22 passed | Actual Node HTTP service and filesystem operations |
| UTF-8 source-editor DOM workflows | Passed | Actual Chromium DOM + real Node API, with a test-only fetch adapter |
| JavaScript module syntax | Passed | New `.mjs`/`.js` modules checked using Node |
| TypeScript syntax/transpile | Passed | New/changed TypeScript only, using installed TypeScript; not a semantic typecheck |
| Offline npm lockfile validation | Passed | `npm install --package-lock-only --ignore-scripts --offline`; not dependency installation or a security audit |
| Full `npm ci` and renderer/main builds | Not run | Required packages were unavailable |
| Real-browser loopback navigation regression | Not run | Managed Chromium blocked navigation; a runnable Playwright test is supplied |
| Windows execution, C++/Rust sidecar build | Not run | No Windows runtime in authoring environment |
| Original full repository tests/typecheck/lint | Not run | Requires unavailable project dependencies |
| Windows CI workflow | Supplied, not run | Must be run in your repository |

### The 22 automated core tests cover

Mount persistence, missing roots, Windows names and path traversal; file/folder creation, listing and reads; revision-checked replacement; duplicate creation and concurrent writers; overlapping mounts sharing a file lock; UTF-8/BOM/CRLF decoding; binary and size rejection; readonly mounts; symlink/junction/hardlink boundaries; lock recovery after errors; authentication, Host, Origin and CSRF validation; safe attachment download; binary wire encoding and malformed payload rejection; scoped/blocked RPC channels and unsafe names/paths; direct automation-save restrictions; tab ownership/resource revocation; multiplexed SSE and event replay.

**The native-relay API tests use a fake engine.** They validate the transport contract and authorization, not actual DOCX/XLSX/PPTX/PDF editing.

### Executed browser DOM checks

The existing browser workspace HTML/CSS/JavaScript was rendered in system Chromium. A test-only JavaScript fetch adapter forwarded requests to the actual running Node server through Python HTTP; the session was established by the harness. This checks UI behavior and disk persistence, but not browser networking, authentication-cookie behavior or CSP enforcement.

Verified operations: mount and open; edit and save to disk; preserve BOM and Windows CRLF; reject an external-write conflict while retaining both copies; Save As to a new file; create/edit/save Markdown using Ctrl+S; create a subfolder. There were no uncaught page JavaScript errors. The supplied screenshot is from this source-editor DOM harness, **not a Windows screenshot or a rich-office-editor test**.

A separate reproducible Playwright test at `apps/browser/e2e/workspace.spec.mjs` uses actual browser navigation to the service, including token removal, cookies, refresh/persistent-mount behavior and unsaved-change prompts. It was written and syntax-checked but could not be executed here.

## Required Windows acceptance checks

Use a new test directory on a local NTFS volume and copies of real documents. First run `setup-windows.cmd`, then the browser regression command in `BROWSER-README.md`. Launch the full service with a mounted test directory and verify the following manually before trusting native saves:

| Area | Required verification |
| --- | --- |
| Launcher | Build succeeds with Node/npm/Rust MSVC; service starts without a visible editor window; default browser connects; Ctrl+C exits cleanly |
| Directory access | Paths with spaces/non-ASCII characters, nested folders, persisted mounts, folder picker, readonly/locked files, junction rejection |
| DOCX | Open an existing file with text/table/image; edit; Save; close/reopen; new DOCX; Save As; external-change conflict |
| XLSX / XLSM / CSV | Sidecar starts/exits; edit cell/formula/style; Save and reopen; new XLSX; Save As; existing macro-enabled file round-trip; CSV source fallback |
| PPTX | Open, edit slide text/shape, Save/reopen, create a blank deck, Save As, conflict behavior |
| PDF | Open/annotate/form edit, Save/reopen; Save As writes a copy and retains source state; external source change prevents stale saving |
| Markdown | Rich text/source load, edit/save/reopen, existing local images, same-folder Save As |
| HTML | Source edit, preview refresh, relative images/styles, save/reopen; preview cannot access authenticated filesystem API |
| Multiple tabs | More than six editor tabs without RPC starvation; independent sessions; dirty-close prompts; one tab's save cannot alter another's file |
| Failure handling | Stop/restart service, expire a session, cancel a file picker, remove a mount directory, exceed limits; retain unsaved browser content on failed saves |

Rich-editor limitations are documented in the README. In particular, print/export/AI/automation/desktop-only commands are intentionally restricted rather than silently emulated.

## Remaining engineering risks

Original native handlers are reused. Their hidden-view lifecycle, WASM assets, native dialogs and full rich-editor feature coverage need actual build and Windows execution. New-path native saves are not all implemented by the same no-clobber transaction as the source writer. Filesystem revision checks reduce accidental overwrites but cannot make unrelated OS writers participate in the process's lock. Renderer sanitization and original parsing engines have not received a new security audit. No performance/fidelity claims are made for large or unusual office documents.

The overlay is intentionally small and leaves original desktop code intact wherever possible, but the original desktop suite should still be regression-tested after applying it. Do not distribute a public server or advertise complete office compatibility based only on these core tests.
