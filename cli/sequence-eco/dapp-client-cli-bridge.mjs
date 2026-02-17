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

  // We derive all meaningful session state from Keychain on each run.
  // The CLI state file is just a transport for dapp-client-cli; to avoid
  // passphrase mismatch / stale encrypted state issues, we always recreate it.
  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath)
  } catch {}

  const walletAddress = await keytar.getPassword(SERVICE, `wallet:${walletName}`)
  const explicitRaw = await keytar.getPassword(SERVICE, `explicitSession:${walletName}`)
  const implicitPk = await keytar.getPassword(SERVICE, `implicitPk:${walletName}`)
  const implicitAttRaw = await keytar.getPassword(SERVICE, `implicitAttestation:${walletName}`)
  const implicitSigRaw = await keytar.getPassword(SERVICE, `implicitIdentitySig:${walletName}`)
  const implicitMetaRaw = await keytar.getPassword(SERVICE, `implicitMeta:${walletName}`)

  if (!walletAddress) throw new Error(`Missing wallet address in Keychain: wallet:${walletName}`)
  if (!explicitRaw) throw new Error(`Missing explicit session in Keychain: explicitSession:${walletName}`)
  if (!implicitPk || !implicitAttRaw || !implicitSigRaw) throw new Error('Missing implicit session material in Keychain')

  const { jsonRevivers } = await import('@0xsequence/dapp-client')
  const implicitMeta = implicitMetaRaw ? JSON.parse(implicitMetaRaw, jsonRevivers) : {}

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

    // Important: set these so DappClient.getWalletAddress() is available and the client behaves like a connected state.
    state.storage.sessionlessConnection = { walletAddress }
    state.storage.sessionlessConnectionSnapshot = { walletAddress }
  })

  // Save explicit + implicit sessions into the CLI state.
  // We keep only the fields dapp-client needs.
  const explicitSession = JSON.parse(explicitRaw, jsonRevivers)

  await storage.saveExplicitSession({
    // Persist the FULL explicit session shape so dapp-client-cli can generate
    // the same calldata bundling as a natively-connected CLI session.
    pk: explicitSession.pk,
    sessionAddress: explicitSession.sessionAddress,
    walletAddress,
    chainId,
    config: explicitSession.config,

    // optional metadata (not always present on explicitSession)
    loginMethod: implicitMeta.loginMethod ?? explicitSession.loginMethod,
    userEmail: implicitMeta.userEmail ?? explicitSession.userEmail,
    guard: implicitMeta.guard,
  })

  // Also persist a lightweight "connected" identity (not a session secret) for better CLI behavior.
  await stateManager.update((state) => {
    state.storage.sessionlessConnection = {
      walletAddress,
      loginMethod: implicitMeta.loginMethod ?? explicitSession.loginMethod,
      userEmail: implicitMeta.userEmail ?? explicitSession.userEmail,
      guard: implicitMeta.guard,
    }
    state.storage.sessionlessConnectionSnapshot = {
      walletAddress,
      loginMethod: implicitMeta.loginMethod ?? explicitSession.loginMethod,
      userEmail: implicitMeta.userEmail ?? explicitSession.userEmail,
      guard: implicitMeta.guard,
    }
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

  // dapp-client-cli requires a fee option for dispatch in some relayer setups.
  // We keep the wrapper resilient by auto-selecting a default fee option via the CLI itself.
  const feeOptsArgs = [
    '--state',
    statePath,
    '--passphrase',
    passphrase,
    '--no-listen',
    '--no-open-url',
    'fee-options',
    '--chain-id',
    String(chainId),
    '--transactions',
    txPath,
  ]
  const cliEnv = {
    ...process.env,
    // Belt + suspenders: dapp-client-cli reads ACCESS_KEY / PROJECT_ACCESS_KEY from env.
    // Ensure these are present even if the caller only set SEQUENCE_PROJECT_ACCESS_KEY.
    DAPP_CLIENT_CLI_ACCESS_KEY: process.env.DAPP_CLIENT_CLI_ACCESS_KEY || process.env.SEQUENCE_PROJECT_ACCESS_KEY,
    ACCESS_KEY: process.env.ACCESS_KEY || process.env.SEQUENCE_PROJECT_ACCESS_KEY,
    PROJECT_ACCESS_KEY: process.env.PROJECT_ACCESS_KEY || process.env.SEQUENCE_PROJECT_ACCESS_KEY,

    // Also ensure the CLI sees our config consistently.
    WALLET_URL: process.env.WALLET_URL || process.env.SEQUENCE_ECOSYSTEM_WALLET_URL,
    ORIGIN: process.env.ORIGIN || process.env.SEQUENCE_DAPP_ORIGIN || process.env.SEQUENCE_ECOSYSTEM_CONNECTOR_URL,
    NODES_URL: process.env.NODES_URL || process.env.SEQUENCE_NODES_URL || 'https://nodes.sequence.app/{network}',
    RELAYER_URL: process.env.RELAYER_URL || process.env.SEQUENCE_RELAYER_URL || 'https://{network}-relayer.sequence.app',
    KEYMACHINE_URL: process.env.KEYMACHINE_URL || process.env.SEQUENCE_KEYMACHINE_URL || 'https://keymachine.sequence.app'
  }

  const { stdout: feeStdout, stderr: feeStderr } = await execFileAsync('node', [bin, ...feeOptsArgs], {
    env: cliEnv,
  })

  function parseJsonFromMixedOutput(text) {
    const s = String(text || '').trim()
    // Some deps may print logs to stdout; try to locate the JSON payload.
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (ch !== '{' && ch !== '[') continue
      const candidate = s.slice(i).trim()
      try {
        return JSON.parse(candidate)
      } catch {}
    }
    throw new Error(`Could not find JSON in output. stdout.head=${JSON.stringify(s.slice(0, 120))} stderr.head=${JSON.stringify(String(feeStderr || '').slice(0, 120))}`)
  }

  const feeOptions = parseJsonFromMixedOutput(feeStdout)
  if (!Array.isArray(feeOptions) || feeOptions.length === 0) {
    throw new Error('No fee options returned by dapp-client-cli')
  }
  const isNative = (o) => !o?.token?.contractAddress || o?.token?.contractAddress === '0x0000000000000000000000000000000000000000'
  const feeOption = feeOptions.find(isNative) || feeOptions[0]

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
    '--fee-option',
    JSON.stringify(feeOption),
  ]

  const { stdout } = await execFileAsync('node', [bin, ...args], {
    env: cliEnv,
  })

  // CLI prints JSON, but may also print informational lines to stdout.
  // Extract the first JSON object/array we can find.
  let parsed
  try {
    const s = String(stdout || '')
    let found = null
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (ch !== '{' && ch !== '[') continue
      const candidate = s.slice(i).trim()
      try {
        found = JSON.parse(candidate)
        break
      } catch {}
    }
    if (!found) throw new Error('no json found')
    parsed = found
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
