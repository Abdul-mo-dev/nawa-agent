// Windows integration: real TPM/CNG, signatures, atomic import and persistence.
// Uses an ephemeral authority, never the administrator's real signing key.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildLicenseHelper } = require('./build.cjs')
const { publicInfo, readJson, verifyRequest, issueLicense, unpack } = require('./authority.cjs')

test(
  'Windows native offline approval flow',
  { skip: process.platform !== 'win32', timeout: 150000 },
  async (t) => {
    const issuer = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey
    const authority = publicInfo(issuer)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nawa-native-license-'))
    const authorityFile = path.join(directory, 'authority.json')
    fs.writeFileSync(authorityFile, JSON.stringify(authority))
    buildLicenseHelper({ authorityFile, output: directory })
    const helper = path.join(directory, 'nawa-license.exe')
    const storedDirectory = path.join(
      process.env.LOCALAPPDATA,
      'Nawa/Licensing',
      authority.authorityId,
    )
    const storedLicense = path.join(storedDirectory, 'activation.nawa-license')
    function run(args, expected = 0) {
      try {
        const stdout = execFileSync(helper, args, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 25000,
        })
        assert.equal(expected, 0, stdout)
        return JSON.parse(stdout)
      } catch (error) {
        if (error.status === undefined) throw error
        assert.equal(error.status, expected, String(error.stdout))
        return JSON.parse(String(error.stdout))
      }
    }
    function saveLicense(name, envelope) {
      const file = path.join(directory, name + '.nawa-license')
      fs.writeFileSync(file, JSON.stringify(envelope))
      return file
    }
    function changed(envelope, extra, signingKey = issuer) {
      const payload = { ...unpack(envelope).payload, ...extra }
      const bytes = Buffer.from(JSON.stringify(payload))
      return {
        payload: bytes.toString('base64'),
        signature: crypto
          .sign('sha256', bytes, {
            key: signingKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32,
          })
          .toString('base64'),
      }
    }
    try {
      await t.test('missing activation fails closed', () =>
        assert.equal(run(['status'], 3).ok, false),
      )
      let req
      await t.test('exports a real TPM-backed, self-signed request', () => {
        const file = path.join(directory, 'device.nawa-request')
        assert.equal(run(['request', '--out', file]).ok, true)
        req = verifyRequest(readJson(file), authority)
        assert.equal(req.provider, 'tpm')
      })
      await t.test('installer request/preflight arguments accept paths containing spaces', () => {
        const file = path.join(directory, 'installer request with spaces.nawa-request')
        try {
          execFileSync(helper, ['installer', '/S', `/NAWAREQUEST=${file}`], {
            windowsHide: true,
            stdio: 'pipe',
          })
          assert.fail('request collection must return the installer exit-only status')
        } catch (error) {
          assert.equal(error.status, 10)
        }
        assert.equal(verifyRequest(readJson(file), authority).deviceId, req.deviceId)
        run(['installer', '/S', '/NAWAVERIFY'], 3)
      })
      const envelope = issueLicense(req, issuer, {
        licensee: 'Native QA only',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      })
      await t.test('imports and verifies a signed license with key possession', () => {
        assert.equal(
          run(['import', '--license', saveLicense('valid', envelope)]).licensee,
          'Native QA only',
        )
        assert.equal(run(['status']).ok, true)
        assert.equal(run(['status']).provider, 'tpm')
      })
      await t.test(
        'approved installer continues normally but preflight exits without installing',
        () => {
          assert.doesNotThrow(() =>
            execFileSync(helper, ['installer', '/S'], { windowsHide: true, stdio: 'pipe' }),
          )
          assert.throws(
            () =>
              execFileSync(helper, ['installer', '/S', '/NAWAVERIFY'], {
                windowsHide: true,
                stdio: 'pipe',
              }),
            (error) => error.status === 10,
          )
        },
      )
      await t.test(
        'rejects modified signatures, another PC/key, expired/future and foreign issuer licenses',
        () => {
          const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey
          const now = Date.now()
          const cases = [
            { ...envelope, signature: Buffer.alloc(384).toString('base64') },
            changed(envelope, { machineId: 'b'.repeat(64) }),
            changed(envelope, { deviceId: 'b'.repeat(64) }),
            changed(envelope, {
              issuedAt: new Date(now - 7200000).toISOString(),
              expiresAt: new Date(now - 3600000).toISOString(),
            }),
            changed(envelope, { issuedAt: new Date(now + 3600000).toISOString() }),
            changed(envelope, {}, foreign),
            changed(envelope, { product: 'other' }),
          ]
          for (const [i, invalid] of cases.entries()) {
            assert.equal(
              run(['import', '--license', saveLicense('invalid-' + i, invalid)], 3).ok,
              false,
            )
            assert.equal(run(['status']).ok, true, 'bad import must preserve the original license')
          }
        },
      )
      await t.test('survives helper rebuilds and app updates using the same authority', () => {
        buildLicenseHelper({ authorityFile, output: directory })
        assert.equal(run(['status']).ok, true)
      })
      await t.test('modified installed licenses fail on the next startup check', () => {
        fs.writeFileSync(
          storedLicense,
          JSON.stringify(changed(envelope, { machineId: 'c'.repeat(64) })),
        )
        assert.equal(run(['status'], 3).ok, false)
      })
      await t.test('software requests require explicit issuer consent', () => {
        const file = path.join(directory, 'software.nawa-request')
        run(['request', '--software', '--out', file])
        assert.throws(() => verifyRequest(readJson(file), authority), /--allow-software/)
        const software = verifyRequest(readJson(file), authority, true)
        const approved = issueLicense(software, issuer, { licensee: 'Explicit software QA' })
        run(['import', '--license', saveLicense('software', approved)])
        assert.equal(run(['status']).provider, 'software')
      })
    } finally {
      // Exact files/keys of this newly generated authority only.
      if (fs.existsSync(storedLicense)) fs.unlinkSync(storedLicense)
      if (fs.existsSync(storedDirectory)) fs.rmdirSync(storedDirectory)
      const command = `$ErrorActionPreference = 'Stop'; foreach ($kind in @('tpm','software')) { $provider = if ($kind -eq 'tpm') { New-Object Security.Cryptography.CngProvider('Microsoft Platform Crypto Provider') } else { [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider }; $name = 'Nawa.OfflineLicense.${authority.authorityId}.' + $kind + '.v1'; if ([Security.Cryptography.CngKey]::Exists($name, $provider)) { $key = [Security.Cryptography.CngKey]::Open($name, $provider); $key.Delete(); $key.Dispose() } }`
      execFileSync(
        path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, stdio: 'pipe' },
      )
    }
  },
)
