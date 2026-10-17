# Workbook import fixtures

`basic.ods` is generated from `ods-content.xml` using `node generate-ods.mjs`.
It covers numbers, strings, booleans, ISO dates, ranges, references to another
sheet, function argument separators, and an unsupported formula with a cached
value. It is authored for this project under the repository license.

`any_sheets.xlsb` and `date_1904.xlsb` are genuine binary workbooks from the
Calamine test suite. `provenance.json` records immutable source URLs, their commit,
and SHA-256 checksums. The upstream MIT license is retained in `LICENSE.calamine`.
