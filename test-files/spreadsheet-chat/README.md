# Spreadsheet folder-chat test files

These samples exercise reviewed XLSX-copy editing of `.xls`, `.ods`, `.xlsb`,
`.csv` and `.tsv` files. `manifest.json` records the source hashes.

`binary.xls` is a genuine binary workbook exported from the authored
`source/binary.xlsx`. It contains Unicode text, numbers, a leading-zero ID,
formula-looking literal text, and relative/absolute SUM formulas. `formulas.ods` uses the existing
authored Sheets fixture with dates, multiple sheets, supported formulas and an
unsupported formula with a cached value. `sheets.xlsb` comes from the existing
Calamine fixture; its MIT license and source provenance are retained.

The CSV has a UTF-8 BOM; the TSV has a UTF-16LE BOM and comma-heavy notes that
must remain one column. Both include Unicode and a formula-looking text cell.

Generate with `node test-files/spreadsheet-chat/generate.mjs`. LibreOffice is
needed only to author the XLS fixture; the app's spreadsheet imports use the
bundled Sheets engines. After rebuilding Sheets and the shell, run
`node test-files/spreadsheet-chat/chat-smoke.mjs` for the actual Electron
folder-agent inspection, native chat edit, review, save and reopen checks.
The desktop test invokes native chat tools without calling an external model.

The genuine XLS sample exposed a Calamine BIFF formula issue: relative range
flags can be decoded as impossible column references. The importer now refuses
references outside XLS row/column bounds and preserves their cached values,
reporting the fallback count. Valid decoded formulas remain editable formulas.
