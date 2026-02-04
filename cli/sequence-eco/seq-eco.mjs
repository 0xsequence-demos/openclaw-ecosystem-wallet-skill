#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import keytar from 'keytar'
import nacl from 'tweetnacl'
import sealedbox from 'tweetnacl-sealedbox-js'

const SERVICE = 'openclaw.sequence-ecosystem'

function usage() {
  console.log(`Usage:
  seq-eco.mjs create-request --name <walletName> [--chain polygon]
  seq-eco.mjs ingest-session --name <walletName> --rid <rid> --ciphertext '<b64url>'

  seq-eco.mjs wallets
  seq-eco.mjs wallet-remove --name <walletName> --yes

  seq-eco.mjs address --name <walletName>
  seq-eco.mjs balances --name <walletName> [--chain polygon]
  seq-eco.mjs send-pol --name <walletName> --to <address> --amount <pol> [--broadcast]

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
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()

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

    // Store full explicit session JSON (BigInt-safe) and also keep pk for convenience.
    const { jsonReplacers } = await import('@0xsequence/dapp-client')
    await keytar.setPassword(SERVICE, `explicitSession:${name}`, JSON.stringify(explicitSession, jsonReplacers))
    await keytar.setPassword(SERVICE, `sessionPk:${name}`, explicitSession.pk)
    await keytar.setPassword(SERVICE, `implicitPk:${name}`, implicit.pk)

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

  if (cmd === 'send-pol') {
    const to = getArg(args, '--to')
    const amount = getArg(args, '--amount')
    const broadcast = args.includes('--broadcast')
    if (!to || !amount) throw new Error('Missing --to and/or --amount')

    const walletAddress = await keytar.getPassword(SERVICE, `wallet:${name}`)
    const explicitRaw = await keytar.getPassword(SERVICE, `explicitSession:${name}`)
    if (!walletAddress) throw new Error(`Missing wallet address in Keychain: wallet:${name}`)
    if (!explicitRaw) throw new Error(`Missing explicit session in Keychain: explicitSession:${name}`)

    const projectAccessKey = process.env.SEQUENCE_PROJECT_ACCESS_KEY
    if (!projectAccessKey) throw new Error('Missing SEQUENCE_PROJECT_ACCESS_KEY env var')

    const { jsonRevivers } = await import('@0xsequence/dapp-client')
    const explicit = JSON.parse(explicitRaw, jsonRevivers)

    if (!explicit?.pk || !explicit?.config) throw new Error('Stored explicit session is missing pk/config; re-link wallet')

    const parseEther = (s) => {
      const [i, fRaw = ''] = String(s).split('.')
      const f = (fRaw + '0'.repeat(18)).slice(0, 18)
      return BigInt(i) * 10n ** 18n + BigInt(f)
    }

    const value = parseEther(amount)

    // Use Sequence value forwarder for native sends (we permission this target).
    const forwardTo = '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca'
    const selector = '0x15dacbea' // forwardValue(address,uint256)
    const pad = (hex, n = 64) => String(hex).replace(/^0x/, '').padStart(n, '0')
    const data = selector + pad(to) + pad('0x' + value.toString(16))

    const calls = [{
      to: forwardTo,
      value: 0n,
      data,
      gasLimit: 0n,
      delegateCall: false,
      onlyFallback: false,
      behaviorOnError: 'revert'
    }]

    if (!broadcast) {
      console.log(JSON.stringify({ ok: true, dryRun: true, walletName: name, walletAddress, to, amount, value: value.toString() }, null, 2))
      return
    }

    // Headless v3 send using wallet-core + relayer.
    const { Wallet, State, Signers, Envelope } = await import('@0xsequence/wallet-core')
    const { Extensions, Payload } = await import('@0xsequence/wallet-primitives')
    const { Provider, RpcTransport, Address } = await import('ox')
    const { Relayer } = await import('@0xsequence/relayer')

    const chainId = 137

    const rpcUrl = `https://nodes.sequence.app/polygon/${projectAccessKey}`
    const provider = Provider.from(RpcTransport.fromHttp(rpcUrl))

    const stateProvider = new State.Sequence.Provider() // defaults to https://keymachine.sequence.app
    const wallet = new Wallet(Address.from(walletAddress), { stateProvider })

    // Create explicit session signer from pk + the explicit session config used during connect.
    const explicitSigner = new Signers.Session.Explicit(explicit.pk, {
      chainId,
      valueLimit: BigInt(explicit.config.valueLimit),
      deadline: BigInt(explicit.config.deadline),
      permissions: explicit.config.permissions
    })

    const sessionManager = new Signers.SessionManager(wallet, {
      sessionManagerAddress: Extensions.Rc5.sessions,
      stateProvider,
      explicitSigners: [explicitSigner],
      provider
    })

    // Prepare and sign an envelope
    const envelope = await wallet.prepareTransaction(provider, calls, { noConfigUpdate: true })
    const parented = { ...envelope.payload, parentWallets: [wallet.address] }

    const imageHash = await sessionManager.imageHash
    if (!imageHash) throw new Error('Session manager image hash unavailable')

    const signature = await sessionManager.signSapient(wallet.address, chainId, parented, imageHash)

    const signedEnvelope = Envelope.toSigned(envelope, [{ imageHash, signature }])
    const built = await wallet.buildTransaction(provider, signedEnvelope)

    // Ask relayer for fee quote (opaque) and relay.
    const relayerHost = 'https://dev-polygon-relayer.sequence.app'
    const relayer = new Relayer.RpcRelayer(relayerHost, chainId, rpcUrl, globalThis.fetch, projectAccessKey)
    const { quote } = await relayer.feeOptions(wallet.address, chainId, calls)
    const { opHash } = await relayer.relay(wallet.address, built.data, chainId, quote)

    // Wait for confirmation
    let txHash
    for (let i = 0; i < 80; i++) {
      const st = await relayer.status(opHash, chainId)
      if (st.status === 'confirmed') {
        txHash = st.transactionHash
        break
      }
      if (st.status === 'failed') {
        throw new Error(`Relayer failed: ${st.reason || 'unknown'}`)
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (!txHash) throw new Error(`Timed out waiting for tx receipt (opHash=${opHash})`)

    console.log(JSON.stringify({
      ok: true,
      walletName: name,
      walletAddress,
      to,
      amount,
      txHash,
      explorerUrl: `${explorerBase('polygon')}${txHash}`
    }, null, 2))
    return
  }

  throw new Error(`Unknown command: ${cmd}`)
}

main().catch((err) => {
  console.error(err?.stack || String(err))
  process.exit(1)
})
