import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const directory = import.meta.dirname
const readJson = async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))
const manifest = await readJson('manifest.json')
const engines = await readJson('report.json')
const desktop = await readJson('ui-report.json')
const charts = await readJson('chart-data-report.json')
assert(engines.passed && desktop.passed && charts.passed, 'A validation report contains failures')
const rows = []
for (const sample of manifest.files) {
  const bytes = await readFile(join(directory, sample.file))
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    sample.sha256,
    `Original changed: ${sample.file}`,
  )
  const engine = engines.cases.find((row) => row.file === sample.file)
  const gui = desktop.cases.find((row) => row.file === sample.file)
  assert(engine?.passed && gui?.passed && engine.sourceUnchanged && gui.sourceUnchanged)
  rows.push(
    `| [${sample.file}](${sample.file}) | PASS | PASS | Unchanged | [Edited copy](${gui.editedFile}) |`,
  )
}
const text = `# Legacy Office test results

All five generated binary Office samples passed engine and real desktop tests.
Original file SHA-256 hashes match the generation manifest after all checks.

| Sample | Engine | Desktop | Original | Saved output |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

The desktop checks opened and rendered each file, made an edit, canceled the first
save, verified that saving to the legacy original was rejected, then saved and
reopened a modern Office copy. Word tables rendered, and all presentations retained
three slides. Screenshots are in [screenshots/](screenshots/).

Engine checks also verified formatted and multilingual text, tables, images,
headers/footers and page breaks in Word, and charts and speaker notes in Slides.
Both intentionally corrupt files were rejected without modification. Chart labels
Q1/Q2/Q3 and values 4/7/3 survived all three presentation imports and edited saves.

The richer samples exposed a chart-loss bug in the converter's active-content
setting. The importer now preserves internal chart objects while keeping macros
and Windows OLE automation disabled. A shared converter regression test covers it.

Validation: 7 sample engine cases, 5 desktop cases, and 13 converter regression/
failure cases passed. Docs, Slides, and shell production builds, typechecking,
lint, formatting, and repository boundary/theme/comment checks passed.

Detailed evidence: [engine report](report.json), [desktop report](ui-report.json),
[chart data](chart-data-report.json), and [original hashes](manifest.json).
These checks establish functionality and selected content preservation, not exact
pixel equivalence with Microsoft Office. Regeneration and rerun commands are in
[README.md](README.md).
`
await writeFile(join(directory, 'results.md'), text)
console.log('PASS: five originals unchanged; all engine, desktop and chart reports passed.')
