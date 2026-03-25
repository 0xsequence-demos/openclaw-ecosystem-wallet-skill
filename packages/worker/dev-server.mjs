#!/usr/bin/env node

/**
 * Local development server for the relay API.
 *
 * Replaces `wrangler dev` with a plain Node.js HTTP server.
 * Uses in-memory storage instead of Durable Objects — same API,
 * same validation, same behavior (TTL expiry, code gate, etc.).
 *
 * Usage:
 *   node dev-server.mjs [port]
 *   # default: http://localhost:8787
 */

import { createServer } from 'node:http'
import { customAlphabet } from 'nanoid'
import {
  MAX_CODE_ATTEMPTS,
  REQUEST_TTL_SECONDS,
  hexToBytes,
} from '@polygon-agent/shared'

const PORT = parseInt(process.argv[2] || '8787', 10)
const generateRequestId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8)

// --- In-memory relay store (replaces Durable Objects) ---

const relays = new Map()

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i]
  return result === 0
}

function isValidHex(str, byteLength) {
  return new RegExp(`^[0-9a-f]{${byteLength * 2}}$`).test(str)
}

function isValidBase64url(str, maxBytes) {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return false
  return Math.ceil((str.length * 3) / 4) <= maxBytes
}

class InMemoryRelay {
  constructor(cli_pk) {
    this.cli_pk = cli_pk
    this.status = 'pending'
    this.attempts_remaining = MAX_CODE_ATTEMPTS
    this.created_at = Date.now()
    this.wallet_pk = null
    this.nonce = null
    this.ciphertext = null
    this.code_hash = null

    // TTL auto-delete
    this._timer = setTimeout(() => {
      this.destroy()
    }, REQUEST_TTL_SECONDS * 1000)
  }

  destroy() {
    clearTimeout(this._timer)
    // Find and remove from map
    for (const [rid, relay] of relays) {
      if (relay === this) {
        relays.delete(rid)
        break
      }
    }
  }

  getPublicKey() {
    return { cli_pk: this.cli_pk, status: this.status }
  }

  postSession(wallet_pk, nonce, ciphertext, code_hash) {
    if (this.status !== 'pending') return { ok: false, error: 'already_posted' }
    this.wallet_pk = wallet_pk
    this.nonce = nonce
    this.ciphertext = ciphertext
    this.code_hash = code_hash
    this.status = 'ready'
    return { ok: true }
  }

  getStatus() {
    return { status: this.status }
  }

  retrieve(code_hash) {
    if (this.status !== 'ready') return { error: 'not_ready' }

    const submitted = hexToBytes(code_hash)
    const stored = hexToBytes(this.code_hash)

    if (constantTimeEqual(submitted, stored)) {
      const result = {
        wallet_pk: this.wallet_pk,
        nonce: this.nonce,
        ciphertext: this.ciphertext,
      }
      this.destroy()
      return result
    }

    this.attempts_remaining--
    if (this.attempts_remaining <= 0) {
      this.destroy()
      return { error: 'request_expired' }
    }
    return { error: 'invalid_code', attempts_remaining: this.attempts_remaining }
  }
}

// --- HTTP server ---

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString())
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const method = req.method
  const path = url.pathname.replace('/api/relay/', '')

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    })
    return res.end()
  }

  // Only handle /api/relay/* routes
  if (!url.pathname.startsWith('/api/relay/')) {
    return json(res, { message: 'Relay dev server running. API at /api/relay/*' }, 200)
  }

  try {
    // POST /api/relay/request
    if (method === 'POST' && path === 'request') {
      const body = await readBody(req)
      if (!body.cli_pk || !isValidHex(body.cli_pk, 32)) {
        return json(res, { error: 'cli_pk must be 64 hex characters (32 bytes)' }, 400)
      }
      const rid = generateRequestId()
      relays.set(rid, new InMemoryRelay(body.cli_pk))
      return json(res, { request_id: rid }, 201)
    }

    // GET /api/relay/request/:rid
    const getMatch = path.match(/^request\/([a-zA-Z0-9_-]+)$/)
    if (method === 'GET' && getMatch) {
      const relay = relays.get(getMatch[1])
      if (!relay) return json(res, { error: 'not_found' }, 404)
      return json(res, relay.getPublicKey())
    }

    // POST /api/relay/session/:rid
    const sessionMatch = path.match(/^session\/([a-zA-Z0-9_-]+)$/)
    if (method === 'POST' && sessionMatch) {
      const relay = relays.get(sessionMatch[1])
      if (!relay) return json(res, { error: 'not_found' }, 404)

      const body = await readBody(req)
      if (!isValidHex(body.wallet_pk, 32)) return json(res, { error: 'wallet_pk must be 64 hex characters' }, 400)
      if (!isValidHex(body.nonce, 24)) return json(res, { error: 'nonce must be 48 hex characters' }, 400)
      if (!body.ciphertext || !isValidBase64url(body.ciphertext, 8192)) return json(res, { error: 'ciphertext must be valid base64url, max 8KB' }, 400)
      if (!isValidHex(body.code_hash, 32)) return json(res, { error: 'code_hash must be 64 hex characters' }, 400)

      const result = relay.postSession(body.wallet_pk, body.nonce, body.ciphertext, body.code_hash)
      if (!result.ok) return json(res, { error: result.error }, 409)
      return json(res, { ok: true })
    }

    // GET /api/relay/status/:rid
    const statusMatch = path.match(/^status\/([a-zA-Z0-9_-]+)$/)
    if (method === 'GET' && statusMatch) {
      const relay = relays.get(statusMatch[1])
      if (!relay) return json(res, { error: 'not_found' }, 404)
      return json(res, relay.getStatus())
    }

    // POST /api/relay/retrieve/:rid
    const retrieveMatch = path.match(/^retrieve\/([a-zA-Z0-9_-]+)$/)
    if (method === 'POST' && retrieveMatch) {
      const relay = relays.get(retrieveMatch[1])
      if (!relay) return json(res, { error: 'not_found' }, 404)

      const body = await readBody(req)
      if (!isValidHex(body.code_hash, 32)) return json(res, { error: 'code_hash must be 64 hex characters' }, 400)

      const result = relay.retrieve(body.code_hash)
      if ('error' in result) {
        const status = result.error === 'request_expired' ? 410 : 403
        return json(res, result, status)
      }
      return json(res, result)
    }

    json(res, { error: 'not_found' }, 404)
  } catch (err) {
    json(res, { error: err.message }, 500)
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Relay dev server running at http://localhost:${PORT}`)
  console.log(`  ${relays.size} active relays\n`)
  console.log(`  Routes:`)
  console.log(`    POST /api/relay/request          Create request`)
  console.log(`    GET  /api/relay/request/:rid      Get CLI public key`)
  console.log(`    POST /api/relay/session/:rid      Post encrypted session`)
  console.log(`    GET  /api/relay/status/:rid       Poll status`)
  console.log(`    POST /api/relay/retrieve/:rid     Submit code + retrieve`)
  console.log(`\n  TTL: ${REQUEST_TTL_SECONDS}s | Max code attempts: ${MAX_CODE_ATTEMPTS}\n`)
})
