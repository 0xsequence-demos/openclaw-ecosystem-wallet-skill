import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import type { SessionPayload } from '@polygon-agent/shared'

export interface Transaction {
  to: string
  value?: string
  data?: string
}

export async function sendTransaction(
  session: SessionPayload,
  transactions: Transaction[],
): Promise<{ txHash: string }> {
  const { statePath } = await buildCliState(session)
  const passphrase = getPassphrase()

  // Write transactions to a temp file
  const tmpDir = join(homedir(), '.polygon-agent', 'tmp')
  mkdirSync(tmpDir, { recursive: true })
  const txPath = join(tmpDir, `tx-${Date.now()}.json`)
  writeFileSync(txPath, JSON.stringify(transactions, bigintReplacer, 2), { mode: 0o600 })

  try {
    const bin = resolveDappClientCliBin()
    const commonArgs = [
      '--state', statePath,
      '--passphrase', passphrase,
      '--no-listen',
      '--no-open-url',
    ]

    if (process.env.POLYGON_AGENT_CLI_DEBUG) {
      commonArgs.push('--debug')
    }

    const cliEnv = buildCliEnv(session)

    // Step 1: Get fee options
    const { stdout: feeStdout } = await execFileAsync('node', [
      bin, ...commonArgs,
      'fee-options',
      '--chain-id', String(session.chain_id),
      '--transactions', txPath,
    ], { env: cliEnv })

    const feeOptions = parseJsonFromMixedOutput(feeStdout)
    if (!Array.isArray(feeOptions) || feeOptions.length === 0) {
      throw new Error('No fee options returned by dapp-client-cli')
    }

    // Prefer native fee option, fall back to first
    const isNative = (o: any) =>
      !o?.token?.contractAddress ||
      o?.token?.contractAddress === '0x0000000000000000000000000000000000000000'
    const feeOption = feeOptions.find(isNative) || feeOptions[0]

    // Step 2: Send transaction
    const { stdout } = await execFileAsync('node', [
      bin, ...commonArgs,
      'send-transaction',
      '--chain-id', String(session.chain_id),
      '--transactions', txPath,
      '--fee-option', JSON.stringify(feeOption),
    ], { env: cliEnv })

    const result = parseJsonFromMixedOutput(stdout)
    const txHash = result.txHash || result.hash || result.transactionHash
    if (!txHash) {
      throw new Error(`Transaction sent but no txHash in response: ${JSON.stringify(result)}`)
    }

    return { txHash, ...result }
  } finally {
    // Clean up temp file
    try { unlinkSync(txPath) } catch {}
  }
}

// --- Build dapp-client-cli encrypted state from SessionPayload ---

