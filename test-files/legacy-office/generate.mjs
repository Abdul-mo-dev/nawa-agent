import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import pptxgen from 'pptxgenjs'
import { PNG } from 'pngjs'

const directory = import.meta.dirname
const workspace = resolve(directory, '../..')
const sourceDirectory = join(directory, 'source')
await mkdir(sourceDirectory, { recursive: true })
const taskDirectory = join(workspace, '.task')
await mkdir(taskDirectory, { recursive: true })

async function findConverter() {
  const names =
    process.platform === 'win32' ? ['soffice.com', 'soffice.exe'] : ['soffice', 'libreoffice']
  const searchDirectories = (process.env.PATH || '').split(delimiter).filter(Boolean)
  searchDirectories.push(
    'C:/Program Files/LibreOffice/program',
    '/Applications/LibreOffice.app/Contents/MacOS',
    '/usr/bin',
    '/opt/homebrew/bin',
  )
  const candidates = process.env.NAWA_LIBREOFFICE_PATH
    ? [process.env.NAWA_LIBREOFFICE_PATH]
    : searchDirectories.flatMap((path) => names.map((name) => join(path, name)))
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return resolve(candidate)
    } catch {
      /* Try the next standard location. */
    }
  }
  throw new Error('LibreOffice is required to generate genuine binary fixtures.')
}

