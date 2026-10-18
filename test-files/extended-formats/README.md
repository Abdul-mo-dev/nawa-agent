# Text, image, RTF and email fixtures

Run `node test-files/extended-formats/generate.mjs` to regenerate the authored
fixtures. The MSG is a real Compound File message containing Unicode MAPI streams;
it is a minimal fixture, not an export from Outlook. No external downloads are used.

`sample.mjs` contains a UTF-8 BOM and CRLF line endings. Source edits must retain
both. The image fixtures contain the words `NAWA OCR TEST`; TIFF is normalized to
PNG for viewing. RTF import requires an installed LibreOffice and saves a DOCX
copy. EML and MSG are previewed as inert text, including their headers and
attachment inventory. Encrypted/RTF-only MSG bodies are reported as unavailable.

After building the shell, run:

```
npx playwright test --config e2e/playwright.config.ts e2e/extended-formats.spec.ts
```

These scenarios exercise real Electron previews, native inspection, staged source
edits, before/after review, save, backup and reopen. They invoke assistant tools
directly and use a scripted local model endpoint for the complete chat and approval
flow. No external AI service is contacted. Unit coverage also checks UTF-16 source
preservation, rejected stale revisions, invalid JSON, inert HTML email and
embedded MSG isolation.
