#!/usr/bin/env node

/**
 * Relay Integration Test
 *
 * Tests the full session handoff flow against a local worker:
 *   1. CLI registers a request (POST /api/relay/request)
 *   2. Browser fetches CLI public key (GET /api/relay/request/:rid)
 *   3. Browser encrypts session + posts ciphertext (POST /api/relay/session/:rid)
 *   4. CLI polls status (GET /api/relay/status/:rid)
 *   5. CLI submits code + retrieves payload (POST /api/relay/retrieve/:rid)
 *   6. CLI decrypts and verifies session matches original
 *
 * Also tests error cases:
 *   - Wrong code submission (403)
 *   - Attempts exhausted (410)
 *
 * Prerequisites:
 *   - Worker running locally: cd packages/worker && pnpm dev
 *   - Shared package built: cd packages/shared && pnpm build
 *
 * Usage:
 *   cd packages && pnpm test:relay
 *   # or directly:
 *   node test/relay-integration.mjs [relay-url]
 */

const RELAY_URL = process.argv[2] || 'http://localhost:8787'

// Import from built shared package
const {
  generateX25519Keypair,
  encryptSession,
  decryptSession,
  hashCode,
  bytesToHex,
  hexToBytes,
  base64urlToBytes,
} = await import('../shared/dist/index.js')

let passed = 0
let failed = 0

