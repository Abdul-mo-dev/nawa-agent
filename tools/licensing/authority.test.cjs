const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const {
  publicInfo,
  deviceId,
  verifyRequest,
  issueLicense,
  unpack,
  fromPublic,
} = require('./authority.cjs')

const issuer = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey
const device = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
const authority = publicInfo(issuer)
function request(extra = {}) {
  const key = publicInfo(device)
  const payload = {
    schema: 1,
    product: 'nawa',
    authorityId: authority.authorityId,
    machineName: 'QA-PC',
    machineId: 'a'.repeat(64),
    deviceId: deviceId(key),
    provider: 'tpm',
    createdAt: new Date().toISOString(),
    publicKey: { modulus: key.modulus, exponent: key.exponent },
    ...extra,
  }
  const bytes = Buffer.from(JSON.stringify(payload))
  return {
    payload: bytes.toString('base64'),
    signature: crypto
      .sign('sha256', bytes, { key: device, padding: crypto.constants.RSA_PKCS1_PADDING })
      .toString('base64'),
  }
}
test('device proof and issuer signature round trip with an optional expiry', () => {
  const req = verifyRequest(request(), authority)
  for (const expiresAt of [null, new Date(Date.now() + 86400000).toISOString()]) {
    const license = issueLicense(req, issuer, { licensee: 'Approved PC', expiresAt })
    const { bytes, payload, signature } = unpack(license)
    assert.equal(payload.deviceId, req.deviceId)
    assert.equal(payload.expiresAt, expiresAt)
    assert.equal(
      crypto.verify(
        'sha256',
        bytes,
        {
          key: fromPublic(authority),
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        },
        signature,
      ),
      true,
    )
  }
})
test('software binding requires an explicit administrator choice', () => {
  const envelope = request({ provider: 'software' })
  assert.throws(() => verifyRequest(envelope, authority), /--allow-software/)
  assert.equal(verifyRequest(envelope, authority, true).provider, 'software')
})
test('rejects requests for another authority, invalid identity, and altered device IDs', () => {
  for (const extra of [
    { authorityId: '0'.repeat(24) },
    { machineId: 'unknown' },
    { deviceId: 'b'.repeat(64) },
    { provider: 'other' },
  ]) {
    assert.throws(() => verifyRequest(request(extra), authority), /Invalid device/)
  }
})
test('rejects modified request payloads and signatures', () => {
  const envelope = request()
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString())
  payload.machineName = 'MODIFIED'
  assert.throws(
    () =>
      verifyRequest(
        { ...envelope, payload: Buffer.from(JSON.stringify(payload)).toString('base64') },
        authority,
      ),
    /proof/,
  )
  assert.throws(
    () =>
      verifyRequest({ ...envelope, signature: Buffer.alloc(256).toString('base64') }, authority),
    /proof/,
  )
})
test('does not issue expired licenses or blank identities', () => {
  const req = verifyRequest(request(), authority)
  assert.throws(() => issueLicense(req, issuer, { licensee: '' }), /licensee/)
  assert.throws(
    () => issueLicense(req, issuer, { licensee: 'PC', expiresAt: '2020-01-01' }),
    /future/,
  )
})
test('rejects malformed envelopes without accepting algorithm substitution', () => {
  for (const value of [
    null,
    {},
    { payload: '***', signature: 'AAAA' },
    { ...request(), algorithm: 'none' },
  ]) {
    assert.throws(() => verifyRequest(value, authority), /envelope/)
  }
})
