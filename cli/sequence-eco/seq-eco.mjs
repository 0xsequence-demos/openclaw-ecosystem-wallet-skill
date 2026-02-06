#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

import keytar from 'keytar'
import nacl from 'tweetnacl'
import sealedbox from 'tweetnacl-sealedbox-js'

const SERVICE = 'openclaw.sequence-ecosystem'

function installFetchLogger() {
  const enabled = ['1', 'true', 'yes'].includes(String(process.env.SEQ_ECO_DEBUG_FETCH || '').toLowerCase())
  if (!enabled) return

  const logPath =
    process.env.SEQ_ECO_FETCH_LOG_PATH ||
    path.join(os.homedir(), '.openclaw', 'workspace', 'tmp', 'seq-eco-fetch.log')

  fs.mkdirSync(path.dirname(logPath), { recursive: true })

  const origFetch = globalThis.fetch
  if (typeof origFetch !== 'function') {
    throw new Error('globalThis.fetch is not available; cannot install fetch logger')
  }

  const redact = (s) =>
    String(s)
      // avoid leaking huge payloads into logs
      .slice(0, 4000)

  const log = (line) => {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  }

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url
    const method = init?.method || 'GET'
    const bodyPreview = init?.body ? redact(init.body) : ''

    log(`→ ${method} ${url}`)
    if (bodyPreview) log(`  req.body=${bodyPreview}`)

    try {
      const res = await origFetch(input, init)

      // clone so downstream can still read the body
      let resText = ''
      try {
        resText = redact(await res.clone().text())
      } catch (e) {
        resText = `[unreadable body: ${e instanceof Error ? e.message : String(e)}]`
      }

      log(`← ${res.status} ${method} ${url}`)
      if (resText) log(`  res.body=${resText}`)

      return res
    } catch (e) {
      log(`✖ fetch threw: ${method} ${url} :: ${e instanceof Error ? e.stack || e.message : String(e)}`)
      throw e
    }
  }

  // If we already provided window.fetch shim, keep it wired to the wrapped fetch.
  if (globalThis.window) globalThis.window.fetch = globalThis.fetch

  log(`fetch logger enabled (SEQ_ECO_DEBUG_FETCH); logPath=${logPath}`)
}

function usage() {
  console.log(`Usage:
  seq-eco.mjs create-request --name <walletName> [--chain polygon] [--webhook] [--usdc-to <address> --usdc-amount <amount>]
  seq-eco.mjs ingest-session --name <walletName> --rid <rid> --ciphertext '<b64url>'

  seq-eco.mjs wallets
  seq-eco.mjs wallet-remove --name <walletName> --yes

  seq-eco.mjs address --name <walletName>
  seq-eco.mjs balances --name <walletName> [--chain polygon]
  seq-eco.mjs send-pol --name <walletName> --to <address> --amount <pol> [--broadcast]
  seq-eco.mjs send-usdc --name <walletName> --to <address> --amount <usdc> [--broadcast]
  seq-eco.mjs config-update --name <walletName> [--broadcast]

Env:
- SEQUENCE_ECOSYSTEM_CONNECTOR_URL=https://<your-worker>.workers.dev
- SEQ_ECO_DEFAULT_WEBHOOK=true (optional; make create-request use ngrok callback by default)
- SEQUENCE_INDEXER_ACCESS_KEY=... (required for balances)

Keychain service: ${SERVICE}
- explicitSession:<name> (full explicit session JSON)
- sessionPk:<name> (explicit session pk)
- implicitPk:<name>
- implicitAttestation:<name>
- implicitIdentitySig:<name>
- wallet:<name>
- chain:<name>
`)
}

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function b64urlDecode(str) {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4))
  return Buffer.from(norm + pad, 'base64')
}

function randomId(bytes = 16) {
  return b64urlEncode(nacl.randomBytes(bytes))
}

function defaultNodesUrl(_projectAccessKey) {
  // Pass the base node gateway URL; dapp-client/viem will append `/{network}/{projectAccessKey}`.
  // If we embed the key here, it can get appended twice.
  return 'https://nodes.sequence.app/{network}'
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function requestsDir() {
  return path.join(os.homedir(), '.openclaw', 'state', 'sequence-ecosystem', 'requests')
}

function walletsRegistryPath() {
  return path.join(os.homedir(), '.openclaw', 'state', 'sequence-ecosystem', 'wallets.json')
}

function loadWalletsRegistry() {
  const fp = walletsRegistryPath()
  if (!fs.existsSync(fp)) return { wallets: {} }
  return JSON.parse(fs.readFileSync(fp, 'utf8'))
}

function saveWalletsRegistry(reg) {
  const fp = walletsRegistryPath()
  ensureDir(path.dirname(fp))
  fs.writeFileSync(fp, JSON.stringify(reg, null, 2), { mode: 0o600 })
}

function writePrivateRequest(rid, obj) {
  const dir = requestsDir()
  ensureDir(dir)
  const fp = path.join(dir, `${rid}.json`)
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2), { mode: 0o600 })
  return fp
}

function readPrivateRequest(rid) {
  const fp = path.join(requestsDir(), `${rid}.json`)
  if (!fs.existsSync(fp)) throw new Error(`Missing request state for rid=${rid} at ${fp}`)
  return { fp, obj: JSON.parse(fs.readFileSync(fp, 'utf8')) }
}

function deletePrivateRequest(rid) {
  const fp = path.join(requestsDir(), `${rid}.json`)
  if (fs.existsSync(fp)) fs.unlinkSync(fp)
}

function getArg(args, k) {
  const i = args.indexOf(k)
  if (i === -1) return null
  return args[i + 1] ?? null
}

