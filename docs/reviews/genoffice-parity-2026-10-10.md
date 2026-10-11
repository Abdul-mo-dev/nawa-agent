# Nawa / GenOffice integration and defect review

Reviewed source: 10 October 2026. This report describes the source update prepared for `Abdul-mo-dev/nawa-agent`, its validation, and the remaining release and platform limits.

## Result

The fetched Nawa revision did not contain all of the current GenOffice changes. This update integrates the current upstream implementations of the six local office editors and their shared engines, then repairs the conflicts and defects identified in Nawa's desktop, directory-agent, local-knowledge, browser, CLI, updater and packaging paths.

The resulting tree has complete source coverage for the six local editors against the pinned upstream revision. This is a source-integration conclusion, supported by extensive automated checks. It is not a claim that every feature, cloud service, document variant or operating system has been exercised. A signed or Windows-tested installer was not produced.

The local review branch is `review/genoffice-parity-2026-10-10`. The update package records its exact target commit in `manifest.json`. GitHub access available during this review was read-only, so the remote `main` branch was not changed.

### Source baseline

| Source                 | Exact revision                             | Meaning                                                                  |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Nawa                   | `ded5bd48f88678cdaa9b6890f9702a87de553cb1` | Fetched user revision, “optimize for local models”                       |
| GenOffice              | `c8e9467c4101818e070644e1667bad48d4a2e1df` | Pinned upstream revision integrated by this update                       |
| Inferred fork baseline | `476e5023c9a4bc459ca6de7b1d697ab25d94850e` | Source comparison baseline; 3,155 original files had identical Git blobs |

The repositories have disjoint Git ancestry. The fork baseline was inferred from source identity rather than represented as a shared ancestor. An explicit-base merge identified 78 conflicts; those were resolved by combining the new upstream APIs with Nawa's existing workflows. The resulting review commit is based on the fetched Nawa revision. It does not rewrite either project's history.

The final source audit checked all 4,306 upstream paths under `apps/` and `packages/`. No editor or office-engine source path is missing. The six deliberate omissions are the shell's GitHub-star prompt implementation, component, stylesheet and test; the upstream GenOffice logo; and the shared GitHub menu helper. These are branding and promotional UI exclusions.

## Capability assessment

| Area                  | Integrated capability                                                                                                                                                              | Practical qualification                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docs                  | DOCX engine and rich editor; layout, pagination, styles, fields, tables, headers/footers, comments and revisions; document AI operations and conversion/export paths               | Compatibility is the implemented GenOffice scope. Unusual Word documents and OS printing still need representative acceptance files.                  |
| Sheets                | XLSX gateway, streaming workbook editor, formulas and native calculation sidecar, styles, charts, tables, validation and structural operations; CSV and legacy-format import paths | This does not claim every Excel feature or formula. Native tests ran on Linux; Windows native packaging and LibreOffice comparison remain unverified. |
| Slides                | PPTX engine, renderer and operation schemas; editable text/shapes/images, notes and layout handling; AI editing, deck construction and quality checks                              | Rendering and export depend on the installed runtime and fonts. Full visual fidelity across imported decks was not established.                       |
| PDF                   | PDF renderer/content editing, page operations, annotations and forms; conversion, signing and signature-verification paths                                                         | Signature integrity is distinct from certificate trust. Full PKI policy and revocation validation are not implemented.                                |
| Markdown              | Rich/source document editing, assets, diagram/math support, AI operations and Word/export integrations                                                                             | Browser asset and Save As behavior were repaired; browser-host export restrictions remain explicit.                                                   |
| HTML                  | Source/rich document workflows, assets, single-file export, AI and Word-conversion integration                                                                                     | Browser-dependent HTML-to-DOCX tests could not run without Chromium.                                                                                  |
| Shell and local files | Six-editor tabs, current help content, global file search, selected-file knowledge, approvals, settings and integrations                                                           | Nawa's directory workspace and current single Chat header are preserved. Removed cloud-project navigation was not reintroduced.                       |
| AI and providers      | Updated agent core, provider adapters, model catalog, cancellation and tool validation, continuation-aware budgets and vision policy                                               | Local/custom endpoints remain explicit. Provider accounts, paid services and model availability depend on the user's configuration.                   |
| CLI and MCP           | Document inspect/read/edit/create/convert operations, deck workflows, stdio and HTTP MCP, application launching                                                                    | Some exports launch Electron. Remote/cloud commands require the corresponding service and credentials.                                                |
| Browser host          | Local mounted-folder service and all six editor bundles, with scoped file and save operations                                                                                      | This is a constrained local editor host. It does not provide every desktop AI, settings, MCP, print/export, signing or OS integration.                |

