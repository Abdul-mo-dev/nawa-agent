// Keep this utility and its private key on the approving administrator's PC.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { publicInfo, readJson, unpack, verifyRequest, issueLicense } = require('./authority.cjs')

const root = path.resolve(__dirname, '../..')
const publicFile = path.join(root, 'apps/shell/build/license-authority.json')
const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
)
const defaultDirectory = path.join(process.env.LOCALAPPDATA || '', 'Nawa-License-Authority')

function options(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--allow-software') result.allowSoftware = true
    else if (
      ['--request', '--out', '--licensee', '--expires', '--admin-dir', '--from'].includes(arg) &&
      argv[i + 1] &&
      !argv[i + 1].startsWith('--')
    )
      result[arg.slice(2)] = argv[++i]
    else throw new Error(`Unknown or incomplete argument: ${arg}`)
  }
  return result
}

function dpapi(bytes, operation) {
  const command = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Add-Type -AssemblyName System.Security; $raw = [Console]::In.ReadToEnd(); $data = [Convert]::FromBase64String($raw); $result = [Security.Cryptography.ProtectedData]::${operation}($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`
  return Buffer.from(
    execFileSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64'),
      ],
      { input: bytes.toString('base64'), encoding: 'utf8', windowsHide: true },
    ).trim(),
    'base64',
  )
}

function protectDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
  const sid = execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
  execFileSync(
    'icacls.exe',
    [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    { windowsHide: true, stdio: 'pipe' },
  )
}

async function password(prompt) {
  if (!process.stdin.isTTY) throw new Error('Key backup/restore requires an interactive terminal.')
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          finish()
          reject(new Error('Cancelled.'))
          return
        }
        if (char === '\r' || char === '\n') {
          finish()
          resolve(value)
          return
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else if (char >= ' ') value += char
      }
    }
    const finish = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
    }
    process.stdin.on('data', onData)
  })
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help') {
    console.log(
      'Nawa offline approval administrator\n\ninit [--from encrypted-backup.pem]\nissue --request PC.nawa-request --licensee "Owner / PC" --out PC.nawa-license [--expires ISO-date] [--allow-software]\nlist\nbackup --out encrypted-backup.pem\n\nPrivate keys are Windows DPAPI protected, outside the project and installer.\nUse --admin-dir PATH for a separate authority. No network service is required.',
    )
    return
  }
  if (process.platform !== 'win32')
    throw new Error('The approval key store currently requires Windows.')
  const opts = options(argv)
  const directory = path.resolve(opts['admin-dir'] || defaultDirectory)
  // Never let a private key enter the build tree, even by accidentally choosing it.
  const relative = path.relative(root, directory)
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    throw new Error('The administrator key directory must be outside the project.')
  const keyFile = path.join(directory, 'issuer-private.dpapi')
  const keyPublicFile = path.join(directory, 'issuer-public.json')
  if (command === 'init') {
    if (fs.existsSync(keyFile))
      throw new Error(`An approval key already exists at ${keyFile}. It was preserved.`)
    let key
    if (opts.from)
      key = crypto.createPrivateKey({
        key: fs.readFileSync(opts.from),
        passphrase: await password('Backup password: '),
      })
    else key = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey
    const info = publicInfo(key)
    if (fs.existsSync(publicFile) && readJson(publicFile).authorityId !== info.authorityId)
      throw new Error('The project already trusts another authority. Its public key was preserved.')
    protectDirectory(directory)
    fs.writeFileSync(keyFile, dpapi(key.export({ format: 'der', type: 'pkcs8' }), 'Protect'), {
      flag: 'wx',
    })
    fs.writeFileSync(keyPublicFile, JSON.stringify(info, null, 2) + '\n')
    fs.writeFileSync(publicFile, JSON.stringify(info, null, 2) + '\n')
    console.log(
      `Approval authority: ${info.authorityId}\nPrivate key: ${keyFile}\nPublic key for builds: ${publicFile}\nCreate an encrypted backup with: npm run license:admin -- backup --out <safe-location.pem>`,
    )
    return
  }
  if (!fs.existsSync(keyFile))
    throw new Error(
      `No approval key at ${keyFile}. Run init on the approving administrator's PC first.`,
    )
  if (command === 'list') {
    const log = path.join(directory, 'issued.jsonl')
    console.log(fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : 'No licenses issued.')
    return
  }
  const key = crypto.createPrivateKey({
    key: dpapi(fs.readFileSync(keyFile), 'Unprotect'),
    format: 'der',
    type: 'pkcs8',
  })
  const info = publicInfo(key)
  if (command === 'backup') {
    if (!opts.out) throw new Error('Provide --out for the encrypted backup.')
    const backupRelative = path.relative(root, path.resolve(opts.out))
    if (
      backupRelative !== '..' &&
      !backupRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(backupRelative)
    ) {
      throw new Error('Store the private-key backup outside the project and installer files.')
    }
    const secret = await password('Backup password (at least 16 characters): ')
    if (secret.length < 16 || secret !== (await password('Confirm password: ')))
      throw new Error('Passwords must match and contain at least 16 characters.')
    fs.writeFileSync(
      opts.out,
      key.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: secret }),
      { flag: 'wx' },
    )
    console.log(`Encrypted approval key backup saved: ${path.resolve(opts.out)}`)
    return
  }
  if (command !== 'issue' || !opts.request || !opts.out)
    throw new Error('Use issue --request <file> --licensee <name> --out <file>.')
  if (readJson(publicFile).authorityId !== info.authorityId)
    throw new Error('This private key does not match the public key trusted by this build.')
  const request = verifyRequest(readJson(opts.request), info, opts.allowSoftware)
  const envelope = issueLicense(request, key, {
    licensee: opts.licensee,
    expiresAt: opts.expires ?? null,
  })
  fs.writeFileSync(opts.out, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' })
  const { payload } = unpack(envelope)
  fs.appendFileSync(
    path.join(directory, 'issued.jsonl'),
    JSON.stringify({ ...payload, machineName: request.machineName }) + '\n',
  )
  console.log(
    `Approved ${request.machineName} (${request.provider}) for ${payload.licensee}.\nLicense: ${path.resolve(opts.out)}\nExpiry: ${payload.expiresAt || 'none'}`,
  )
}

main().catch((error) => {
  console.error(`Nawa approval: ${error.message}`)
  process.exitCode = 1
})