function normalizeChain(raw) {
  const c = String(raw || '').toLowerCase()
  if (!c) return 'polygon'
  if (c === 'matic') return 'polygon'
  return c
}

function indexerUrl(chain) {
  // Polygon only for now
  return process.env.SEQUENCE_INDEXER_URL || 'https://polygon-indexer.sequence.app/rpc/Indexer/GetTokenBalancesSummary'
}

function explorerBase(chain) {
  return 'https://polygonscan.com/tx/'
}

function isValidB64UrlString(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s)
}

function jsonResponse(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // CORS: the connector UI will POST from a browser context
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  })
  res.end(body)
}

async function startOneShotWebhook() {
  // One-shot local webhook. Strictly validates payload; stores nothing on disk.
  const token = randomId(24)
  const pathName = `/seq-eco/${token}`

  let resolvePayload
  let rejectPayload
  const payloadPromise = new Promise((resolve, reject) => {
    resolvePayload = resolve
    rejectPayload = reject
  })

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')

      if (req.method === 'OPTIONS') {
        // CORS preflight
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600'
        })
        res.end()
        return
      }

      if (req.method !== 'POST') {
        jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }

      if (url.pathname !== pathName) {
        jsonResponse(res, 404, { ok: false, error: 'not_found' })
        return
      }

      const ct = String(req.headers['content-type'] || '')
      if (!ct.toLowerCase().startsWith('application/json')) {
        jsonResponse(res, 415, { ok: false, error: 'unsupported_media_type' })
        return
      }

      // Hard cap body size to reduce attack surface
      const MAX = 32 * 1024
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        const b = Buffer.from(chunk)
        size += b.length
        if (size > MAX) {
          jsonResponse(res, 413, { ok: false, error: 'payload_too_large' })
          return
        }
        chunks.push(b)
      }

      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        jsonResponse(res, 400, { ok: false, error: 'invalid_json' })
        return
      }

      // Strict schema: exactly { rid, ciphertext }
      const keys = body && typeof body === 'object' ? Object.keys(body).sort() : []
      if (keys.join(',') !== 'ciphertext,rid') {
        jsonResponse(res, 400, { ok: false, error: 'invalid_schema' })
        return
      }

      const { rid, ciphertext } = body

      if (!isValidB64UrlString(rid) || rid.length < 10 || rid.length > 128) {
        jsonResponse(res, 400, { ok: false, error: 'invalid_rid' })
        return
      }

      if (!isValidB64UrlString(ciphertext) || ciphertext.length < 200 || ciphertext.length > 200000) {
        jsonResponse(res, 400, { ok: false, error: 'invalid_ciphertext' })
        return
      }

      jsonResponse(res, 200, { ok: true })
      resolvePayload({ rid, ciphertext })
    } catch (e) {
      // Fail closed
      try {
        jsonResponse(res, 500, { ok: false, error: 'internal_error' })
      } catch {}
      rejectPayload(e)
    }
  })

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.on('error', reject)
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  if (!port) throw new Error('Failed to allocate webhook port')

  return {
    server,
    port,
    pathName,
    token,
    payloadPromise
  }
}

async function startNgrokHttpTunnel(port) {
  // Uses ngrok's local API at 127.0.0.1:4040 to discover the public URL.
  // Requires ngrok to be installed + authenticated on this machine.
  const child = spawn('ngrok', ['http', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  })

  const logs = []
  const onData = (buf) => {
    const s = String(buf || '').trim()
    if (s) logs.push(s.slice(0, 400))
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const deadline = Date.now() + 15000
  let publicUrl = null

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      const res = await fetch('http://127.0.0.1:4040/api/tunnels')
      if (!res.ok) continue
      const data = await res.json()
      const tunnels = Array.isArray(data?.tunnels) ? data.tunnels : []
      const https = tunnels.find((t) => String(t?.public_url || '').startsWith('https://'))
      if (https?.public_url) {
        publicUrl = https.public_url
        break
      }
    } catch {
      // ignore until api is ready
    }
  }

  if (!publicUrl) {
    try { child.kill('SIGTERM') } catch {}
    throw new Error(`Failed to establish ngrok tunnel (logs: ${logs.slice(-5).join(' | ')})`)
  }

  return { child, publicUrl }
}

function formatUnits(raw, decimals) {
  const s = String(raw || '0')
  const neg = s.startsWith('-')
  const v = neg ? s.slice(1) : s
  const padded = v.padStart(decimals + 1, '0')
  const i = padded.slice(0, -decimals)
  const f = padded.slice(-decimals).replace(/0+$/, '')
  return `${neg ? '-' : ''}${i}${f ? '.' + f : ''}`
}

