// Administrator-only code. Nothing in this directory is shipped in Nawa.
const crypto = require('node:crypto')
const fs = require('node:fs')

const PRODUCT = 'nawa'
const MAX_FILE = 32768
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const deviceId = (key) => sha256(`${key.modulus}.${key.exponent}`)
const authorityId = (key) => sha256(`${key.modulus}.${key.exponent}`).slice(0, 24)

function publicInfo(key) {
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' })
  const result = {
    schema: 1,
    product: PRODUCT,
    modulus: Buffer.from(jwk.n, 'base64url').toString('base64'),
    exponent: Buffer.from(jwk.e, 'base64url').toString('base64'),
  }
  return { ...result, authorityId: authorityId(result) }
}

function fromPublic(key) {
  return crypto.createPublicKey({
    key: {
      kty: 'RSA',
      n: Buffer.from(key.modulus, 'base64').toString('base64url'),
      e: Buffer.from(key.exponent, 'base64').toString('base64url'),
    },
    format: 'jwk',
  })
}

function readJson(file) {
  if (fs.statSync(file).size > MAX_FILE) throw new Error('License/request file is too large.')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function unpack(envelope) {
  if (
    !envelope ||
    Object.keys(envelope).sort().join(',') !== 'payload,signature' ||
    typeof envelope.payload !== 'string' ||
    typeof envelope.signature !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)
  ) {
    throw new Error('Invalid signed envelope.')
  }
  const bytes = Buffer.from(envelope.payload, 'base64')
  if (bytes.length > MAX_FILE) throw new Error('Signed payload is too large.')
  return {
    bytes,
    payload: JSON.parse(bytes.toString('utf8')),
    signature: Buffer.from(envelope.signature, 'base64'),
  }
}

function verifyRequest(envelope, authority, allowSoftware = false) {
  const { bytes, payload, signature } = unpack(envelope)
  if (
    payload.schema !== 1 ||
    payload.product !== PRODUCT ||
    payload.authorityId !== authority.authorityId ||
    !/^[a-f0-9]{64}$/.test(payload.machineId) ||
    !/^[a-f0-9]{64}$/.test(payload.deviceId) ||
    typeof payload.machineName !== 'string' ||
    payload.machineName.length > 256 ||
    !['tpm', 'software'].includes(payload.provider) ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    !payload.publicKey ||
    typeof payload.publicKey.modulus !== 'string' ||
    typeof payload.publicKey.exponent !== 'string' ||
    Buffer.from(payload.publicKey.modulus, 'base64').length !== 256 ||
    payload.publicKey.exponent !== 'AQAB' ||
    deviceId(payload.publicKey) !== payload.deviceId ||
    !crypto.verify(
      'sha256',
      bytes,
      { key: fromPublic(payload.publicKey), padding: crypto.constants.RSA_PKCS1_PADDING },
      signature,
    )
  ) {
    throw new Error('Invalid device request or proof of possession.')
  }
  if (payload.provider === 'software' && !allowSoftware) {
    throw new Error(
      'This request uses a software key. Review the PC, then explicitly pass --allow-software to approve it.',
    )
  }
  return payload
}

function issueLicense(request, privateKey, { licensee, expiresAt = null, now = new Date() }) {
  if (typeof licensee !== 'string' || !licensee.trim() || licensee.length > 200)
    throw new Error('Provide --licensee (1–200 characters).')
  if (
    expiresAt !== null &&
    (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())
  ) {
    throw new Error('Expiry must be a future ISO date/time.')
  }
  const payload = {
    schema: 1,
    product: PRODUCT,
    authorityId: publicInfo(privateKey).authorityId,
    licenseId: crypto.randomUUID(),
    licensee: licensee.trim(),
    deviceId: request.deviceId,
    machineId: request.machineId,
    provider: request.provider,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  }
  const bytes = Buffer.from(JSON.stringify(payload))
  const signature = crypto.sign('sha256', bytes, {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  })
  return { payload: bytes.toString('base64'), signature: signature.toString('base64') }
}

module.exports = {
  PRODUCT,
  sha256,
  deviceId,
  authorityId,
  publicInfo,
  fromPublic,
  readJson,
  unpack,
  verifyRequest,
  issueLicense,
}
