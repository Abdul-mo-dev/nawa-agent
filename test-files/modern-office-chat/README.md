# Modern Office folder-chat test files

`sample.dotx`, `sample.xltx`, `sample.ppsx`, and `sample.potx` are genuine OOXML
packages with their respective template or slide-show main content types. They
are derived from authored document, workbook, and presentation samples already
in `test-files`. The document and presentation include media; the presentation
also includes a chart and three slides. `manifest.json` records their hashes.

Regenerate with `node test-files/modern-office-chat/generate.mjs`. Then build the
shell and run `node test-files/modern-office-chat/chat-smoke.mjs` to exercise
native folder-chat inspection, edit, review, saved copy, and reopen. The desktop
test invokes native chat tools without calling an external model.
