#!/usr/bin/env node

/**
 * Simulate the browser side of the session handoff.
 *
 * Usage:
 *   1. Start the relay:     pnpm dev:worker
 *   2. Start the CLI:       cd cli && node bin/polygon-agent.mjs connect --name test
 *   3. Run this script:     node test/simulate-browser.mjs <rid>
 *
 * The script:
 *   - Fetches the CLI's public key from the relay
 *   - Encrypts a mock session payload
 *   - Posts the ciphertext to the relay
 *   - Prints the 6-digit code for you to enter in the CLI
 */

const RELAY_URL = process.env.POLYGON_AGENT_RELAY_URL || 'http://localhost:8787'

const rid = process.argv[2]
if (!rid) {
  console.error('Usage: node simulate-browser.mjs <request-id>')
  console.error('')
  console.error('  The request ID is shown by the CLI after "Registered: <rid>"')
  process.exit(1)
}

const {
  encryptSession,
  hexToBytes,
} = await import('../shared/dist/index.js')

// 1. Fetch CLI's public key
console.log(`\nFetching CLI public key for request ${rid}...`)
const pkRes = await fetch(`${RELAY_URL}/api/relay/request/${rid}`)
if (!pkRes.ok) {
  console.error(`Request ${rid} not found or expired (${pkRes.status})`)
  process.exit(1)
}
const { cli_pk, status } = await pkRes.json()
console.log(`  CLI public key: ${cli_pk.slice(0, 16)}...`)
console.log(`  Status: ${status}`)

if (status !== 'pending') {
  console.error(`Request is "${status}", expected "pending"`)
  process.exit(1)
}

// 2. Create a mock session payload
const mockSession = {
  version: 1,
  wallet_address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
  chain_id: 137,
  session_private_key: '0x' + 'ab'.repeat(32),
  session_address: '0x1234567890abcdef1234567890abcdef12345678',
  permissions: {
    native_limit: '1000000000000000000',
  },
  expiry: Math.floor(Date.now() / 1000) + 86400,
  ecosystem_wallet_url: 'https://wallet.polygon.technology',
  dapp_origin: 'https://polygon-agent-relay.0xsequence.workers.dev',
  project_access_key: 'demo-access-key',
}

// 3. Encrypt the session
console.log('\nEncrypting session payload...')
const cli_pk_bytes = hexToBytes(cli_pk)
const encrypted = encryptSession(cli_pk_bytes, mockSession, rid)

// 4. Post to relay
console.log('Posting encrypted session to relay...')
const postRes = await fetch(`${RELAY_URL}/api/relay/session/${rid}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    wallet_pk: encrypted.wallet_pk,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    code_hash: encrypted.code_hash,
  }),
})

if (!postRes.ok) {
  const err = await postRes.json().catch(() => ({}))
  console.error(`Failed to post session: ${postRes.status}`, err)
  process.exit(1)
}

console.log('Session posted successfully!\n')
console.log('╔══════════════════════════════════════╗')
console.log(`║  Enter this code in the CLI:  ${encrypted.code_plaintext}  ║`)
console.log('╚══════════════════════════════════════╝')
console.log('')
console.log(`Mock wallet address: ${mockSession.wallet_address}`)
console.log(`Chain: ${mockSession.chain_id} (Polygon)`)
console.log(`Session expires: ${new Date(mockSession.expiry * 1000).toLocaleString()}`)
console.log('')