Concrete upstream additions beyond the fetched Nawa editing core include:

- Docs: expanded font, paragraph, style, list and table dialogs; editable fields; multi-page navigation; autocorrect, go-to and paste-special tools.
- Sheets: full-workbook find, formula-argument UI, fill-series and paste-special, pivot-field editing, threaded comments, sheet protection, outlines and print pagination.
- Slides: redaction, bounded AI JSON/layout skeletons, visible-thumbnail optimization, notes drafts and print-window handling.
- PDF: form design/detection, PKCS#12 and certificate signing, signature inspection, system-certificate integration and image export.
- Markdown: a source/plain-text pane with find, source-preserving mode helpers, redaction, image-host configuration and image export.
- HTML: redaction guards, document skeleton and image-reference rewrite helpers, and print guarding.

The distinction between desktop and browser support is documented in `BROWSER-README.md` and `BROWSER-VALIDATION.md`. The source-only browser launcher handles supported UTF-8 text; the full browser build reuses the native editor services. The two modes are not interchangeable. Browser policy deliberately blocks desktop credentials/cloud AI, MCP automation, persistent global chat history, native print/conversion, OCR and certificate signing. Browser PDF also blocks extraction, merge, split, crop and insertion operations; those restrictions do not indicate absent desktop implementations.

## Repairs with the greatest impact

### Approved edits stay within their authorized scope

The upstream and Nawa save APIs had diverged. The integration preserves both the existing staged-save contract and the newer atomic-write helpers, with explicit exports so callers receive the expected implementation.

An editor opened to perform an approved staged operation can write only the exact approved output. Guards cover the six editors' save, export, signing, picker and late asynchronous write paths. Staged work cannot use a native picker to select an unrelated destination, create unrelated histories or recovery records, or mutate global settings, recents and persisted chat state. The Slides regression still writes a real valid staged PPTX while rejecting a redirected destination.

Ordinary Sheets CSV replacement now uses an atomic write instead of truncating the existing file before the replacement is complete. A newly opened blank workbook does not create a file before the user saves it.

### Search and knowledge respect folder access and current selections

Nawa's selected-file index and the new upstream global index had incompatible interfaces. They now have distinct modules and storage contracts. Folder watchers and index refreshes follow mount changes, and read permission is distinguished from write permission.

Global search filters authorized paths before ranking, fallback search and pagination. Knowledge retrieval applies the selected corpus before the result limit, so unrelated high-ranking files cannot crowd out the selected files. Access is checked again after extraction, and reranking only sends authorized material to a configured remote service. Revoking a folder invalidates its access rather than silently remounting it.

Knowledge Q&A now uses an immutable snapshot of the current corpus, file modification state, provider settings and per-chat model. Cancellation during preparation invalidates pending work; late completion from an old request cannot replace the current answer or leave the interface permanently busy. File metadata handles multi-dot filenames correctly. Analytics evidence invalidation is scoped to the source that changed, while evidence for independent copied sources is retained.

Search-provider credentials now use the protected AI settings store, including nested keys, instead of being retained as ordinary plaintext file-search configuration. The existing operating-system credential-protection behavior remains part of that store.

### Local models, provider state and retries remain consistent

Context trimming preserves the active user instruction, relevant tool receipts and current draft during continuation and correction retries. A new run can discard old opaque reasoning/signature state while preserving the state required by the active run. This prevents a size reduction from silently removing the evidence needed to repair the current document.

Provider and settings integration preserves local/custom policies, saved credentials, profile selection and revision checks. Legacy custom endpoints receive stable migration identifiers, fixing a first-save failure. Model-catalog refreshes retain policy metadata, and unblurred token-limit drafts are included when settings are saved. A redacted saved credential can be resolved only for the exact matching endpoint; edited URLs and ambiguous accounts are rejected.

Gemini response handling validates a complete signed turn before emitting tools and retains the required response ordering. Current model vision defaults, including MiniMax M3 support, are integrated; local/custom endpoints keep their explicit opt-in behavior. No implicit fallback to a Genspark provider was introduced.

