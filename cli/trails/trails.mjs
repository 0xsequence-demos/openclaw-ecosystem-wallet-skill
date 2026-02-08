#!/usr/bin/env node
import keytar from 'keytar'
import { parseUnits } from 'viem'
import { TrailsApi, TradeType } from '@0xtrails/api'
import { Network } from '@0xsequence/wallet-primitives'
import { resolveErc20BySymbol } from './token-directory.mjs'

const SERVICE = 'openclaw.sequence-ecosystem'

function installFetchLogger() {
  const enabled = ['1', 'true', 'yes'].includes(String(process.env.TRAILS_DEBUG_FETCH || '').toLowerCase())
  if (!enabled) return

  const origFetch = globalThis.fetch
  if (typeof origFetch !== 'function') throw new Error('globalThis.fetch not available')

  const redact = (s) => String(s).slice(0, 8000)

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url
    const method = init?.method || 'GET'
    const bodyPreview = init?.body ? redact(init.body) : ''
    console.error(`[fetch] → ${method} ${url}`)
    if (bodyPreview) console.error(`[fetch]   req.body=${bodyPreview}`)

    try {
      const res = await origFetch(input, init)
      let text = ''
      try { text = redact(await res.clone().text()) } catch (e) { text = `[unreadable: ${e?.message || e}]` }
      console.error(`[fetch] ← ${res.status} ${method} ${url}`)
      if (text) console.error(`[fetch]   res.body=${text}`)
      return res
    } catch (e) {
      console.error(`[fetch] ✖ ${method} ${url}: ${e?.stack || e}`)
      throw e
    }
  }

  if (globalThis.window) globalThis.window.fetch = globalThis.fetch
}

function usage() {
  console.log(`Usage:
  trails swap --name <walletName> --from <SYMBOL> --to <SYMBOL> --amount <exactInputAmount> [--chain <networkName|chainId>] [--slippage 0.005] [--broadcast]

Where:
  --from/--to: token symbol for the selected chain.
    - Use NATIVE for the chain native token (aliases: POL).
    - Examples: USDC, USDT, WETH, NATIVE

Env:
  TRAILS_API_KEY=...   (defaults to SEQUENCE_PROJECT_ACCESS_KEY)
  TRAILS_API_HOSTNAME=... (optional)
  SEQUENCE_PROJECT_ACCESS_KEY=... (fallback api key)
  SEQUENCE_ECOSYSTEM_WALLET_URL=https://acme-wallet.ecosystem-demo.xyz
  SEQUENCE_DAPP_ORIGIN=https://moltbot-ecosystem-wallet.taylanpince.workers.dev

  # Optional override mapping (normally you can rely on 0xsequence/token-directory)
  TRAILS_TOKEN_MAP_JSON='{"137":{"USDC":{"address":"0x...","decimals":6},"USDT":{"address":"0x...","decimals":6}}}'

Notes:
  - Exact-input semantics only.
  - Uses the existing Sequence ecosystem wallet session stored in macOS Keychain.
`)
}

function getArg(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return null
  return args[i + 1] ?? null
}

function resolveNetwork(raw) {
  const v = String(raw || 'polygon').toLowerCase()
  if (v === 'matic') return Network.getNetworkFromName('polygon')

  const asNum = Number(v)
  const net = Number.isFinite(asNum) && asNum > 0 ? Network.getNetworkFromChainId(asNum) : Network.getNetworkFromName(v)
  if (!net) throw new Error(`Unsupported chain/network: ${raw}`)
  return net
}

function explorerTxBase(net) {
  const base = String(net?.blockExplorer?.url || '').replace(/\/+$/, '')
  if (!base) return null
  return `${base}/tx/`
}

function loadTokenMap() {
  // Optional override mapping.
  // Format:
  // TRAILS_TOKEN_MAP_JSON='{"137":{"USDC":{"address":"0x...","decimals":6},"USDT":{...}}}'
  const raw = process.env.TRAILS_TOKEN_MAP_JSON || ''
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Invalid TRAILS_TOKEN_MAP_JSON (must be valid JSON)')
  }
}

async function getTokenConfig({ tokenMap, chainId, symbol, nativeSymbol }) {
  const sym = String(symbol || '').toUpperCase().trim()

  if (sym === 'NATIVE' || sym === nativeSymbol.toUpperCase() || sym === 'POL') {
    return { symbol: nativeSymbol.toUpperCase(), address: '0x0000000000000000000000000000000000000000', decimals: 18 }
  }

  // 1) explicit env override
  const entry = tokenMap?.[String(chainId)]?.[sym]
  if (entry?.address && entry.decimals != null) {
    return { symbol: sym, address: entry.address, decimals: Number(entry.decimals) }
  }

  // 2) Token Directory fallback (validated per chain)
  const td = await resolveErc20BySymbol({ chainId, symbol: sym })
  if (!td?.address || td.decimals == null) {
    throw new Error(`Unknown token ${sym} on chainId=${chainId} (no override + not found in token-directory)`) 
  }

  return { symbol: sym, address: td.address, decimals: Number(td.decimals) }
}

