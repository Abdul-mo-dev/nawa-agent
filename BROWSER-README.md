# Nawa Browser — local Windows server/client refactor

This adds `apps/browser` to the supplied Nawa project. A local service owns filesystem access and editing-engine sessions; the user works in a normal browser. Files are read from and saved to mounted directories on the service computer. Docker, WSL and a Linux runtime are not part of either Windows launch path.

**Delivery status:** the dependency-free filesystem service and source-editor workflows have been tested. The original rich editors have been connected to an Electron-backed service, but that complete integration has **not** been built or executed on Windows in the authoring environment. This is source code, not a verified Windows installer. Read `BROWSER-VALIDATION.md` before using important documents; start with copies.

## Apply the refactor

Extract the original uploaded project first. Copy the contents of the refactor overlay ZIP into its `genoffice-main` directory, alongside the existing `package.json`. Replace matching files. Do not put the overlay inside another nested project directory.

The overlay contains new and changed source files only. Keep the original `apps`, `packages`, assets and licenses. Existing font assets are not redistributed in this overlay. The original desktop launch/build scripts are preserved.

## Quick start: no npm install, no Rust, no Electron

This mode is available immediately with **Node.js 22.12 or newer**:

```cmd
cd /d C:\Projects\genoffice-main
node apps\browser\server\start.mjs --mount "C:\Users\You\Documents"
```

Alternatively, double-click **Start Nawa Source Only.cmd**. Open the complete connection URL printed in its console. Keep the console open; Ctrl+C stops the service.

In the browser, choose **Mount folder**, enter an absolute Windows directory, then click a file. Use **New** to create a file or folder. **Save / Ctrl+S** writes back to the original file. **Save As** creates a new file within the same mount. **Files** returns to directory browsing without closing editor tabs.

This mode edits UTF-8 text, Markdown source, HTML source, CSV source, JSON and other UTF-8 text files. It does **not** provide rich DOCX/XLSX/PPTX/PDF editing. Binary files are never decoded and rewritten as text. The separate `genoffice-browser-source-only.zip` includes this same mode as a self-contained source package; it still requires Node, but not the original monorepo or any npm packages.

## Full Nawa editor integration: Windows build

For a source build, install Node.js (the existing project requires at least 22.12), npm 10 or newer, Rust with its Windows MSVC toolchain, and Microsoft C++ Build Tools with the **Desktop development with C++** workload. Rust/C++ are needed to build the project's existing spreadsheet helper; they are not browser-client dependencies. Initial dependency installation requires internet access.

Open a new Windows terminal after installing the tools. Double-click **setup-windows.cmd**, or run these commands from the project root:

```cmd
node tools\browser\check-prerequisites.mjs
npm ci
npm run browser:test
npm run browser:build
```

Then launch:

```cmd
"Start Nawa.cmd" --mount "C:\Users\You\Documents"
```

The full launcher starts the local service and opens the default browser. It does not open the old Electron editor window. Its console prints a private connection URL. After connecting, the browser removes the launch token from its address bar.

**Electron is intentionally retained on the server side.** The supplied editing engines depend on Electron main-process services and the spreadsheet sidecar. Reusing these behind a browser transport avoids replacing Nawa with a text-only mock. This is a server/client separation, not a complete removal of Electron from the project.

There is no prebuilt `.exe` or MSI in this delivery. The supplied Windows workflow can check installation, builds and source-editor browser tests when run in your repository; it has not been executed here.

### Options

Both services accept `--port`, `--state-dir` and `--mount`. The full service also accepts `--no-open` to avoid opening a browser automatically. `GENOFFICE_BROWSER_PORT` and `GENOFFICE_BROWSER_STATE` provide environment-variable defaults. Example:

```cmd
"Start Nawa.cmd" --port 3211 --state-dir "C:\GenOfficeData" --mount "D:\Work"
```

The default port is 3210. Binding is deliberately restricted to `127.0.0.1`; there is no `--host 0.0.0.0` option. Mounts are remembered under `%LOCALAPPDATA%\GenOfficeBrowser\mounts.json`; native editor preferences/recovery are kept separately under its `engine` subdirectory. Removed or disconnected mount roots are skipped on startup. Unsaved browser buffers and open tabs do not survive a service restart.

## What is implemented

The workspace has persistent mounts, directory navigation and filtering, multiple editor tabs, new files and folders, Save, Save As, Reload, download of the last saved version, keyboard shortcuts and unsaved-change warnings. Mounting grants access to the chosen directory and ordinary subdirectories; it is not an upload or a browser File System Access API permission.

The source editor retains UTF-8 BOM and CRLF information. Mixed line endings are identified and normalized to LF on save. Non-UTF-8 and NUL-containing binary input is rejected. The source-editor limit is 8 MiB; the general file limit is 64 MiB. Directory listings are capped at 20,000 entries. The native service allows up to 12 editor tabs per connection session.

The full build compiles the existing Docs, Sheets, Slides, PDF, Markdown and HTML React renderers for the browser. Original preload API calls travel over reviewed HTTP RPC channels, and editor events share one multiplexed server-sent-event connection. Native open/save dialogs are replaced with pickers restricted to the tab's mounted folder. Native new-document creation uses the original package generators rather than empty placeholder files.