The final MCP run exposed a separate proxy defect. Cloud preparation installed a plain global `ProxyAgent`, which ignored `NO_PROXY`; later local MCP and model requests could be routed through a remote proxy. The CLI, shell, standalone Sheets and standalone Slides now use `EnvHttpProxyAgent`, preserve user bypass entries, and always keep `localhost`, `127.0.0.1` and `[::1]` direct. Real HTTP tests cover uppercase and lowercase bypass variables, plus a GUI-like environment with neither variable set.

### Browser navigation and saving keep the right document identity

Delayed file or directory responses could outlive a navigation change and redirect a later save. The host and workspace now track the owning tab, mount and request generation. Switching mounts clears stale rows, and a late folder response cannot replace the current listing.

Read-only mount enforcement now also covers image/asset pickers. Save As adopts the new path and grants without renaming the original document's owned assets. Imported CSV/XLS data no longer leaks an internal XLSX working path or treats that path as a user-authorized destination. New spreadsheet filenames must match the actual output format; TSV routes to the intended source or import path.

A nested Docs save operation could deadlock while holding the host lock; it now uses the intended save boundary. The missing directory bridge export and a context-menu ownership issue were also repaired. File revision checks continue to reject stale writes, and path/link restrictions remain in force.

### Visible editor and launch defects

Docs pagination now reacts when a text watermark changes or is removed. PDF font lookup rejects asynchronous results from the previous document and clears document-specific caches, preventing a reused font identifier from applying stale font data to a newly opened PDF.

A Docs Vite subpath alias that produced `ENOTDIR` during a production build was corrected. A missing shell CSS closing brace was restored. The default Explorer entry exposes Search, Ask AI and User Guide routes while retaining Nawa's current Chat and Knowledge/Models workflow. Duplicate preload stream aliases, obsolete star-prompt wiring and unused UI state were removed.

CLI launching now recognizes Nawa executable names on Windows, macOS and Linux while retaining a GenOffice fallback. Arguments and exit statuses are preserved. The shell uses Nawa application identifiers and update-release defaults. The development profile uses a space-free name with a guarded migration from the prior directory, preserving the old location if migration cannot complete.

### Updates, native assets and source launchers

The update downloader now observes output-stream failures, aborts input on write failure and waits for write completion correctly. Regression coverage includes disk-full and open/finalization errors, partial downloads and recovery. The download fixture confirms actual bytes were written before simulating failure.

`Start-NawaShell.ps1` builds all six editors, the native spreadsheet sidecar, CLI and shell by default. Its skip-build path verifies the required outputs. Packaging guards check actual main/preload/renderer entries, native and CLI files, and the packaged Sharp version. The NSIS artifact name now matches the Windows installer script. Linux installation links use the Nawa installation directory.

Sharp's new package entry is resolved through its manifest rather than a hard-coded `lib/index.js` path. Real PNG, JPEG, WebP and GIF inputs exercise decoding, normalization, limits and malformed-input behavior, including the Transformers path. Only OS OCR is mocked in those tests.

The README no longer sends Nawa users to upstream installers as if they were Nawa builds, or claims a signed installer was produced. Inherited Flatpak, Nix and Docker definitions are explicitly described as consuming pinned upstream GenOffice binaries. The contributor instructions describe the actual Nawa repository workflow. The comment checker now includes new source files and handles deleted or moved tracked files without crashing before staging.

## Dependency security assessment

The initial audit reported 18 affected packages: 9 high and 9 moderate. After the targeted updates, the audit reports 15: 5 high and 10 moderate, with no critical findings. These are package counts, including affected ancestors of vulnerable dependencies; they are not counts of independent exploitable application defects.

Sharp is pinned to 0.35.5 and image-size to 2.0.3. The lockfile update was kept narrow: 28 changed version entries were in the Sharp, `@img` and image-size chain. The Transformers version remains 3.8.1. A clean dependency installation reproduced the intended versions, and `npm ls sharp image-size --all` verified resolution.

The review found that npm 11.9 could lose root overrides through workspace dependency edges. Exact root compatibility anchors for the existing Transformers and PptxGenJS versions make the relevant overrides effective. The reason is documented in `CONTRIBUTING.md`, with the upstream npm issue linked below. Broad unrelated package upgrades were not included.