async function buildCliState(session: SessionPayload): Promise<{ statePath: string }> {
  const passphrase = getPassphrase()
  const stateDir = join(homedir(), '.polygon-agent', 'cli-state')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })

  // Use a deterministic path per wallet address so we don't leak state files
  const safeName = session.wallet_address.toLowerCase().replace(/[^a-z0-9]/g, '')
  const statePath = join(stateDir, `${safeName}.state.enc`)

  // Always recreate — we rebuild state fresh from SessionPayload each time
  try { if (existsSync(statePath)) unlinkSync(statePath) } catch {}

  const { jsonRevivers } = await import('@0xsequence/dapp-client')
  const { StateManager } = await import('@0xsequence/dapp-client-cli/state')
  const { FileSequenceStorage } = await import('@0xsequence/dapp-client-cli/storage')

  const stateManager = new (StateManager as any)(statePath, passphrase)
  const storage = new (FileSequenceStorage as any)(stateManager, { suppressPendingRedirect: true })

  // Parse session_config (was stringified with bigintReplacer)
  const sessionConfig = session.session_config
    ? JSON.parse(session.session_config, jsonRevivers)
    : {}

  // Set up config
  await stateManager.update((state: any) => {
    state.config.walletUrl = session.ecosystem_wallet_url
    state.config.origin = session.ecosystem_wallet_url // dApp origin
    state.config.projectAccessKey = session.project_access_key
    state.config.keymachineUrl = process.env.SEQUENCE_KEYMACHINE_URL || 'https://keymachine.sequence.app'
    state.config.nodesUrl = process.env.SEQUENCE_NODES_URL || 'https://nodes.sequence.app/{network}'
    state.config.relayerUrl = session.relayer_url || process.env.SEQUENCE_RELAYER_URL || 'https://{network}-relayer.sequence.app'
    state.config.transportMode = 'redirect'

    // Clear stale state
    state.storage.pendingRedirect = false
    state.storage.tempSessionPk = null
    state.storage.pendingRequest = null
    state.storage.explicitSessions = []
    state.storage.implicitSession = null

    state.storage.sessionlessConnection = { walletAddress: session.wallet_address }
    state.storage.sessionlessConnectionSnapshot = { walletAddress: session.wallet_address }
  })

  // Save explicit session
  await storage.saveExplicitSession({
    pk: session.session_private_key,
    sessionAddress: session.session_address,
    walletAddress: session.wallet_address,
    chainId: session.chain_id,
    config: sessionConfig,
    loginMethod: session.implicit_session?.login_method,
    userEmail: session.implicit_session?.user_email,
    guard: session.implicit_session?.guard,
  })

  // Update sessionless connection with metadata
  await stateManager.update((state: any) => {
    const meta = {
      walletAddress: session.wallet_address,
      loginMethod: session.implicit_session?.login_method,
      userEmail: session.implicit_session?.user_email,
      guard: session.implicit_session?.guard,
    }
    state.storage.sessionlessConnection = meta
    state.storage.sessionlessConnectionSnapshot = meta
  })

  // Save implicit session if available
  if (session.implicit_session) {
    const imp = session.implicit_session
    await storage.saveImplicitSession({
      pk: imp.pk,
      walletAddress: session.wallet_address,
      chainId: imp.chain_id,
      attestation: imp.attestation,
      identitySignature: imp.identity_signature,
    })
  }

  // Clear pending state
  await storage.setPendingRedirectRequest(false)
  await storage.savePendingRequest(null)
  await storage.saveTempSessionPk(null)

  return { statePath }
}

// --- Helpers ---

function getPassphrase(): string {
  // Ephemeral per-invocation passphrase — we rebuild state each time from SessionPayload,
  // so the passphrase doesn't need to be stable across runs.
  if (!process.env._POLYGON_AGENT_CLI_PASSPHRASE) {
    process.env._POLYGON_AGENT_CLI_PASSPHRASE = randomBytes(32).toString('hex')
  }
  return process.env._POLYGON_AGENT_CLI_PASSPHRASE
}

function resolveDappClientCliBin(): string {
  // Resolve the dapp-client-cli entry point from node_modules
  const require = createRequire(import.meta.url)
  const cliPkg = require.resolve('@0xsequence/dapp-client-cli/package.json')
  return join(dirname(cliPkg), 'dist', 'index.js')
}

function buildCliEnv(session: SessionPayload): Record<string, string | undefined> {
  return {
    ...process.env,
    DAPP_CLIENT_CLI_ACCESS_KEY: session.project_access_key,
    ACCESS_KEY: session.project_access_key,
    PROJECT_ACCESS_KEY: session.project_access_key,
    WALLET_URL: session.ecosystem_wallet_url,
    ORIGIN: session.ecosystem_wallet_url,
    NODES_URL: process.env.SEQUENCE_NODES_URL || 'https://nodes.sequence.app/{network}',
    RELAYER_URL: session.relayer_url || process.env.SEQUENCE_RELAYER_URL || 'https://{network}-relayer.sequence.app',
    KEYMACHINE_URL: process.env.SEQUENCE_KEYMACHINE_URL || 'https://keymachine.sequence.app',
  }
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`Command failed: ${cmd} ${args.slice(0, 3).join(' ')}...\n${stderr || stdout}`)
        e.cause = err
        return reject(e)
      }
      resolve({ stdout: stdout as string, stderr: stderr as string })
    })
  })
}

/** Parse JSON from potentially mixed stdout (deps may print logs before JSON) */
function parseJsonFromMixedOutput(text: string): any {
  const s = String(text || '').trim()
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== '{' && ch !== '[') continue
    try {
      return JSON.parse(s.slice(i))
    } catch {}
  }
  throw new Error(`Could not find JSON in CLI output: ${s.slice(0, 200)}`)
}
