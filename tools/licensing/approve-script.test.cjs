// Exercise the actual PowerShell wrapper and issuer with a separate temporary
// authority. No real PC is approved and the production signing key is untouched.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const { publicInfo, deviceId, unpack, fromPublic } = require('./authority.cjs')

test(
  'administrator PowerShell approval script',
  { skip: process.platform !== 'win32', timeout: 120000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nawa-approval-script-'))
    const checkout = path.join(directory, 'checkout with spaces')
    const keyDirectory = path.join(directory, 'private authority')
    const work = path.join(directory, "requests O'Neil & [01]")
    const powershell = path.join(
      process.env.SystemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    )
    fs.mkdirSync(path.join(checkout, 'tools/licensing'), { recursive: true })
    fs.mkdirSync(path.join(checkout, 'apps/shell/build'), { recursive: true })
    fs.mkdirSync(work)
    fs.copyFileSync(
      path.resolve(__dirname, '../../Approve-NawaPC.ps1'),
      path.join(checkout, 'Approve-NawaPC.ps1'),
    )
    for (const file of ['admin.cjs', 'authority.cjs'])
      fs.copyFileSync(path.join(__dirname, file), path.join(checkout, 'tools/licensing', file))
    const issuer = path.join(checkout, 'tools/licensing/admin.cjs')
    const script = path.join(checkout, 'Approve-NawaPC.ps1')
    const launcher = path.join(directory, 'invoke-approval.ps1')
    fs.writeFileSync(
      launcher,
      [
        'param([string]$SettingsFile)',
        '$ErrorActionPreference = "Stop"',
        '$settings = Get-Content -LiteralPath $SettingsFile -Raw | ConvertFrom-Json',
        'Set-Location -LiteralPath $settings.cwd',
        '$parameters = @{}',
        'foreach ($property in $settings.parameters.PSObject.Properties) { $parameters[$property.Name] = $property.Value }',
        'if ($null -ne $settings.answers) {',
        '  $global:nawaApprovalAnswers = New-Object "Collections.Generic.Queue[string]"',
        '  foreach ($answer in $settings.answers) { $global:nawaApprovalAnswers.Enqueue($answer) }',
        '  function global:Read-Host { param([string]$Prompt) if ($global:nawaApprovalAnswers.Count -eq 0) { throw "Unexpected prompt: $Prompt" }; return $global:nawaApprovalAnswers.Dequeue() }',
        '}',
        '& $settings.script @parameters',
        'exit $LASTEXITCODE',
      ].join('\n'),
    )
    const requestFile = path.join(work, "PC O'Neil & [01].nawa-request")
    const device = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    let authority
    function request(provider = 'tpm') {
      // A simulated public device proof is sufficient for testing the wrapper;
      // actual TPM key handling is covered by native.test.cjs.
      const key = publicInfo(device)
      const payload = {
        schema: 1,
        product: 'nawa',
        authorityId: authority.authorityId,
        machineId: 'a'.repeat(64),
        machineName: 'Wrapper QA (no real deployment)',
        deviceId: deviceId(key),
        provider,
        publicKey: { modulus: key.modulus, exponent: key.exponent },
        createdAt: new Date().toISOString(),
      }
      const bytes = Buffer.from(JSON.stringify(payload))
      return {
        payload: bytes.toString('base64'),
        signature: crypto
          .sign('sha256', bytes, { key: device, padding: crypto.constants.RSA_PKCS1_PADDING })
          .toString('base64'),
      }
    }
    function run(args, expected = 0, executable = powershell, answers = null) {
      const parameters = { AdminDirectory: keyDirectory }
      for (let i = 0; i < args.length; i++) {
        const name = args[i].slice(1)
        parameters[name] = [
          'NonInteractive',
          'AllowSoftwareKey',
          'List',
          'BackupKey',
          'WhatIf',
        ].includes(name)
          ? true
          : args[++i]
      }
      const settingsFile = path.join(directory, 'invocation.json')
      fs.writeFileSync(settingsFile, JSON.stringify({ cwd: work, script, parameters, answers }))
      const result = spawnSync(
        executable,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          launcher,
          '-SettingsFile',
          settingsFile,
        ],
        { cwd: work, encoding: 'utf8', timeout: 20000, windowsHide: true },
      )
      assert.equal(result.error, undefined, String(result.error))
      assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
      return result
    }
    function signed(file) {
      const result = unpack(JSON.parse(fs.readFileSync(file, 'utf8')))
      assert.equal(
        crypto.verify(
          'sha256',
          result.bytes,
          {
            key: fromPublic(authority),
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32,
          },
          result.signature,
        ),
        true,
      )
      return result.payload
    }
    try {
      execFileSync(process.execPath, [issuer, 'init', '--admin-dir', keyDirectory], {
        windowsHide: true,
        stdio: 'pipe',
        timeout: 20000,
      })
      authority = JSON.parse(
        fs.readFileSync(path.join(checkout, 'apps/shell/build/license-authority.json')),
      )
      fs.writeFileSync(requestFile, JSON.stringify(request()))
      const label = 'Wrapper QA / PC-01 "quoted"'
      const defaultLicense = requestFile.replace(/\.nawa-request$/, '.nawa-license')
      await t.test(
        'PowerShell 5.1 signs with literal paths, quoted labels, and no app dependencies',
        () => {
          run(['-RequestPath', path.basename(requestFile), '-Licensee', label, '-NonInteractive'])
          const payload = signed(defaultLicense)
          assert.equal(payload.licensee, label)
          assert.equal(payload.expiresAt, null)
        },
      )
      await t.test('guided prompts accept a pasted quoted path and blank expiry', () => {
        const file = path.join(work, 'guided.nawa-request')
        fs.writeFileSync(file, JSON.stringify(request()))
        run([], 0, powershell, [`"${file}"`, 'Guided "QA"', ''])
        const payload = signed(file.replace('.nawa-request', '.nawa-license'))
        assert.equal(payload.licensee, 'Guided "QA"')
        assert.equal(payload.expiresAt, null)
      })
      await t.test('normalizes date-only expiry to the end of the UTC day', () => {
        const date = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10)
        const output = path.join(work, 'dated.nawa-license')
        run([
          '-RequestPath',
          requestFile,
          '-Licensee',
          'Dated QA',
          '-ExpiresAt',
          date,
          '-OutputPath',
          output,
          '-NonInteractive',
        ])
        assert.equal(signed(output).expiresAt, date + 'T23:59:59.999Z')
      })
      await t.test('preview creates neither a license nor a ledger entry', () => {
        const ledger = path.join(keyDirectory, 'issued.jsonl')
        const before = fs.readFileSync(ledger, 'utf8')
        const output = path.join(work, 'preview.nawa-license')
        run([
          '-RequestPath',
          requestFile,
          '-Licensee',
          'Preview only',
          '-OutputPath',
          output,
          '-WhatIf',
          '-NonInteractive',
        ])
        assert.equal(fs.existsSync(output), false)
        assert.equal(fs.readFileSync(ledger, 'utf8'), before)
      })
      await t.test('does not overwrite an existing license', () => {
        const before = fs.readFileSync(defaultLicense, 'utf8')
        const result = run(
          ['-RequestPath', requestFile, '-Licensee', 'Must fail', '-NonInteractive'],
          1,
        )
        assert.match(result.stderr, /already exists/)
        assert.equal(fs.readFileSync(defaultLicense, 'utf8'), before)
      })
      await t.test('missing inputs and expired dates fail without prompting or issuing', () => {
        assert.match(run(['-NonInteractive'], 1).stderr, /Missing input/)
        const output = path.join(work, 'expired.nawa-license')
        assert.match(
          run(
            [
              '-RequestPath',
              requestFile,
              '-Licensee',
              'Expired QA',
              '-ExpiresAt',
              '2020-01-01',
              '-OutputPath',
              output,
              '-NonInteractive',
            ],
            1,
          ).stderr,
          /future/,
        )
        assert.equal(fs.existsSync(output), false)
      })
      await t.test('software approval requires the explicit switch', () => {
        const file = path.join(work, 'software.nawa-request')
        const output = path.join(work, 'software.nawa-license')
        fs.writeFileSync(file, JSON.stringify(request('software')))
        assert.match(
          run(['-RequestPath', file, '-Licensee', 'Software QA', '-NonInteractive'], 1).stderr,
          /--allow-software/,
        )
        assert.equal(fs.existsSync(output), false)
        run([
          '-RequestPath',
          file,
          '-Licensee',
          'Software QA',
          '-AllowSoftwareKey',
          '-NonInteractive',
        ])
        assert.equal(signed(output).provider, 'software')
      })
      await t.test('lists the selected authority and requires interactive backup', () => {
        assert.match(run(['-List']).stdout, /Wrapper QA/)
        assert.match(
          run(
            ['-BackupKey', '-OutputPath', path.join(directory, 'backup.pem'), '-NonInteractive'],
            1,
          ).stderr,
          /interactive terminal/,
        )
        assert.equal(fs.existsSync(path.join(directory, 'backup.pem')), false)
      })
      await t.test('rejects an invalid signed request without producing a license', () => {
        const file = path.join(work, 'invalid.nawa-request')
        fs.writeFileSync(file, '{}')
        run(['-RequestPath', file, '-Licensee', 'Invalid QA', '-NonInteractive'], 1)
        assert.equal(fs.existsSync(file.replace('.nawa-request', '.nawa-license')), false)
      })
      const pwsh = spawnSync(
        'pwsh.exe',
        ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        { windowsHide: true, encoding: 'utf8', timeout: 10000 },
      )
      await t.test('also works in PowerShell 7 when available', { skip: pwsh.status !== 0 }, () => {
        const file = path.join(work, 'powershell7.nawa-license')
        run(
          ['-RequestPath', requestFile, '-Licensee', label, '-OutputPath', file, '-NonInteractive'],
          0,
          'pwsh.exe',
        )
        assert.equal(signed(file).licensee, label)
      })
    } finally {
      // Verify the exact generated absolute target before recursively removing
      // this test's temporary checkout, approvals, and isolated private key.
      const resolved = fs.realpathSync(directory)
      const tempRoot = fs.realpathSync(os.tmpdir()) + path.sep
      assert.ok(
        resolved.startsWith(tempRoot) &&
          path.basename(resolved).startsWith('nawa-approval-script-'),
      )
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  },
)