| Remaining underlying finding | Observed path and treatment                                                                                                                                                                                                        | Status                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| node-forge                   | PDF ASN.1 parsing, PKCS#12 and signing remain users. Document and certificate signature verification use native Node/OpenSSL verification. A real malformed RSA DigestAlgorithm PDF regression is rejected by the production path. | No patched release available in the reviewed audit range; dependency finding remains open. |
| braces                       | Development chain through PDF `vite-plugin-static-copy` and chokidar. Reviewed use is configured build globs; no document-runtime path was identified.                                                                             | No available fix identified; remains reported.                                             |
| http-cache-semantics         | Electron/build-tool download caching. The advisory is disputed by the maintainer; comparison of 4.2.0 and 4.3.0 did not find the alleged max-stale behavior repaired.                                                              | Kept visible rather than using a version change that only clears an audit label.           |
| sprintf-js                   | Installer/download logging through global-agent and roarr in the Electron/ONNX toolchain. The reviewed runtime ONNX path does not import that installer chain.                                                                     | No patched release identified; remains reported.                                           |

The native PDF verification regression reduces the demonstrated signature-verification exposure; it does not make all uses of node-forge safe or close its package advisory. Certificate trust-root reachability is not full RFC 5280 purpose, policy and revocation validation. CRL/OCSP checking is not implemented.

### Existing license gate remains a release blocker

`npm run licenses` fails for 14 platform-specific Sharp/libvips packages carrying LGPL-3.0-or-later, sometimes as part of a composite license expression. Running the fetched Nawa lockfile through its original license checker also fails. The prior Sharp/libvips versions already carried the same license category.

The source update fixes the README's inaccurate claim that every runtime dependency is permissively licensed. It does not relax the repository's allowlist, falsify package metadata or suppress the CI gate. The distribution policy and the required treatment of these dependencies must be resolved before calling an installer release-ready. The delivered source update contains no installed third-party binaries.

## Validation

Checks ran on Linux with Node 24.19.0, npm 11.9.0 and Rust 1.90.0 for the native engine. The repository's supported source prerequisites remain Node 22.12 or later and npm 10 or later; Windows builds additionally require the Rust MSVC toolchain and Microsoft C++ build tools. A clean install succeeded with the Linux optional CUDA download disabled for this environment.

The table gives one full workspace run per package. Later focused regressions are listed separately and must not be added again as unique full-suite tests. The complete `npm test` chain is not described as green: HTML-to-DOCX has two browser setup failures, and the CLI/shell runs explicitly exclude socket tests prohibited by this environment.

| Workspace      | Passed | Skipped / blocked                                                                |
| -------------- | -----: | -------------------------------------------------------------------------------- |
| i18n           |     26 | 0                                                                                |
| electron-utils |    267 | 0                                                                                |
| font-metrics   |     25 | 0                                                                                |
| zip-gate       |      9 | 0                                                                                |
| docx-engine    |  1,708 | 1                                                                                |
| pdf2docx       |    815 | 7                                                                                |
| html2docx      |     41 | 69 tests blocked by two missing-Chromium setup failures                          |
| file-parse     |    132 | 0                                                                                |
| pptx-engine    |  1,236 | 17                                                                               |
| xlsx-gateway   |    248 | 0                                                                                |
| pptx-ops       |     68 | 0                                                                                |
| pptx-render    |    386 | 0                                                                                |
| pipelines      |     77 | 0                                                                                |
| ai-search      |    181 | 0                                                                                |
| agent-core     |    186 | 0                                                                                |
| ai-provider    |    488 | 1 optional integration                                                           |
| project-store  |    119 | 2                                                                                |
| CLI            |    435 | 3 unsupported Unix-socket cases excluded; 2 opt-in Electron export tests skipped |
| UI             |    160 | 0                                                                                |
| Docs           |  3,459 | 0                                                                                |
| Sheets         |  3,369 | 1 LibreOffice-dependent case                                                     |
| Shell          |  1,167 | 5, including the unsupported Unix endpoint pattern                               |
| Slides         |  1,414 | 14                                                                               |
| PDF            |    936 | 2                                                                                |
| Markdown       |  1,085 | 0                                                                                |
| HTML           |    325 | 0                                                                                |

Additional evidence includes 244 native Rust tests, 33 browser filesystem/host/navigation tests, 18 guarded-updater tests, 34 Nawa workspace tests, 108 analytics tests, 30 RAG tests and the workspace/inspector structural checks. Focused editor, model/settings, stage-save, proxy, image-decoding, updater and packaging regressions were rerun after the corresponding late fixes. The PDF malformed-signature suite passed 17 tests; cloud/proxy/MCP passed 27; the image/updater/packaging group passed 52. These overlap full suites.

