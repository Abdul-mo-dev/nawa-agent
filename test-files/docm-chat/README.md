# DOCM folder-chat test file

`sample.docm` is a macro-enabled Word package derived from the authored
`test-files/modern-office-chat/sample.dotx`. It contains document content, a
macro-enabled main-part type, a VBA relationship, and an opaque deterministic
`word/vbaProject.bin` preservation sentinel. The sentinel is not an executable
macro. `manifest.json` records the package and VBA hashes.

Regenerate with `node test-files/docm-chat/generate.mjs`. Folder-chat
in-place inspection, validation, editing, review, save and backup are covered
by `apps/shell/tests/directory-macro-formats.test.ts` with a mocked native
Docs stage. There is no `chat-smoke.mjs` desktop smoke script in this
directory yet; a desktop run would additionally verify VBA bytes and package
declarations survive reopen. No macro is executed or external model called.
