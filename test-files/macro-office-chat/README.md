# Macro Office chat fixtures

Generate with `node test-files/macro-office-chat/generate.mjs`, rebuild the desktop apps, then run `node test-files/macro-office-chat/chat-smoke.mjs`.

The desktop test covers DOCM, DOTM, PPTM, PPSM and POTM read-only inspection, validation, native edits, before/after review, in-place commit, original backup, VBA byte preservation and native reopen. It drives the real folder-chat IPC without an external model.

VBA payloads are opaque byte-preservation sentinels. These fixtures do not execute macros or verify Microsoft Office macro functionality.