All workspace TypeScript checks pass. Lint has zero errors and 22 warnings; the hook warnings were inspected, and the concrete stale-watermark and stale-font defects were repaired. The remaining warnings were not automatically suppressed or “fixed” by introducing unstable dependencies. Theme and workspace-boundary checks pass; the boundary check covers 505 package source files. The help check confirms all 18 topics in all 21 languages, and the skill-version and English-comment checks pass. Formatting and final whitespace/conflict checks are recorded in the package validation summary.

The six editor production bundles, CLI and shell were built, along with the native spreadsheet release binary. The browser host and all six browser editor bundles also built. The package validation summary contains the final build command results and log paths. A successful compile does not establish packaged OS behavior or document fidelity.

### Remaining execution limits

- Windows launchers, the updater wrappers, NTFS reparse handling, installer construction/signing and the complete desktop/browser integration were not executed on Windows. macOS packaging and signing were not executed either.
- Chromium downloads did not produce a usable browser in this environment. HTML-to-DOCX browser tests, visual browser acceptance, and the existing MyAgent/sidebar browser review scripts remain unverified.
- The environment rejects Unix-domain socket listeners with `EPERM`. Three CLI control cases and the shell endpoint pattern remain enabled in source but were explicitly excluded from their final local commands. Real HTTP loopback/proxy regressions passed.
- LibreOffice comparison, optional real-Electron exports, live provider accounts, external service integrations, OS OCR, system fonts and large/unusual document acceptance require the corresponding runtime or representative data.
- The separate Rust dependency-license gate and a complete installer release pipeline were not executed. The known JavaScript license gate already prevents an unqualified CI/release-ready claim.

## Applying the delivered source update

Extract the update archive to a directory outside your existing checkout. Use the supplied `START-HERE.md` for the exact package contents and validation result. Close Nawa and other tools writing to the checkout before applying.

From the extracted update directory on Windows:

```bat
apply-update.cmd --check --repo "C:\Projects\nawa-agent"
apply-update.cmd --apply --repo "C:\Projects\nawa-agent"
```

The first command is read-only. The second performs a complete preflight before writing, rejects unexpected source changes or untracked collisions, and records backups of exact original bytes and modes. The installer requires Node and Git. It does not install dependencies, change Git's index/history, push commits, reset files or launch Nawa. A source difference that cannot be reconciled is reported; there is no force option.

After a successful apply, run from the updated repository:

```powershell
npm ci
.\Start-NawaShell.ps1
```

Run `npm ci` explicitly even if `node_modules` already exists: the dependency tree must match the new lockfile. The launcher performs the normal build before opening the desktop shell. If PowerShell script policy prevents that launcher, use the repository's documented command-line build and launch route; the updater wrappers do not change execution policy.

Successful application prints the exact transaction journal path. The documented rollback command restores original source bytes, including original CRLF endings, and POSIX executable bits. Rollback refuses to overwrite newer user edits. Backups should be retained until the updated source has been checked in the user's actual environment.

The updater requires an ordinary local filesystem supporting hard links and atomic rename. It guards against symlinks, junctions, protected paths, malformed manifests and case/path collisions. It cannot lock arbitrary external editors at the operating-system level. The package's final full-payload validation is recorded separately from the 18 isolated installer fixtures.

## Evidence and references

The delivered archive includes this report, `manifest.json`, the exact changed source payload, a machine-readable validation summary, selected validation logs and the initial/final dependency audits. The manifest binds every changed path to its expected before/after SHA-256 hashes and modes. Its base and target commit identifiers provide the source reference for the update.

Repository evidence is in the six editor workspaces, `packages/agent-core`, `packages/ai-provider`, `packages/cli`, `packages/electron-utils`, shell directory/index/RAG modules, browser policy/host tests and the source launch/packaging scripts. Test logs are included to distinguish executed checks from the acceptance work that remains.

Primary external references used for the dependency review:

- [Nawa source](https://github.com/Abdul-mo-dev/nawa-agent/tree/ded5bd48f88678cdaa9b6890f9702a87de553cb1)
- [GenOffice source](https://github.com/genspark-ai/genoffice/tree/c8e9467c4101818e070644e1667bad48d4a2e1df)
- [Sharp advisory GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
- [image-size advisory GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)
- [node-forge advisory GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
- [braces advisory GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
- [http-cache-semantics advisory GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
- [http-cache-semantics maintainer response, issue 56](https://github.com/kornelski/http-cache-semantics/issues/56)
- [sprintf-js advisory GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
- [npm workspace override issue 9659](https://github.com/npm/cli/issues/9659)
