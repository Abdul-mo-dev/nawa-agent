# Legacy Office test files

Open `document-sample.doc`, `document-sample.dot`, `presentation-sample.ppt`,
`presentation-sample.pps`, and `presentation-sample.pot` in Nawa. They are genuine
binary files exported by LibreOffice, with matching source packages in `source/`.

The Word samples contain formatted text, English/Japanese/Arabic text, a four-row
table, an embedded image, bullets, a hyperlink, headers/footers, and a page break.
The presentation samples contain three slides, formatted and multilingual text,
an image, a shape, a table, a chart, a hyperlink, and speaker notes.

`negative/` contains intentionally corrupt inputs. `manifest.json` records each
valid sample's size and SHA-256. `edited/` and the test reports contain outputs
from the validation run. The original samples must retain their manifest hashes.

Regenerate with `node test-files/legacy-office/generate.mjs` from the repository
root. LibreOffice must be installed; `NAWA_LIBREOFFICE_PATH` can select a custom
executable. The generator uses an isolated profile inside the workspace.

Run engine validation with
`npx vitest run --config test-files/legacy-office/vitest.config.ts`. Run the real
desktop smoke with `node test-files/legacy-office/ui-smoke.mjs` after rebuilding
Docs, Slides and the shell. The desktop smoke saves screenshots, tests canceled
saves and rejected legacy overwrites, then saves and reopens modern copies.

The richer samples exposed a chart-loss bug: disabling all active content caused
LibreOffice to drop embedded legacy charts. The importer now keeps internal chart
objects readable while disabling macros and Windows OLE automation. The shared
converter suite contains a regression test for this sample.

See [results.md](results.md) for the combined results. After running both test
commands, run `node test-files/legacy-office/check-chart-data.mjs` and
`node test-files/legacy-office/summarize.mjs` to validate the chart data and
regenerate the combined report.

Run folder-chat validation with `node test-files/legacy-office/chat-smoke.mjs`
after building the shell. It mounts an isolated test workspace, converts each
legacy sample for read-only inspection, then edits through the real native chat
tools and commits a modern copy. `chat-results.md` and `chat-report.json` record
the results; `chat-edited-*/` holds preserved sources and edited modern outputs.
No external model requests are sent by this desktop test. The shell regression
suite separately runs the actual child agent loop with a deterministic provider
transport, both approval phases, a save receipt and continuation after saving.
