#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import keytar from 'keytar'

const SERVICE = 'openclaw.sequence-ecosystem'

function requireEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing ${name} env var`)
  return v
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr || stdout}`)
        e.cause = err
        return reject(e)
      }
      resolve({ stdout, stderr })
    })
  })
}

function statePathFor(walletName) {
  const dir = path.join(os.homedir(), '.openclaw', 'state', 'sequence-ecosystem', 'dapp-client-cli')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return path.join(dir, `${walletName}.state.enc`)
}

export async function syncStateFromKeychain({ walletName, chainId }) {
  const passphrase = requireEnv('DAPP_CLIENT_CLI_PASSPHRASE')
  const statePath = statePathFor(walletName)

  const walletAddress = await keytar.getPassword(SERVICE, `wallet:${walletName}`)
  const explicitRaw = await keytar.getPassword(SERVICE, `explicitSession:${walletName}`)
  const implicitPk = await keytar.getPassword(SERVICE, `implicitPk:${walletName}`)
  const implicitAttRaw = await keytar.getPassword(SERVICE, `implicitAttestation:${walletName}`)
  const implicitSigRaw = await keytar.getPassword(SERVICE, `implicitIdentitySig:${walletName}`)

  if (!walletAddress) throw new Error(`Missing wallet address in Keychain: wallet:${walletName}`)
  if (!explicitRaw) throw new Error(`Missing explicit session in Keychain: explicitSession:${walletName}`)
  if (!implicitPk || !implicitAttRaw || !implicitSigRaw) throw new Error('Missing implicit session material in Keychain')

  const { StateManager } = await import('@0xsequence/dapp-client-cli/dist/state.js')
  const { FileSequenceStorage, FileSessionStorage } = await import('@0xsequence/dapp-client-cli/dist/storage.js')
  const stateManager = new StateManager(statePath, passphrase)
  const storage = new FileSequenceStorage(stateManager, { suppressPendingRedirect: true })
  const sessionStorage = new FileSessionStorage(stateManager)

  // Build config for CLI: keep it minimal and env-driven.
  const walletUrl = process.env.SEQUENCE_ECOSYSTEM_WALLET_URL
  const origin = process.env.SEQUENCE_DAPP_ORIGIN
  const projectAccessKey = process.env.SEQUENCE_PROJECT_ACCESS_KEY
  if (!walletUrl) throw new Error('Missing SEQUENCE_ECOSYSTEM_WALLET_URL')
  if (!origin) throw new Error('Missing SEQUENCE_DAPP_ORIGIN')
  if (!projectAccessKey) throw new Error('Missing SEQUENCE_PROJECT_ACCESS_KEY')

  const keymachineUrl = process.env.SEQUENCE_KEYMACHINE_URL || 'https://keymachine.sequence.app'
  const nodesUrl = process.env.SEQUENCE_NODES_URL || 'https://nodes.sequence.app/{network}'
  const relayerUrl = process.env.SEQUENCE_RELAYER_URL || 'https://{network}-relayer.sequence.app'

  // Load current state, overwrite config, and reset storage so we don't accidentally use stale sessions.
  await stateManager.update((state) => {
    state.config.walletUrl = walletUrl
    state.config.origin = origin
    state.config.projectAccessKey = projectAccessKey
    state.config.keymachineUrl = keymachineUrl
    state.config.nodesUrl = nodesUrl
    state.config.relayerUrl = relayerUrl
    state.config.transportMode = 'redirect'

    state.storage.pendingRedirect = false
    state.storage.tempSessionPk = null
    state.storage.pendingRequest = null
    state.storage.explicitSessions = []
    state.storage.implicitSession = null
    state.storage.sessionlessConnection = null
    state.storage.sessionlessConnectionSnapshot = null
  })

  // Save explicit + implicit sessions into the CLI state.
  // We keep only the fields dapp-client needs.
  const { jsonRevivers } = await import('@0xsequence/dapp-client')
  const explicitSession = JSON.parse(explicitRaw, jsonRevivers)

  await storage.saveExplicitSession({
    pk: explicitSession.pk,
    walletAddress,
    chainId,
    loginMethod: explicitSession.loginMethod,
    userEmail: explicitSession.userEmail,
    guard: explicitSession.guard,
  })

  const implicitAttestation = JSON.parse(implicitAttRaw, jsonRevivers)
  const implicitIdentitySignature = JSON.parse(implicitSigRaw, jsonRevivers)
  await storage.saveImplicitSession({
    pk: implicitPk,
    walletAddress,
    chainId,
    attestation: implicitAttestation,
    identitySignature: implicitIdentitySignature,
  })

  // Clear any pending redirect request remnants.
  await storage.setPendingRedirectRequest(false)
  await storage.savePendingRequest(null)
  await storage.saveTempSessionPk(null)

  // Ensure some sessionStorage keys exist (safe no-op; the CLI will set as needed).
  await sessionStorage.removeItem('')

  return { statePath, walletAddress }
}

export async function sendTransactionViaDappClientCli({ walletName, chainId, transactions }) {
  const { statePath, walletAddress } = await syncStateFromKeychain({ walletName, chainId })

  const tmpDir = path.join(os.homedir(), '.openclaw', 'workspace', 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const txPath = path.join(tmpDir, `dapp-client-cli-${walletName}-${Date.now()}-tx.json`)
  const bigintReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v)
  fs.writeFileSync(txPath, JSON.stringify(transactions, bigintReplacer, 2), { mode: 0o600 })

  const passphrase = requireEnv('DAPP_CLIENT_CLI_PASSPHRASE')

  const bin = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'node_modules',
    '@0xsequence',
    'dapp-client-cli',
    'dist',
    'index.js'
  )

  const args = [
    '--state',
    statePath,
    '--passphrase',
    passphrase,
    '--no-listen',
    '--no-open-url',
    'send-transaction',
    '--chain-id',
    String(chainId),
    '--transactions',
    txPath,
  ]

  const { stdout } = await execFileAsync('node', [bin, ...args], {
    env: { ...process.env },
  })

  // CLI prints JSON.
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`Could not parse dapp-client-cli output as JSON:\n${stdout}`)
  }

  return { ...parsed, walletAddress }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ;(async () => {
    const [cmd] = process.argv.slice(2)
    if (cmd !== 'send-transaction') {
      console.error('Usage: dapp-client-cli-bridge.mjs send-transaction <walletName> <chainId> <txJsonPath>')
      process.exit(2)
    }
    const [, walletName, chainIdRaw, txJsonPath] = process.argv.slice(2)
    const tx = JSON.parse(fs.readFileSync(txJsonPath, 'utf8'))
    const res = await sendTransactionViaDappClientCli({ walletName, chainId: Number(chainIdRaw), transactions: tx })
    console.log(JSON.stringify(res, null, 2))
  })().catch((e) => {
    console.error(e?.stack || String(e))
    process.exit(1)
  })
}
