#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  seq-eco.mjs create-request --name <walletName> [--chain polygon]
  seq-eco.mjs ingest-session --name <walletName> --rid <rid> --ciphertext '<b64url>'

  seq-eco.mjs wallets
  seq-eco.mjs wallet-remove --name <walletName> --yes

  seq-eco.mjs address --name <walletName>
  seq-eco.mjs balances --name <walletName> [--chain polygon]
  seq-eco.mjs send-pol --name <walletName> --to <address> --amount <pol> [--broadcast]
  seq-eco.mjs config-update --name <walletName> [--broadcast]

Env:
- SEQUENCE_ECOSYSTEM_CONNECTOR_URL=https://<your-worker>.workers.dev
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

function formatUnits(raw, decimals) {
  const s = String(raw || '0')
  const neg = s.startsWith('-')
  const v = neg ? s.slice(1) : s
  const padded = v.padStart(decimals + 1, '0')
  const i = padded.slice(0, -decimals)
  const f = padded.slice(-decimals).replace(/0+$/, '')
  return `${neg ? '-' : ''}${i}${f ? '.' + f : ''}`
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

    const rid = randomId(16)
    const kp = nacl.box.keyPair()
    const pub = b64urlEncode(kp.publicKey)
    const priv = b64urlEncode(kp.secretKey)

    const createdAt = new Date().toISOString()
    // Give plenty of time to complete the connect flow + copy/paste on mobile.
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

    console.log(JSON.stringify({ ok: true, walletName: name, chain, rid, url: url.toString(), expiresAt, storedState: statePath }, null, 2))
    return
  }

  if (cmd === 'ingest-session') {
    const ciphertext = getArg(args, '--ciphertext')
    const rid = getArg(args, '--rid')
    if (!rid) throw new Error('Missing --rid')
    if (!ciphertext) throw new Error('Missing --ciphertext')

    const { fp, obj } = readPrivateRequest(rid)
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
    // Payload may include BigInt/Uint8Array encoded via dapp-client jsonReplacers.
    // Attempt to revive back into JS types.
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
      userEmail: implicit.userEmail,
    }

    // Store full explicit session JSON (BigInt-safe) and also keep pk for convenience.
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

    console.log(JSON.stringify({ ok: true, walletName: name, chain, rid, walletAddress }, null, 2))
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
    const feeOpt = (feeOptions || []).find((o) => o?.token?.contractAddress === '0x0000000000000000000000000000000000000000') || feeOptions?.[0]
    const txHash = await client.sendTransaction(137, transactions, feeOpt)

    console.log(JSON.stringify({ ok: true, walletName: name, walletAddress, kind: 'config-update', txHash, explorerUrl: `${explorerBase('polygon')}${txHash}` }, null, 2))
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
    const feeOpt = (feeOptions || []).find((o) => o?.token?.contractAddress === '0x0000000000000000000000000000000000000000') || feeOptions?.[0]

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
