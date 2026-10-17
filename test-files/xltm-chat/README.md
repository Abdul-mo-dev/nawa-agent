# XLTM folder-chat test file

`sample.xltm` is a macro-enabled Excel template derived from the authored
`test-files/xlsm-chat/sample.xlsm`. It contains worksheet data, formulas, the
template main-part content type, a VBA relationship and an opaque
`xl/vbaProject.bin` preservation sentinel. The sentinel is not an executable
macro. `manifest.json` records the template and VBA hashes.

Regenerate with `node test-files/xltm-chat/generate.mjs`. Build Sheets and the
shell, then run `node test-files/xltm-chat/chat-smoke.mjs` to exercise desktop
folder-chat inspection, validation, editing, review, sibling `.xlsm` save and
reopen. Run `node test-files/xltm-chat/ui-smoke.mjs` to test interactive Save As
to both `.xltm` and `.xlsm`. The source template must remain unchanged. No macro
is executed or external model called.
