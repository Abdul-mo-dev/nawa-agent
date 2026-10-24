const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { authorityId, sha256, readJson } = require('./authority.cjs')

const root = path.resolve(__dirname, '../..')
const publicFile = path.join(root, 'apps/shell/build/license-authority.json')
const outputDirectory = path.join(root, 'apps/shell/build/offline-license')

function buildLicenseHelper({ authorityFile = publicFile, output = outputDirectory } = {}) {
  if (process.platform !== 'win32')
    throw new Error('Build the Windows licensing helper on Windows.')
  if (!fs.existsSync(authorityFile))
    throw new Error(
      'No Nawa approval authority. Run npm run license:admin -- init on the administrator PC first. Private signing keys must stay outside the project.',
    )
  const info = readJson(authorityFile)
  if (
    info.schema !== 1 ||
    info.product !== 'nawa' ||
    typeof info.modulus !== 'string' ||
    !/^[A-Za-z0-9+/]{512}$/.test(info.modulus) ||
    Buffer.from(info.modulus, 'base64').length !== 384 ||
    info.exponent !== 'AQAB' ||
    info.authorityId !== authorityId(info)
  )
    throw new Error('Invalid Nawa public approval authority.')
  fs.mkdirSync(output, { recursive: true })
  const constants = path.join(output, 'Authority.cs')
  fs.writeFileSync(
    constants,
    `internal static class Authority { public const string Id = "${info.authorityId}"; public const string Modulus = "${info.modulus}"; public const string Exponent = "${info.exponent}"; }\n`,
  )
  const helper = path.join(output, 'nawa-license.exe')
  const compiler = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  )
  execFileSync(
    compiler,
    [
      '/nologo',
      '/codepage:65001',
      '/target:winexe',
      '/platform:anycpu',
      '/optimize+',
      `/out:${helper}`,
      '/reference:System.Core.dll',
      '/reference:System.Web.Extensions.dll',
      '/reference:System.Management.dll',
      '/reference:System.Windows.Forms.dll',
      '/reference:System.Drawing.dll',
      path.join(__dirname, 'NawaLicense.cs'),
      constants,
    ],
    { stdio: 'inherit', windowsHide: true },
  )
  const policy = {
    schema: 1,
    authorityId: info.authorityId,
    helperSha256: sha256(fs.readFileSync(helper)),
  }
  fs.writeFileSync(path.join(output, 'policy.json'), JSON.stringify(policy) + '\n')
  return policy
}

module.exports = { buildLicenseHelper, outputDirectory }
if (require.main === module) console.log(JSON.stringify(buildLicenseHelper()))