async function createDappClient({ walletName, chainId }) {
  const walletAddress = await keytar.getPassword(SERVICE, `wallet:${walletName}`)
  const explicitRaw = await keytar.getPassword(SERVICE, `explicitSession:${walletName}`)
  const implicitPkRaw = await keytar.getPassword(SERVICE, `implicitPk:${walletName}`)
  const implicitAttRaw = await keytar.getPassword(SERVICE, `implicitAttestation:${walletName}`)
  const implicitSigRaw = await keytar.getPassword(SERVICE, `implicitIdentitySig:${walletName}`)
  const implicitMetaRaw = await keytar.getPassword(SERVICE, `implicitMeta:${walletName}`)

  if (!walletAddress) throw new Error(`Missing wallet address in Keychain: wallet:${walletName}`)
  if (!explicitRaw) throw new Error(`Missing explicit session in Keychain: explicitSession:${walletName}`)

  const projectAccessKey = process.env.SEQUENCE_PROJECT_ACCESS_KEY
  if (!projectAccessKey) throw new Error('Missing SEQUENCE_PROJECT_ACCESS_KEY env var')

  const walletUrl = process.env.SEQUENCE_ECOSYSTEM_WALLET_URL || 'https://acme-wallet.ecosystem-demo.xyz'
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

  const keymachineUrl = process.env.SEQUENCE_KEYMACHINE_URL || 'https://keymachine.sequence.app'
  const nodesUrl = process.env.SEQUENCE_NODES_URL || 'https://nodes.sequence.app/{network}'
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
  if (!client.isInitialized) throw new Error('DappClient not initialized')

  return { client, walletAddress }
}

function asTx({ to, data, value }) {
  return {
    to,
    data: data || '0x',
    value: value ? BigInt(value) : 0n
  }
}

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage()
    process.exit(0)
  }

  if (cmd !== 'swap') throw new Error(`Unknown command: ${cmd}`)

  const name = getArg(args, '--name')
  const from = (getArg(args, '--from') || '').toUpperCase()
  const toSym = (getArg(args, '--to') || '').toUpperCase()
  const amount = getArg(args, '--amount')
  const net = resolveNetwork(getArg(args, '--chain') || (await keytar.getPassword(SERVICE, `chain:${name}`)) || 'polygon')
  const slippage = Number(getArg(args, '--slippage') || '0.005')
  const broadcast = args.includes('--broadcast')

  if (!name) throw new Error('Missing --name')
  if (!amount) throw new Error('Missing --amount')
  // Token availability depends on chain; configure addresses via TRAILS_TOKEN_MAP_JSON.
  // We keep the interface symbol-based and resolve to addresses per chain.
  if (from === toSym) throw new Error('from and to token must be different')
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage >= 0.5) throw new Error('Invalid --slippage')

  const TRAILS_API_KEY = process.env.TRAILS_API_KEY || process.env.SEQUENCE_PROJECT_ACCESS_KEY
  if (!TRAILS_API_KEY) throw new Error('Missing TRAILS_API_KEY (or SEQUENCE_PROJECT_ACCESS_KEY)')

  installFetchLogger()

  const trails = new TrailsApi(TRAILS_API_KEY, {
    hostname: process.env.TRAILS_API_HOSTNAME
  })

  const chainId = net.chainId
  const tokenMap = loadTokenMap()
  const nativeSymbol = net?.nativeCurrency?.symbol || 'NATIVE'

  const fromCfg = await getTokenConfig({ tokenMap, chainId, symbol: from, nativeSymbol })
  const toCfg = await getTokenConfig({ tokenMap, chainId, symbol: toSym, nativeSymbol })

  if (fromCfg.address.toLowerCase() === toCfg.address.toLowerCase()) throw new Error('from and to token must be different')

  const { client, walletAddress } = await createDappClient({ walletName: name, chainId })

  const originTokenAmount = parseUnits(amount, fromCfg.decimals).toString()

  const originTokenAddress = fromCfg.address
  const destinationTokenAddress = toCfg.address

  const quoteReq = {
    ownerAddress: walletAddress,
    originChainId: chainId,
    originTokenAddress,
    originTokenAmount,
    destinationChainId: chainId,
    destinationTokenAddress,
    destinationTokenAmount: '0',
    tradeType: TradeType.EXACT_INPUT,
    options: {
      slippageTolerance: slippage
    }
  }

  const quoteRes = await trails.quoteIntent(quoteReq)
  if (!quoteRes?.intent) throw new Error('No intent returned from quoteIntent')

  const intent = quoteRes.intent

  const commitRes = await trails.commitIntent({ intent })
  const intentId = commitRes?.intentId || intent.intentId
  if (!intentId) throw new Error('No intentId from commitIntent')

  const depositTx = intent.depositTransaction
  if (!depositTx?.to) throw new Error('Intent missing depositTransaction')

  const depositTransactions = [asTx({ to: depositTx.to, data: depositTx.data, value: depositTx.value })]

  const bigintReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v)

  if (!broadcast) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      walletName: name,
      walletAddress,
      intentId,
      depositTransaction: depositTx,
      note: 'Re-run with --broadcast to submit the deposit transaction and execute the intent.'
    }, bigintReplacer, 2))
    return
  }

  // Send the deposit tx via Sequence session.
  // Prefer native fee option when available.
  const feeOptions = await client.getFeeOptions(chainId, depositTransactions)
  const feeOpt = (feeOptions || []).find((o) => !o?.token?.contractAddress) || feeOptions?.[0]
  const depositTxHash = await client.sendTransaction(chainId, depositTransactions, feeOpt)

  const execRes = await trails.executeIntent({
    intentId,
    depositTransactionHash: depositTxHash
  })

  const receipt = await trails.waitIntentReceipt({ intentId })

  console.log(JSON.stringify({
    ok: true,
    walletName: name,
    walletAddress,
    intentId,
    depositTxHash,
    depositExplorerUrl: (() => { const b = explorerTxBase(net); return b ? `${b}${depositTxHash}` : undefined })(),
    executeStatus: execRes?.intentStatus,
    receipt
  }, bigintReplacer, 2))
}

main().catch((err) => {
  console.error(err?.stack || String(err))
  process.exit(1)
})