| Format           | Source-only mode     | Full service integration supplied                                  |
| ---------------- | -------------------- | ------------------------------------------------------------------ |
| DOCX             | No binary editing    | Original Docs editor                                               |
| XLSX / XLSM      | No binary editing    | Original Sheets editor and Windows sidecar; new workbooks are XLSX |
| PPTX             | No binary editing    | Original Slides editor                                             |
| PDF              | No binary editing    | Original PDF editor, with restrictions below                       |
| Markdown / HTML  | UTF-8 source editing | Original rich editor plus explicit Source action                   |
| CSV              | UTF-8 source editing | Original Sheets editor or explicit Source action                   |
| Other UTF-8 text | Source editing       | Source editing                                                     |

The last column describes the code integration, **not an end-to-end validation claim**.

## Save behavior and boundaries

Source saves carry a SHA-256 revision. A stale revision returns a conflict instead of silently overwriting an external edit. Browser changes remain available for copying or Save As. The service serializes writes to the same physical path, including overlapping mounts. Source writes use a flushed temporary sibling file, then a rename for replacement or no-clobber hard-link creation for new files. This creation strategy expects a filesystem with hard-link support: use ordinary local NTFS folders on Windows. FAT/exFAT, network shares, cloud placeholders and unusual reparse points have not been validated.

Native saves have an additional source-revision guard and reuse each original engine's save implementation. They are not all the same transaction as the dependency-free source writer. Snapshot-based DOCX/PPTX/XLSX Save As can recover to a new picker-selected filename after a source conflict. External processes are outside the service's locks; this is not an OS-level adversarial filesystem sandbox or a replacement for backups.

PDF Save As retains the original editor's **save-a-copy** semantics: the source stays open and pending edits are not marked clean merely because a copy was written. The PDF engine reads the source bytes when saving, so an externally modified PDF must be reloaded before either Save or Save As. Preserve any unsaved text separately first. Rich Markdown/HTML Save As is restricted to the same directory to preserve relative asset links; use Source mode for a different folder. Source mode does not copy referenced assets either.

Save As requires a new name. There is no force-overwrite switch in the browser picker. Delete, move and rename operations were not added. Unmounting never deletes files; close that mount's editor tabs first.

## Features deliberately restricted in browser mode

The local bridge blocks AI/cloud account access, MCP/OS automation, screen capture, native clipboard operations, external-app launching, font installation/downloads, print/export flows, presenter windows, image-to-disk helpers and PDF structural/signature/redaction-copy actions. Basic editing and file operations do not need an AI account. Some existing editor controls remain visible but return an unavailable-in-browser-mode error. This build does not promise complete desktop feature parity, password-dialog parity or office-format fidelity beyond the original engines.

Authored HTML previews use an opaque sandbox and read-only resource capabilities, not a raw static mount. They are not allowed to call the authenticated filesystem API. Existing relative assets can be read only through scoped routes. No directory is publicly served as a website. Do not use this as a production hosting service for untrusted HTML.

## Local security model

Only the loopback service has disk access. Connection requires a random launch token; mutations additionally require a CSRF token. Session cookies are HttpOnly and SameSite=Strict. Host and Origin headers are checked. Absolute paths, traversal, alternate-stream syntax and Windows reserved names are rejected in mount-relative operations. Descendant symbolic links, junctions and hard-linked files are rejected. A selected mount root is canonicalized once, and operations verify its boundary again.

Treat the launch URL as a password: do not share it, place the service behind a public reverse proxy, or mount your whole drive unnecessarily. This is for one trusted Windows user on one computer, not a shared server, authentication platform, collaboration service or isolation boundary against another hostile local process. Use a dedicated state directory when testing another service instance. Sessions expire after 24 hours or a service restart; keep copies of unsaved work before reconnecting.

## Code map and tests

`apps/browser/server` contains the dependency-free HTTP, mount/filesystem, validation and binary transport code. `public` is the browser workspace. `src/main` hosts the original engines; `src/client` adapts original preloads to browser HTTP/events. `tools/browser/build-editors.mjs` builds all six renderer bundles. Existing engine modifications are limited to scoped default-save-folder injection, disabling the Electron-only DOCX lazy-media protocol in browser mode, and Markdown local-image URL adaptation.

Run core tests without installing dependencies:

```cmd
node tools\browser\test.mjs
```

After installing the original npm dependencies, run the real-browser regression:

```cmd
npx playwright install chromium
npm run browser:test:ui
```

`BROWSER-VALIDATION.md` records exactly what was executed and what still needs Windows verification. The new Windows CI workflow does not replace manual rich-editor save/reopen checks.

## Troubleshooting

A missing editor-build error means `npm run browser:build` has not completed. A missing spreadsheet helper requires rebuilding `@genoffice/sheets` with the MSVC Rust/C++ tools. A busy port can be resolved with `--port 3211`. Access-denied or locked-file errors require checking Windows permissions or closing the other application; do not run as Administrator simply to bypass folder permissions. On an interrupted connection, keep browser buffers open and copy unsaved content before restarting the service. A conflict is a deliberate stop, not a successful save.