const image = new PNG({ width: 256, height: 128 })
for (let y = 0; y < image.height; y++) {
  for (let x = 0; x < image.width; x++) {
    const offset = (y * image.width + x) * 4
    const light = ((x >> 4) + (y >> 4)) % 2 === 0
    image.data.set(light ? [48, 110, 180, 255] : [245, 190, 65, 255], offset)
  }
}
const imageBytes = PNG.sync.write(image)
await writeFile(join(sourceDirectory, 'sample-image.png'), imageBytes)
const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
const escapeXml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
const run = (text, properties = '') =>
  `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
const paragraph = (text, properties = '') =>
  `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${run(text)}</w:p>`
const tableRows = [
  ['Item', 'Count', 'Price'],
  ['Pencil', '3', '2.50'],
  ['Notebook', '5', '12.75'],
  ['Total', '8', '15.25'],
]
const table =
  '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:color="808080"/>`)
    .join('') +
  '</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
  tableRows
    .map(
      (cells, row) =>
        `<w:tr>${cells.map((text) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${row === 0 ? '<w:shd w:fill="DDE8F4"/>' : ''}</w:tcPr>${paragraph(text)}</w:tc>`).join('')}</w:tr>`,
    )
    .join('') +
  '</w:tbl>'
const drawing =
  '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2560000" cy="1280000"/><wp:docPr id="1" name="Test image" descr="Blue and yellow checkerboard"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="sample-image.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2560000" cy="1280000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
const documentBody = [
  paragraph('Nawa Legacy Office Test', '<w:pStyle w:val="Heading1"/>'),
  '<w:p>' +
    run('Bold text', '<w:b/>') +
    run(' / ') +
    run('Italic text', '<w:i/>') +
    run(' / ') +
    run('Underlined text', '<w:u w:val="single"/>') +
    run(' / ') +
    run('Blue text', '<w:color w:val="306EB4"/>') +
    '</w:p>',
  paragraph('English: Hello world'),
  paragraph('Japanese: テスト文書'),
  paragraph('Arabic: مرحبا بالعالم'),
  paragraph('Bullet item one', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
  paragraph('Bullet item two', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
  table,
  drawing,
  '<w:p><w:hyperlink r:id="rLink">' +
    run('Example link', '<w:color w:val="0563C1"/><w:u w:val="single"/>') +
    '</w:hyperlink></w:p>',
  '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
  paragraph('Second page marker', '<w:pStyle w:val="Heading1"/>'),
  paragraph('Editable sentence before saving.'),
  '<w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="default" r:id="rFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567"/></w:sectPr>',
].join('')
const zip = new JSZip()
zip.file(
  '[Content_Types].xml',
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
    ['document', 'styles', 'numbering', 'header1', 'footer1']
      .map(
        (part) =>
          `<Override PartName="/word/${part}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${part === 'document' ? 'document.main' : part === 'header1' ? 'header' : part === 'footer1' ? 'footer' : part}+xml"/>`,
      )
      .join('') +
    '</Types>',
)
zip.file(
  '_rels/.rels',
  `<Relationships xmlns="${relationships}"><Relationship Id="rDocument" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`,
)
zip.file(
  'word/document.xml',
  `<?xml version="1.0"?><w:document xmlns:w="${w}" xmlns:r="${r}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${documentBody}</w:body></w:document>`,
)
zip.file(
  'word/styles.xml',
  `<w:styles xmlns:w="${w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`,
)
zip.file(
  'word/numbering.xml',
  `<w:numbering xmlns:w="${w}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
)
zip.file('word/header1.xml', `<w:hdr xmlns:w="${w}">${paragraph('Nawa fixture header')}</w:hdr>`)
zip.file('word/footer1.xml', `<w:ftr xmlns:w="${w}">${paragraph('Nawa fixture footer')}</w:ftr>`)
zip.file(
  'word/_rels/document.xml.rels',
  `<Relationships xmlns="${relationships}">${[
    ['rStyles', 'styles', 'styles.xml'],
    ['rNumbering', 'numbering', 'numbering.xml'],
    ['rImage', 'image', 'media/sample-image.png'],
    ['rHeader', 'header', 'header1.xml'],
    ['rFooter', 'footer', 'footer1.xml'],
  ]
    .map(
      ([id, type, target]) => `<Relationship Id="${id}" Type="${r}/${type}" Target="${target}"/>`,
    )
    .join(
      '',
    )}<Relationship Id="rLink" Type="${r}/hyperlink" Target="https://example.org" TargetMode="External"/></Relationships>`,
)
zip.file('word/media/sample-image.png', imageBytes)
await writeFile(
  join(sourceDirectory, 'document-sample.docx'),
  await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
)

const deck = new pptxgen()
deck.layout = 'LAYOUT_WIDE'
deck.author = 'Nawa test fixtures'
deck.subject = 'Legacy import regression samples'
deck.title = 'Nawa Legacy Office Test'
deck.lang = 'en-US'
const title = (slide, text) =>
  slide.addText(text, {
    x: 0.6,
    y: 0.4,
    w: 12.1,
    h: 0.6,
    fontSize: 28,
    bold: true,
    color: '244E7A',
  })
const picture = `data:image/png;base64,${imageBytes.toString('base64')}`
const first = deck.addSlide()
title(first, 'Nawa Legacy Office Test')
first.addText(
  [
    { text: 'Bold text', options: { bold: true } },
    { text: ' / ' },
    { text: 'Italic text', options: { italic: true } },
  ],
  { x: 0.6, y: 1.4, w: 8, h: 0.6, fontSize: 20 },
)
first.addText('English: Hello world\nJapanese: テスト文書\nArabic: مرحبا بالعالم', {
  x: 0.6,
  y: 2.3,
  w: 8.1,
  h: 2.1,
  fontSize: 22,
  fontFace: 'Arial',
})
first.addShape(deck.ShapeType.roundRect, {
  x: 0.6,
  y: 5.1,
  w: 7.6,
  h: 0.9,
  fill: { color: 'DDE8F4' },
  line: { color: '306EB4', width: 1 },
})
first.addText('Shape marker', { x: 0.9, y: 5.3, w: 7, h: 0.5, fontSize: 20 })
first.addImage({ data: picture, x: 9.3, y: 2.4, w: 2.8, h: 1.4 })
first.addNotes('Nawa legacy fixture notes on slide 1.')
const second = deck.addSlide()
title(second, 'Table and chart test')
second.addTable(tableRows, {
  x: 0.6,
  y: 1.6,
  w: 5.8,
  h: 2.3,
  colW: [2.8, 1.3, 1.7],
  fontSize: 18,
  border: { color: '808080', pt: 1 },
  rowH: 0.55,
})
second.addChart(
  deck.ChartType.bar,
  [{ name: 'Sales', labels: ['Q1', 'Q2', 'Q3'], values: [4, 7, 3] }],
  {
    x: 7.0,
    y: 1.6,
    w: 5.5,
    h: 3.5,
    showLegend: false,
    showTitle: true,
    title: 'Quarterly sales',
    catAxisLabelFontSize: 16,
    valAxisLabelFontSize: 16,
  },
)
second.addNotes('Nawa legacy fixture notes on slide 2.')
const third = deck.addSlide()
title(third, 'Final slide marker')
third.addText(
  [
    { text: 'Bullet item one', options: { bullet: true, breakLine: true } },
    { text: 'Bullet item two', options: { bullet: true } },
  ],
  { x: 0.6, y: 1.6, w: 8, h: 1.5, fontSize: 22 },
)
third.addText('Example link', {
  x: 0.6,
  y: 4.0,
  w: 6,
  h: 0.7,
  fontSize: 22,
  hyperlink: { url: 'https://example.org' },
  color: '0563C1',
})
third.addText('Editable sentence before saving.', { x: 0.6, y: 5.1, w: 11, h: 0.7, fontSize: 22 })
third.addNotes('Nawa legacy fixture notes on slide 3.')
await deck.writeFile({ fileName: join(sourceDirectory, 'presentation-sample.pptx') })

const converter = await findConverter()
const version = (
  await promisify(execFile)(converter, ['--version'], { windowsHide: true, timeout: 20_000 })
).stdout.trim()
const profile = await mkdtemp(join(taskDirectory, 'legacy-fixture-profile-'))
const files = []
try {
  for (const [source, extension, filter] of [
    ['document-sample.docx', 'doc', 'MS Word 97'],
    ['document-sample.docx', 'dot', 'MS Word 97 Vorlage'],
    ['presentation-sample.pptx', 'ppt', 'MS PowerPoint 97'],
    ['presentation-sample.pptx', 'pps', 'MS PowerPoint 97 AutoPlay'],
    ['presentation-sample.pptx', 'pot', 'MS PowerPoint 97 Vorlage'],
  ]) {
    await promisify(execFile)(
      converter,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--nologo',
        '--norestore',
        '--convert-to',
        `${extension}:${filter}`,
        '--outdir',
        directory,
        join(sourceDirectory, source),
      ],
      { windowsHide: true, timeout: 90_000 },
    )
    const fileName = source.replace(/\.[^.]+$/, `.${extension}`)
    const bytes = await readFile(join(directory, fileName))
    assert.equal(
      bytes.subarray(0, 8).toString('hex'),
      'd0cf11e0a1b11ae1',
      `${fileName} is not a binary Office file`,
    )
    files.push({
      file: fileName,
      extension,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    console.log(`Created ${fileName} (${bytes.length} bytes)`)
  }
} finally {
  const ownedPath = resolve(profile)
  const withinWorkspace = relative(workspace, ownedPath)
  assert(
    !withinWorkspace.startsWith('..') &&
      withinWorkspace !== '' &&
      ownedPath.startsWith(resolve(taskDirectory)),
    'Unexpected profile cleanup path',
  )
  await rm(ownedPath, { recursive: true, force: true })
}
await mkdir(join(directory, 'negative'), { recursive: true })
await writeFile(
  join(directory, 'negative', 'corrupt.doc'),
  'Intentionally invalid Word test fixture.\n',
)
await writeFile(
  join(directory, 'negative', 'corrupt.ppt'),
  'Intentionally invalid PowerPoint test fixture.\n',
)
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      converterVersion: version,
      files,
      expected: {
        title: 'Nawa Legacy Office Test',
        documentPages: 2,
        presentationSlides: 3,
        tableRows: 4,
        tableColumns: 3,
        unicode: ['テスト文書', 'مرحبا بالعالم'],
        image: 'Blue and yellow checkerboard',
      },
    },
    null,
    2,
  ) + '\n',
)
