# XLSM folder-chat test file

`sample.xlsm` is a macro-enabled OOXML workbook derived from the authored
`test-files/spreadsheet-chat/source/binary.xlsx` sample. It has worksheet data,
formulas, the macro-enabled workbook content type, a VBA relationship and an
opaque deterministic `xl/vbaProject.bin` part. The VBA part is a preservation
sentinel, not an executable macro. `manifest.json` records its hashes.

Regenerate with `node test-files/xlsm-chat/generate.mjs`. Build the shell and run
`node test-files/xlsm-chat/chat-smoke.mjs` to test native folder-chat inspection,
validation, editing, review, in-place save, backup, and reopen. The test checks
that the VBA bytes, relationship and content type survive. No macro is executed
and no external model is called.
