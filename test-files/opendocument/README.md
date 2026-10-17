# OpenDocument fixtures

Generate genuine ODT and ODP packages with `node test-files/opendocument/generate.mjs` (requires LibreOffice). The rich DOCX/PPTX sources in `../legacy-office/source/` contain multilingual text, tables, images, links, slide notes and a chart. The manifest records input provenance and hashes.

Run `node test-files/opendocument/chat-smoke.mjs` after building Docs, Slides and Shell. It launches a separate Electron profile, inspects each original through the chat tools, edits a converted copy, verifies the before/after review, commits a DOCX/PPTX sibling and confirms original hashes. It does not call a model provider.

Run `node test-files/opendocument/ui-smoke.mjs` to check editor opening, import notices, source-save refusal and modern Save As through real Electron IPC.

ODT/ODP import requires LibreOffice at runtime. Conversion may change layout or animations and does not retain macros. Encrypted packages are rejected. Native ODT/ODP export is not supported.