function assert(condition, message) {
  if (condition) {
    passed++
    console.log(`  ✓ ${message}`)
  } else {
    failed++
    console.error(`  ✗ ${message}`)
  }
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${RELAY_URL}${path}`, opts)
  const data = await res.json()
  return { status: res.status, data }
}

// --- Test: Full happy-path round-trip ---

async function testHappyPath() {
  console.log('\n--- Happy Path: Full session handoff ---')

  // 1. CLI generates keypair and registers
  const { secretKey: cli_sk, publicKey: cli_pk } = generateX25519Keypair()
  const cli_pk_hex = bytesToHex(cli_pk)

  const { status: createStatus, data: createData } = await api('POST', '/api/relay/request', {
    cli_pk: cli_pk_hex,
  })
  assert(createStatus === 201, `POST /api/relay/request → 201 (got ${createStatus})`)
  assert(typeof createData.request_id === 'string', `Got request_id: ${createData.request_id}`)
  const rid = createData.request_id

  // 2. Browser fetches CLI public key
  const { status: getStatus, data: getData } = await api('GET', `/api/relay/request/${rid}`)
  assert(getStatus === 200, `GET /api/relay/request/${rid} → 200`)
  assert(getData.cli_pk === cli_pk_hex, 'CLI public key matches')
  assert(getData.status === 'pending', `Status is "pending"`)

  // 3. Browser encrypts session and posts
  const mockSession = {
    version: 1,
    wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
    chain_id: 137,
    session_private_key: '0x' + 'ab'.repeat(32),
    session_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    permissions: { native_limit: '1000000000000000000' },
    expiry: Math.floor(Date.now() / 1000) + 86400,
    ecosystem_wallet_url: 'https://wallet.polygon.technology',
  dapp_origin: 'https://polygon-agent-relay.0xsequence.workers.dev',
    project_access_key: 'test-key',
  }

  const encrypted = encryptSession(cli_pk, mockSession, rid)
  assert(encrypted.code_plaintext.length === 6, `Generated 6-digit code: ${encrypted.code_plaintext}`)

  const { status: postStatus } = await api('POST', `/api/relay/session/${rid}`, {
    wallet_pk: encrypted.wallet_pk,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    code_hash: encrypted.code_hash,
  })
  assert(postStatus === 200, `POST /api/relay/session/${rid} → 200`)

  // 4. CLI polls status
  const { status: pollStatus, data: pollData } = await api('GET', `/api/relay/status/${rid}`)
  assert(pollStatus === 200, `GET /api/relay/status/${rid} → 200`)
  assert(pollData.status === 'ready', 'Status is "ready"')

  // 5. CLI submits code and retrieves
  const code_hash = hashCode(rid, encrypted.code_plaintext)
  const { status: retrieveStatus, data: retrieveData } = await api(
    'POST',
    `/api/relay/retrieve/${rid}`,
    { code_hash },
  )
  assert(retrieveStatus === 200, `POST /api/relay/retrieve/${rid} → 200`)
  assert(retrieveData.wallet_pk === encrypted.wallet_pk, 'wallet_pk matches')
  assert(retrieveData.nonce === encrypted.nonce, 'nonce matches')
  assert(retrieveData.ciphertext === encrypted.ciphertext, 'ciphertext matches')

  // 6. CLI decrypts
  const session = decryptSession(
    cli_sk,
    cli_pk,
    hexToBytes(retrieveData.wallet_pk),
    hexToBytes(retrieveData.nonce),
    base64urlToBytes(retrieveData.ciphertext),
    encrypted.code_plaintext,
  )
  assert(session.wallet_address === mockSession.wallet_address, 'Decrypted wallet_address matches')
  assert(session.chain_id === mockSession.chain_id, 'Decrypted chain_id matches')
  assert(session.session_private_key === mockSession.session_private_key, 'Decrypted session key matches')

  // 7. Verify request is consumed (second retrieve should 404)
  const { status: gone } = await api('POST', `/api/relay/retrieve/${rid}`, { code_hash })
  assert(gone === 404, `Second retrieve → 404 (request consumed, got ${gone})`)
}

// --- Test: Wrong code → 403, then exhaustion → 410 ---

async function testWrongCode() {
  console.log('\n--- Error Path: Wrong code + exhaustion ---')

  const { secretKey: cli_sk, publicKey: cli_pk } = generateX25519Keypair()

  const { data: createData } = await api('POST', '/api/relay/request', {
    cli_pk: bytesToHex(cli_pk),
  })
  const rid = createData.request_id

  const mockSession = {
    version: 1,
    wallet_address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    chain_id: 137,
    session_private_key: '0x' + 'cd'.repeat(32),
    session_address: '0x1111111111111111111111111111111111111111',
    permissions: {},
    expiry: Math.floor(Date.now() / 1000) + 86400,
    ecosystem_wallet_url: 'https://wallet.polygon.technology',
  dapp_origin: 'https://polygon-agent-relay.0xsequence.workers.dev',
    project_access_key: 'test-key',
  }

  const encrypted = encryptSession(cli_pk, mockSession, rid)
  await api('POST', `/api/relay/session/${rid}`, {
    wallet_pk: encrypted.wallet_pk,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    code_hash: encrypted.code_hash,
  })

  // Submit wrong code 3 times
  const wrongHash = hashCode(rid, '000000')

  const { status: s1, data: d1 } = await api('POST', `/api/relay/retrieve/${rid}`, {
    code_hash: wrongHash,
  })
  assert(s1 === 403, `Wrong code attempt 1 → 403 (got ${s1})`)
  assert(d1.attempts_remaining === 2, `2 attempts remaining (got ${d1.attempts_remaining})`)

  const { status: s2, data: d2 } = await api('POST', `/api/relay/retrieve/${rid}`, {
    code_hash: wrongHash,
  })
  assert(s2 === 403, `Wrong code attempt 2 → 403 (got ${s2})`)
  assert(d2.attempts_remaining === 1, `1 attempt remaining (got ${d2.attempts_remaining})`)

  const { status: s3 } = await api('POST', `/api/relay/retrieve/${rid}`, {
    code_hash: wrongHash,
  })
  assert(s3 === 410, `Wrong code attempt 3 → 410 expired (got ${s3})`)

  // Request should be gone
  const { status: s4 } = await api('GET', `/api/relay/status/${rid}`)
  assert(s4 === 404, `Request deleted after exhaustion → 404 (got ${s4})`)
}

// --- Test: Validation errors ---

async function testValidation() {
  console.log('\n--- Validation: Bad inputs ---')

  const { status: s1 } = await api('POST', '/api/relay/request', { cli_pk: 'not-hex' })
  assert(s1 === 400, `Bad cli_pk → 400 (got ${s1})`)

  const { status: s2 } = await api('POST', '/api/relay/request', { cli_pk: 'ab'.repeat(16) })
  assert(s2 === 400, `Short cli_pk (16 bytes) → 400 (got ${s2})`)

  const { status: s3 } = await api('GET', '/api/relay/request/nonexistent')
  assert(s3 === 404, `Nonexistent request → 404 (got ${s3})`)
}

// --- Run all tests ---

console.log(`\nRelay Integration Tests — ${RELAY_URL}`)
console.log('='.repeat(50))

try {
  await testHappyPath()
  await testWrongCode()
  await testValidation()
} catch (err) {
  console.error('\n✗ Test crashed:', err.message)
  failed++
}

console.log('\n' + '='.repeat(50))
console.log(`Results: ${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
} else {
  console.log('\n✓ All tests passed!\n')
}
