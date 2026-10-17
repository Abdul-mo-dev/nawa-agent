import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

const directory = import.meta.dirname
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
})
const rows = []
for (const extension of ['ppt', 'pps', 'pot']) {
  const file = `presentation-sample-${extension}.pptx`
  const archive = await JSZip.loadAsync(await readFile(join(directory, 'edited', file)))
  const xml = await archive.file('ppt/charts/chart1.xml').async('string')
  const chart = parser.parse(xml).chartSpace.chart.plotArea.barChart
  const series = Array.isArray(chart.ser) ? chart.ser[0] : chart.ser
  const points = (cache) =>
    (Array.isArray(cache.pt) ? cache.pt : [cache.pt]).map((point) => point.v)
  const categories = points(series.cat.strRef.strCache).map(String)
  const values = points(series.val.numRef.numCache).map(Number)
  assert.deepEqual(categories, ['Q1', 'Q2', 'Q3'])
  assert.deepEqual(values, [4, 7, 3])
  rows.push({ file: `edited/${file}`, categories, values, passed: true })
}
await writeFile(
  join(directory, 'chart-data-report.json'),
  JSON.stringify({ testedAt: new Date().toISOString(), passed: true, cases: rows }, null, 2) + '\n',
)
console.log(
  'PASS: chart labels Q1/Q2/Q3 and values 4/7/3 survive all three legacy imports and edited saves.',
)