async function ingestSessionFromCiphertext({ name, rid, ciphertext }) {
  if (!rid) throw new Error('Missing rid')
  if (!ciphertext) throw new Error('Missing ciphertext')

  const { obj } = readPrivateRequest(rid)
  const chain = normalizeChain(obj.chain || 'polygon')

  if (obj.walletName !== name) {
    throw new Error(`Request rid=${rid} was created for walletName=${obj.walletName}, not ${name}`)
  }

  const exp = Date.parse(obj.expiresAt)
  if (Number.isFinite(exp) && Date.now() > exp) {
    throw new Error(`Request rid=${rid} is expired (expiresAt=${obj.expiresAt}). Create a new request.`)
  }

  const privKey = b64urlDecode(obj.privateKeyB64u)
  const pubKey = b64urlDecode(obj.publicKeyB64u)
  const cipherBytes = b64urlDecode(ciphertext)

  const opened = sealedbox.open(cipherBytes, pubKey, privKey)
  if (!opened) throw new Error('Failed to decrypt ciphertext')

  const decrypted = Buffer.from(opened).toString('utf8')

  let payload
  try {
    const { jsonRevivers } = await import('@0xsequence/dapp-client')
    payload = JSON.parse(decrypted, jsonRevivers)
  } catch {
    payload = JSON.parse(decrypted)
  }

  const walletAddress = payload.walletAddress
  const chainId = payload.chainId
  const explicitSession = payload.explicitSession
  const implicit = payload.implicit

  if (!walletAddress || typeof walletAddress !== 'string') throw new Error('Missing walletAddress in payload')
  if (chainId !== 137) throw new Error(`Unexpected chainId ${chainId} (expected 137 for Polygon)`) 
  if (!explicitSession || typeof explicitSession !== 'object') throw new Error('Missing explicitSession in payload')
  if (!explicitSession.pk || typeof explicitSession.pk !== 'string') throw new Error('Missing explicitSession.pk in payload')
  if (!implicit?.pk || !implicit?.attestation || !implicit?.identitySignature) throw new Error('Missing implicit session in payload')

  const implicitMeta = {
    guard: implicit.guard,
    loginMethod: implicit.loginMethod,
    userEmail: implicit.userEmail
  }

  const { jsonReplacers } = await import('@0xsequence/dapp-client')
  await keytar.setPassword(SERVICE, `explicitSession:${name}`, JSON.stringify(explicitSession, jsonReplacers))
  await keytar.setPassword(SERVICE, `sessionPk:${name}`, explicitSession.pk)
  await keytar.setPassword(SERVICE, `implicitPk:${name}`, implicit.pk)
  await keytar.setPassword(SERVICE, `implicitMeta:${name}`, JSON.stringify(implicitMeta, jsonReplacers))

  await keytar.setPassword(SERVICE, `implicitAttestation:${name}`, JSON.stringify(implicit.attestation, jsonReplacers))
  await keytar.setPassword(SERVICE, `implicitIdentitySig:${name}`, JSON.stringify(implicit.identitySignature, jsonReplacers))

  await keytar.setPassword(SERVICE, `wallet:${name}`, walletAddress)
  await keytar.setPassword(SERVICE, `chain:${name}`, chain)

  deletePrivateRequest(rid)

  const reg = loadWalletsRegistry()
  if (!reg.wallets) reg.wallets = {}
  reg.wallets[name] = { name, chain, walletAddress, updatedAt: new Date().toISOString() }
  saveWalletsRegistry(reg)

  return { walletName: name, chain, rid, walletAddress }
}

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage()
    process.exit(0)
  }

  if (cmd === 'wallets') {
    const reg = loadWalletsRegistry()
    const wallets = Object.values(reg.wallets || {}).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    console.log(JSON.stringify({ ok: true, wallets }, null, 2))
    return
  }

  const name = getArg(args, '--name')

  if (cmd === 'wallet-remove') {
    if (!name) throw new Error('Missing --name')
    if (!args.includes('--yes')) throw new Error('Refusing to delete without --yes')

    await keytar.deletePassword(SERVICE, `explicitSession:${name}`)
    await keytar.deletePassword(SERVICE, `sessionPk:${name}`)
    await keytar.deletePassword(SERVICE, `implicitPk:${name}`)
    await keytar.deletePassword(SERVICE, `implicitAttestation:${name}`)
    await keytar.deletePassword(SERVICE, `implicitIdentitySig:${name}`)
    await keytar.deletePassword(SERVICE, `wallet:${name}`)
    await keytar.deletePassword(SERVICE, `chain:${name}`)

    const reg = loadWalletsRegistry()
    if (reg.wallets && reg.wallets[name]) {
      delete reg.wallets[name]
      saveWalletsRegistry(reg)
    }

    console.log(JSON.stringify({ ok: true, removed: name }, null, 2))
    return
  }

  if (!name) throw new Error('Missing --name <walletName>')

  if (cmd === 'create-request') {
    const chain = normalizeChain(getArg(args, '--chain') || 'polygon')
    const baseUrl = process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL
    if (!baseUrl) throw new Error('Missing SEQUENCE_ECOSYSTEM_CONNECTOR_URL env var')

    const useWebhook = args.includes('--webhook') || ['1', 'true', 'yes'].includes(String(process.env.SEQ_ECO_DEFAULT_WEBHOOK || '').toLowerCase())

    const rid = randomId(16)
    const kp = nacl.box.keyPair()
    const pub = b64urlEncode(kp.publicKey)
    const priv = b64urlEncode(kp.secretKey)

    const createdAt = new Date().toISOString()
    // Give plenty of time to complete the connect flow.
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

    const statePath = writePrivateRequest(rid, {
      rid,
      walletName: name,
      chain,
      createdAt,
      expiresAt,
      publicKeyB64u: pub,
      privateKeyB64u: priv
    })

    const url = new URL(baseUrl)
    url.pathname = url.pathname.replace(/\/$/, '') + '/link'
    url.searchParams.set('rid', rid)
    url.searchParams.set('wallet', name)
    url.searchParams.set('pub', pub)
    url.searchParams.set('chain', chain)

    const usdcTo = getArg(args, '--usdc-to')
    const usdcAmount = getArg(args, '--usdc-amount')
    if (usdcTo || usdcAmount) {
      if (!usdcTo || !usdcAmount) throw new Error('create-request: must provide both --usdc-to and --usdc-amount')
      url.searchParams.set('erc20', 'usdc')
      url.searchParams.set('erc20To', usdcTo)
      url.searchParams.set('erc20Amount', usdcAmount)
    }

    if (!useWebhook) {
      console.log(JSON.stringify({ ok: true, walletName: name, chain, rid, url: url.toString(), expiresAt, storedState: statePath }, null, 2))
      return
    }

    // Webhook mode: spin up a strict one-shot local endpoint and expose it via ngrok.
    const webhook = await startOneShotWebhook()
    let ngrok = null

    const cleanup = () => {
      try { webhook.server.close() } catch {}
      try { ngrok?.child?.kill('SIGTERM') } catch {}
    }

    process.on('SIGINT', () => {
      cleanup()
      process.exit(130)
    })

    try {
      ngrok = await startNgrokHttpTunnel(webhook.port)
      const callbackUrl = `${ngrok.publicUrl}${webhook.pathName}`
      url.searchParams.set('callbackUrl', callbackUrl)

      console.log(JSON.stringify({
        ok: true,
        walletName: name,
        chain,
        rid,
        url: url.toString(),
        callbackUrl,
        expiresAt,
        storedState: statePath,
        note: 'Waiting for connector UI to POST ciphertext to callbackUrl...'
      }, null, 2))

      const timeoutMs = 2 * 60 * 60 * 1000
      const t = setTimeout(() => {
        cleanup()
        throw new Error('Timed out waiting for webhook callback')
      }, timeoutMs)

      const payload = await webhook.payloadPromise
      clearTimeout(t)

      if (payload.rid !== rid) {
        throw new Error(`Webhook rid mismatch (expected ${rid}, got ${payload.rid})`)
      }

      const result = await ingestSessionFromCiphertext({ name, rid, ciphertext: payload.ciphertext })
      console.log(JSON.stringify({ ok: true, mode: 'webhook', ...result }, null, 2))
    } finally {
      cleanup()
    }

    return
  }

  if (cmd === 'ingest-session') {
    const ciphertext = getArg(args, '--ciphertext')
    const rid = getArg(args, '--rid')
    if (!rid) throw new Error('Missing --rid')
    if (!ciphertext) throw new Error('Missing --ciphertext')

    const result = await ingestSessionFromCiphertext({ name, rid, ciphertext })
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
    return
  }

  if (cmd === 'address') {
    const walletAddress = await keytar.getPassword(SERVICE, `wallet:${name}`)
    if (!walletAddress) throw new Error(`Missing wallet address in Keychain: wallet:${name}`)
    console.log(JSON.stringify({ ok: true, walletName: name, walletAddress }, null, 2))
    return
  }

  if (cmd === 'balances') {
    const walletAddress = await keytar.getPassword(SERVICE, `wallet:${name}`)
    if (!walletAddress) throw new Error(`Missing wallet address in Keychain: wallet:${name}`)

    const idxKey = process.env.SEQUENCE_INDEXER_ACCESS_KEY
    if (!idxKey) throw new Error('Missing SEQUENCE_INDEXER_ACCESS_KEY env var')

    const res = await fetch(indexerUrl('polygon'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Key': idxKey
      },
      body: JSON.stringify({
        chainID: 'polygon',
        omitMetadata: false,
        filter: { contractStatus: 'VERIFIED', accountAddresses: [walletAddress] }
      })
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Indexer error: ${res.status} ${text}`)
    }

    const json = await res.json()
    const native = (json.nativeBalances || []).map((b) => ({
      type: 'native',
      symbol: b.symbol || b.name || 'NATIVE',
      balance: formatUnits(b.balance || '0', 18)
    }))

    const erc20 = (json.balances || []).map((b) => ({
      type: 'erc20',
      symbol: b.contractInfo?.symbol || 'ERC20',
      contractAddress: b.contractAddress,
      balance: formatUnits(b.balance || '0', b.contractInfo?.decimals ?? 0)
    }))

    console.log(JSON.stringify({ ok: true, walletName: name, walletAddress, balances: [...native, ...erc20] }, null, 2))
    return
  }

  const DEFAULT_WALLET_URL = 'https://acme-wallet.ecosystem-demo.xyz'

  if (cmd === 'config-update') {
    const broadcast = args.includes('--broadcast')

    const walletAddress = await keytar.getPassword(SERVICE, `wallet:${name}`)
    const explicitRaw = await keytar.getPassword(SERVICE, `explicitSession:${name}`)
    const implicitPkRaw = await keytar.getPassword(SERVICE, `implicitPk:${name}`)
    const implicitAttRaw = await keytar.getPassword(SERVICE, `implicitAttestation:${name}`)
    const implicitSigRaw = await keytar.getPassword(SERVICE, `implicitIdentitySig:${name}`)
    const implicitMetaRaw = await keytar.getPassword(SERVICE, `implicitMeta:${name}`)

    if (!walletAddress) throw new Error(`Missing wallet address in Keychain: wallet:${name}`)
    if (!explicitRaw) throw new Error(`Missing explicit session in Keychain: explicitSession:${name}`)

    const projectAccessKey = process.env.SEQUENCE_PROJECT_ACCESS_KEY
    if (!projectAccessKey) throw new Error('Missing SEQUENCE_PROJECT_ACCESS_KEY env var')

    const walletUrl = process.env.SEQUENCE_ECOSYSTEM_WALLET_URL || DEFAULT_WALLET_URL
    const dappOrigin = process.env.SEQUENCE_DAPP_ORIGIN || process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL || ''
    if (!dappOrigin) throw new Error('Missing SEQUENCE_DAPP_ORIGIN (should match the connector UI origin)')

    const { DappClient, TransportMode, jsonRevivers } = await import('@0xsequence/dapp-client')

    const explicitSession = JSON.parse(explicitRaw, jsonRevivers)

    class KeychainSequenceStorage {
      constructor() {
        this.pendingRedirect = false
        this.tempSessionPk = null
        this.pendingRequest = null
        this.explicitSessions = [{
          pk: explicitSession.pk,
          walletAddress: explicitSession.walletAddress || walletAddress,
          chainId: 137,
          loginMethod: explicitSession.loginMethod,
          userEmail: explicitSession.userEmail,
          guard: explicitSession.guard
        }]
        this.implicitSession = null
      }

      async setPendingRedirectRequest(isPending) { this.pendingRedirect = !!isPending }
      async isRedirectRequestPending() { return !!this.pendingRedirect }
      async saveTempSessionPk(pk) { this.tempSessionPk = pk }
      async getAndClearTempSessionPk() { const v = this.tempSessionPk; this.tempSessionPk = null; return v }
      async savePendingRequest(context) { this.pendingRequest = context }
      async getAndClearPendingRequest() { const v = this.pendingRequest; this.pendingRequest = null; return v }
      async peekPendingRequest() { return this.pendingRequest }

      async saveExplicitSession(sessionData) { this.explicitSessions = [sessionData] }
      async getExplicitSessions() { return [...this.explicitSessions] }
      async clearExplicitSessions() { this.explicitSessions = [] }

      async saveImplicitSession(sessionData) { this.implicitSession = sessionData }
      async getImplicitSession() { return this.implicitSession }
      async clearImplicitSession() { this.implicitSession = null }

      async saveSessionlessConnection(sessionData) { this.sessionlessConnection = sessionData }
      async getSessionlessConnection() { return this.sessionlessConnection ?? null }
      async clearSessionlessConnection() { this.sessionlessConnection = null }

      async saveSessionlessConnectionSnapshot(sessionData) { this.sessionlessConnectionSnapshot = sessionData }
      async getSessionlessConnectionSnapshot() { return this.sessionlessConnectionSnapshot ?? null }
      async clearSessionlessConnectionSnapshot() { this.sessionlessConnectionSnapshot = null }

      async clearAllData() {
        this.pendingRedirect = false
        this.tempSessionPk = null
        this.pendingRequest = null
        this.explicitSessions = []
        this.implicitSession = null
        this.sessionlessConnection = null
        this.sessionlessConnectionSnapshot = null
      }
    }

    class MapSessionStorage {
      constructor() { this.kv = new Map() }
      async getItem(k) { return this.kv.has(k) ? this.kv.get(k) : null }
      async setItem(k, v) { this.kv.set(k, v) }
      async removeItem(k) { this.kv.delete(k) }
    }

    const sequenceStorage = new KeychainSequenceStorage()
    const sequenceSessionStorage = new MapSessionStorage()

    if (implicitPkRaw && implicitAttRaw && implicitSigRaw) {
      const implicitAttestation = JSON.parse(implicitAttRaw, jsonRevivers)
      const implicitIdentitySignature = JSON.parse(implicitSigRaw, jsonRevivers)
      const meta = implicitMetaRaw ? JSON.parse(implicitMetaRaw, jsonRevivers) : {}
      await sequenceStorage.saveImplicitSession({
        pk: implicitPkRaw,
        walletAddress: explicitSession.walletAddress || walletAddress,
        attestation: implicitAttestation,
        identitySignature: implicitIdentitySignature,
        chainId: 137,
        loginMethod: meta.loginMethod,
        userEmail: meta.userEmail,
        guard: meta.guard
      })
    }

    if (!globalThis.window) globalThis.window = { fetch: globalThis.fetch }
    else if (!globalThis.window.fetch) globalThis.window.fetch = globalThis.fetch

    installFetchLogger()

    const keymachineUrl = process.env.SEQUENCE_KEYMACHINE_URL || 'https://keymachine.sequence.app'
    const nodesUrl = process.env.SEQUENCE_NODES_URL || defaultNodesUrl(projectAccessKey)
    const relayerUrl = process.env.SEQUENCE_RELAYER_URL || 'https://{network}-relayer.sequence.app'

    const client = new DappClient(walletUrl, dappOrigin, projectAccessKey, {
      transportMode: TransportMode.REDIRECT,
      keymachineUrl,
      nodesUrl,
      relayerUrl,
      sequenceStorage,
      sequenceSessionStorage,
      canUseIndexedDb: false
    })

    await client.initialize()

    // Minimal call: forwardValue(walletAddress, 0) to force wallet to build against an updated config.
    const forwardTo = '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca'
    const selector = '0x15dacbea' // forwardValue(address,uint256)
    const pad = (hex, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0')
    const data = selector + pad(walletAddress) + pad('0x0')
    const transactions = [{ to: forwardTo, value: 0n, data }]

    if (!broadcast) {
      console.log(JSON.stringify({ ok: true, dryRun: true, walletName: name, walletAddress, kind: 'config-update', transactions }, null, 2))
      return
    }

    // Force config updates while building the envelope (dapp-client hardcodes noConfigUpdate:true)
    const mgr = client.getChainSessionManager(137)
    const origPrepare = mgr.wallet.prepareTransaction.bind(mgr.wallet)
    mgr.wallet.prepareTransaction = async (provider, calls, opts) => {
      return await origPrepare(provider, calls, { ...(opts || {}), noConfigUpdate: false })
    }

    const feeOptions = await client.getFeeOptions(137, transactions)
    const feeOpt =
      (feeOptions || []).find((o) => !o?.token?.contractAddress || o?.token?.contractAddress === '0x0000000000000000000000000000000000000000') ||
      feeOptions?.[0]
    const txHash = await client.sendTransaction(137, transactions, feeOpt)

    console.log(JSON.stringify({ ok: true, walletName: name, walletAddress, kind: 'config-update', txHash, explorerUrl: `${explorerBase('polygon')}${txHash}` }, null, 2))
    return
  }

  const runDappClientTx = async ({
    name,
    walletName,
    chainId,
    walletUrl,
    projectAccessKey,
    dappOrigin,
    transactions,
    broadcast,
    preferNativeFee
  }) => {
    const walletAddress = await keytar.getPassword(SERVICE, `wallet:${walletName}`)
    const explicitRaw = await keytar.getPassword(SERVICE, `explicitSession:${walletName}`)
    const implicitPkRaw = await keytar.getPassword(SERVICE, `implicitPk:${walletName}`)
    const implicitAttRaw = await keytar.getPassword(SERVICE, `implicitAttestation:${walletName}`)
    const implicitSigRaw = await keytar.getPassword(SERVICE, `implicitIdentitySig:${walletName}`)
    const implicitMetaRaw = await keytar.getPassword(SERVICE, `implicitMeta:${walletName}`)

    if (!walletAddress) throw new Error(`Missing wallet address in Keychain: wallet:${walletName}`)
    if (!explicitRaw) throw new Error(`Missing explicit session in Keychain: explicitSession:${walletName}`)

    const { DappClient, TransportMode, jsonRevivers } = await import('@0xsequence/dapp-client')

    const explicitSession = JSON.parse(explicitRaw, jsonRevivers)
    if (!explicitSession?.pk) throw new Error('Stored explicit session is missing pk; re-link wallet')

    // Keychain-backed storage modeled after wallet-dapp-client-cli
    class KeychainSequenceStorage {
      constructor() {
        this.pendingRedirect = false
        this.tempSessionPk = null
        this.pendingRequest = null
        this.explicitSessions = [{
          pk: explicitSession.pk,
          walletAddress: explicitSession.walletAddress || walletAddress,
          chainId,
          loginMethod: explicitSession.loginMethod,
          userEmail: explicitSession.userEmail,
          guard: explicitSession.guard
        }]
        this.implicitSession = null
      }
      async setPendingRedirectRequest(isPending) { this.pendingRedirect = !!isPending }
      async isRedirectRequestPending() { return !!this.pendingRedirect }
      async saveTempSessionPk(pk) { this.tempSessionPk = pk }
      async getAndClearTempSessionPk() { const v = this.tempSessionPk; this.tempSessionPk = null; return v }
      async savePendingRequest(context) { this.pendingRequest = context }
      async getAndClearPendingRequest() { const v = this.pendingRequest; this.pendingRequest = null; return v }
      async peekPendingRequest() { return this.pendingRequest }
      async saveExplicitSession(sessionData) {
        this.explicitSessions = [...this.explicitSessions.filter(s => !(s.walletAddress === sessionData.walletAddress && s.pk === sessionData.pk && s.chainId === sessionData.chainId)), sessionData]
      }
      async getExplicitSessions() { return [...this.explicitSessions] }
      async clearExplicitSessions() { this.explicitSessions = [] }
      async saveImplicitSession(sessionData) { this.implicitSession = sessionData }
      async getImplicitSession() { return this.implicitSession }
      async clearImplicitSession() { this.implicitSession = null }
      async saveSessionlessConnection(sessionData) { this.sessionlessConnection = sessionData }
      async getSessionlessConnection() { return this.sessionlessConnection ?? null }
      async clearSessionlessConnection() { this.sessionlessConnection = null }
      async saveSessionlessConnectionSnapshot(sessionData) { this.sessionlessConnectionSnapshot = sessionData }
      async getSessionlessConnectionSnapshot() { return this.sessionlessConnectionSnapshot ?? null }
      async clearSessionlessConnectionSnapshot() { this.sessionlessConnectionSnapshot = null }
      async clearAllData() {}
    }
    class MapSessionStorage {
      constructor() { this.kv = new Map() }
      async getItem(k) { return this.kv.has(k) ? this.kv.get(k) : null }
      async setItem(k, v) { this.kv.set(k, v) }
      async removeItem(k) { this.kv.delete(k) }
    }

    const sequenceStorage = new KeychainSequenceStorage()
    const sequenceSessionStorage = new MapSessionStorage()

    if (implicitPkRaw && implicitAttRaw && implicitSigRaw) {
      const implicitAttestation = JSON.parse(implicitAttRaw, jsonRevivers)
      const implicitIdentitySignature = JSON.parse(implicitSigRaw, jsonRevivers)
      const meta = implicitMetaRaw ? JSON.parse(implicitMetaRaw, jsonRevivers) : {}
      await sequenceStorage.saveImplicitSession({
        pk: implicitPkRaw,
        walletAddress: explicitSession.walletAddress || walletAddress,
        attestation: implicitAttestation,
        identitySignature: implicitIdentitySignature,
        chainId,
        loginMethod: meta.loginMethod,
        userEmail: meta.userEmail,
        guard: meta.guard
      })
    }

    if (!globalThis.window) globalThis.window = { fetch: globalThis.fetch }
    else if (!globalThis.window.fetch) globalThis.window.fetch = globalThis.fetch

    installFetchLogger()

    const keymachineUrl = process.env.SEQUENCE_KEYMACHINE_URL || 'https://keymachine.sequence.app'
    const nodesUrl = process.env.SEQUENCE_NODES_URL || defaultNodesUrl(projectAccessKey)
    const relayerUrl = process.env.SEQUENCE_RELAYER_URL || 'https://{network}-relayer.sequence.app'

    const client = new DappClient(walletUrl, dappOrigin, projectAccessKey, {
      transportMode: TransportMode.REDIRECT,
      keymachineUrl,
      nodesUrl,
      relayerUrl,
      sequenceStorage,
      sequenceSessionStorage,
      canUseIndexedDb: false
    })

    await client.initialize()
    if (!client.isInitialized) throw new Error('Client not initialized')

    if (!broadcast) {
      const bigintReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v)
      console.log(JSON.stringify({ ok: true, dryRun: true, walletName, walletAddress, transactions }, bigintReplacer, 2))
      return { walletAddress, dryRun: true }
    }

    const feeOptions = await client.getFeeOptions(chainId, transactions)
    const feeOpt = preferNativeFee
      ? (feeOptions || []).find((o) => !o?.token?.contractAddress) || feeOptions?.[0]
      : feeOptions?.[0]

    const txHash = await client.sendTransaction(chainId, transactions, feeOpt)
    return { walletAddress, txHash }
  }

  if (cmd === 'send-usdc') {
    const to = getArg(args, '--to')
    const amount = getArg(args, '--amount')
    const broadcast = args.includes('--broadcast')
    if (!to || !amount) throw new Error('Missing --to and/or --amount')

    const projectAccessKey = process.env.SEQUENCE_PROJECT_ACCESS_KEY
    if (!projectAccessKey) throw new Error('Missing SEQUENCE_PROJECT_ACCESS_KEY env var')

    const walletUrl = process.env.SEQUENCE_ECOSYSTEM_WALLET_URL || DEFAULT_WALLET_URL
    const dappOrigin = process.env.SEQUENCE_DAPP_ORIGIN || process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL || ''
    if (!dappOrigin) throw new Error('Missing SEQUENCE_DAPP_ORIGIN (should match the connector UI origin)')

    // Polygon USDC (native): 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
    const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
    const decimals = 6n

    const parseUnits = (s, d) => {
      const [i, fRaw = ''] = String(s).split('.')
      const f = (fRaw + '0'.repeat(Number(d))).slice(0, Number(d))
      return BigInt(i) * 10n ** d + BigInt(f)
    }

    const value = parseUnits(amount, decimals)

    // transfer(address to, uint256 value)
    const selector = '0xa9059cbb'
    const pad = (hex, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0')
    const data = selector + pad(to) + pad('0x' + value.toString(16))

    const transactions = [{ to: USDC, value: 0n, data }]

    const { walletAddress, txHash, dryRun } = await runDappClientTx({
      name,
      walletName: name,
      chainId: 137,
      walletUrl,
      projectAccessKey,
      dappOrigin,
      transactions,
      broadcast,
      preferNativeFee: true
    })

    if (dryRun) return

    console.log(
      JSON.stringify(
        { ok: true, walletName: name, walletAddress, token: 'USDC', tokenAddress: USDC, to, amount, txHash, explorerUrl: `${explorerBase('polygon')}${txHash}` },
        null,
        2
      )
    )
    return
  }

  if (cmd === 'send-pol') {
    const to = getArg(args, '--to')
    const amount = getArg(args, '--amount')
    const broadcast = args.includes('--broadcast')
    if (!to || !amount) throw new Error('Missing --to and/or --amount')

    const walletAddress = await keytar.getPassword(SERVICE, `wallet:${name}`)
    const explicitRaw = await keytar.getPassword(SERVICE, `explicitSession:${name}`)
    const implicitPkRaw = await keytar.getPassword(SERVICE, `implicitPk:${name}`)
    const implicitAttRaw = await keytar.getPassword(SERVICE, `implicitAttestation:${name}`)
    const implicitSigRaw = await keytar.getPassword(SERVICE, `implicitIdentitySig:${name}`)
    const implicitMetaRaw = await keytar.getPassword(SERVICE, `implicitMeta:${name}`)

    if (!walletAddress) throw new Error(`Missing wallet address in Keychain: wallet:${name}`)
    if (!explicitRaw) throw new Error(`Missing explicit session in Keychain: explicitSession:${name}`)

    const projectAccessKey = process.env.SEQUENCE_PROJECT_ACCESS_KEY
    if (!projectAccessKey) throw new Error('Missing SEQUENCE_PROJECT_ACCESS_KEY env var')

    const walletUrl = process.env.SEQUENCE_ECOSYSTEM_WALLET_URL || DEFAULT_WALLET_URL
    const dappOrigin = process.env.SEQUENCE_DAPP_ORIGIN || process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL || ''
    if (!dappOrigin) throw new Error('Missing SEQUENCE_DAPP_ORIGIN (should match the connector UI origin)')

    const { DappClient, TransportMode, jsonRevivers } = await import('@0xsequence/dapp-client')

    const explicitSession = JSON.parse(explicitRaw, jsonRevivers)
    if (!explicitSession?.pk) {
      throw new Error('Stored explicit session is missing pk; re-link wallet')
    }
    const deadline = explicitSession?.config?.deadline
    if (deadline) {
      const deadlineSec = typeof deadline === 'bigint' ? Number(deadline) : Number(deadline)
      const nowSec = Math.floor(Date.now() / 1000)
      if (Number.isFinite(deadlineSec) && deadlineSec <= nowSec) {
        throw new Error(`Explicit session has expired (deadline ${deadlineSec}). Re-link wallet to mint a fresh session.`)
      }
    }

    // Keychain-backed storage modeled after wallet-dapp-client-cli
    class KeychainSequenceStorage {
      constructor() {
        this.pendingRedirect = false
        this.tempSessionPk = null
        this.pendingRequest = null
        this.explicitSessions = [{
          pk: explicitSession.pk,
          walletAddress: explicitSession.walletAddress || walletAddress,
          chainId: 137,
          loginMethod: explicitSession.loginMethod,
          userEmail: explicitSession.userEmail,
          guard: explicitSession.guard
        }]
        this.implicitSession = null
      }

      async setPendingRedirectRequest(isPending) { this.pendingRedirect = !!isPending }
      async isRedirectRequestPending() { return !!this.pendingRedirect }
      async saveTempSessionPk(pk) { this.tempSessionPk = pk }
      async getAndClearTempSessionPk() { const v = this.tempSessionPk; this.tempSessionPk = null; return v }
      async savePendingRequest(context) { this.pendingRequest = context }
      async getAndClearPendingRequest() { const v = this.pendingRequest; this.pendingRequest = null; return v }
      async peekPendingRequest() { return this.pendingRequest }

      async saveExplicitSession(sessionData) {
        this.explicitSessions = [...this.explicitSessions.filter(s => !(s.walletAddress === sessionData.walletAddress && s.pk === sessionData.pk && s.chainId === sessionData.chainId)), sessionData]
      }
      async getExplicitSessions() { return [...this.explicitSessions] }
      async clearExplicitSessions() { this.explicitSessions = [] }

      async saveImplicitSession(sessionData) { this.implicitSession = sessionData }
      async getImplicitSession() { return this.implicitSession }
      async clearImplicitSession() { this.implicitSession = null }

      async saveSessionlessConnection(sessionData) { this.sessionlessConnection = sessionData }
      async getSessionlessConnection() { return this.sessionlessConnection ?? null }
      async clearSessionlessConnection() { this.sessionlessConnection = null }

      async saveSessionlessConnectionSnapshot(sessionData) { this.sessionlessConnectionSnapshot = sessionData }
      async getSessionlessConnectionSnapshot() { return this.sessionlessConnectionSnapshot ?? null }
      async clearSessionlessConnectionSnapshot() { this.sessionlessConnectionSnapshot = null }

      async clearAllData() {
        this.pendingRedirect = false
        this.tempSessionPk = null
        this.pendingRequest = null
        this.explicitSessions = []
        this.implicitSession = null
        this.sessionlessConnection = null
        this.sessionlessConnectionSnapshot = null
      }
    }

    class MapSessionStorage {
      constructor() { this.kv = new Map() }
      async getItem(k) { return this.kv.has(k) ? this.kv.get(k) : null }
      async setItem(k, v) { this.kv.set(k, v) }
      async removeItem(k) { this.kv.delete(k) }
    }

    const sequenceStorage = new KeychainSequenceStorage()
    const sequenceSessionStorage = new MapSessionStorage()

    // Seed implicit session if we have it (optional, but helps dapp-client initialize correctly).
    if (implicitPkRaw && implicitAttRaw && implicitSigRaw) {
      const implicitAttestation = JSON.parse(implicitAttRaw, jsonRevivers)
      const implicitIdentitySignature = JSON.parse(implicitSigRaw, jsonRevivers)
      const meta = implicitMetaRaw ? JSON.parse(implicitMetaRaw, jsonRevivers) : {}
      await sequenceStorage.saveImplicitSession({
        pk: implicitPkRaw,
        walletAddress: explicitSession.walletAddress || walletAddress,
        attestation: implicitAttestation,
        identitySignature: implicitIdentitySignature,
        chainId: 137,
        loginMethod: meta.loginMethod,
        userEmail: meta.userEmail,
        guard: meta.guard
      })
    }

    // @0xsequence/relayer expects window.fetch; provide a minimal shim for Node.
    if (!globalThis.window) globalThis.window = { fetch: globalThis.fetch }
    else if (!globalThis.window.fetch) globalThis.window.fetch = globalThis.fetch

    installFetchLogger()

    const keymachineUrl = process.env.SEQUENCE_KEYMACHINE_URL || 'https://keymachine.sequence.app'
    const nodesUrl = process.env.SEQUENCE_NODES_URL || defaultNodesUrl(projectAccessKey)
    const relayerUrl = process.env.SEQUENCE_RELAYER_URL || 'https://{network}-relayer.sequence.app'

    const client = new DappClient(walletUrl, dappOrigin, projectAccessKey, {
      transportMode: TransportMode.REDIRECT,
      keymachineUrl,
      nodesUrl,
      relayerUrl,
      sequenceStorage,
      sequenceSessionStorage,
      canUseIndexedDb: false
    })

    await client.initialize()
    if (!client.isInitialized) throw new Error('Client not initialized')

    const parseEther = (s) => {
      const [i, fRaw = ''] = String(s).split('.')
      const f = (fRaw + '0'.repeat(18)).slice(0, 18)
      return BigInt(i) * 10n ** 18n + BigInt(f)
    }

    const value = parseEther(amount)

    // ValueForwarder call (session permissions are scoped to ValueForwarder)
    const forwardTo = '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca'
    const selector = '0x15dacbea' // forwardValue(address,uint256)
    const pad = (hex, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0')
    const data = selector + pad(to) + pad('0x' + value.toString(16))

    const transactions = [{ to: forwardTo, value: 0n, data }]

    if (!broadcast) {
      const bigintReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v)
      console.log(JSON.stringify({ ok: true, dryRun: true, walletName: name, walletAddress, to, amount, value: value.toString(), transactions }, bigintReplacer, 2))
      return
    }

    const feeOptions = await client.getFeeOptions(137, transactions)
    const feeOpt =
      (feeOptions || []).find((o) => !o?.token?.contractAddress || o?.token?.contractAddress === '0x0000000000000000000000000000000000000000') ||
      feeOptions?.[0]

    const txHash = await client.sendTransaction(137, transactions, feeOpt)

    console.log(JSON.stringify({ ok: true, walletName: name, walletAddress, to, amount, txHash, explorerUrl: `${explorerBase('polygon')}${txHash}` }, null, 2))
    return
  }

  throw new Error(`Unknown command: ${cmd}`)
}

main().catch((err) => {
  console.error(err?.stack || String(err))
  process.exit(1)
})
