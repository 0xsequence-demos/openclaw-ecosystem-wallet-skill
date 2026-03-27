import { Command } from 'commander'
import { generateX25519Keypair, decryptSession, bytesToHex, hexToBytes, base64urlToBytes } from '@polygon-agent/shared'
import open from 'open'
import prompts from 'prompts'
import * as relay from '../lib/relay-client.js'
import * as keychain from '../lib/keychain.js'
import { RELAY_URL, resolveChainId } from '../lib/config.js'
import { ui } from '../lib/ui.js'

export const connectCommand = new Command('connect')
  .description('Connect a Polygon Ecosystem Wallet via browser')
  .option('--name <name>', 'Wallet alias for local storage', 'default')
  .option('--chain <chain>', 'Chain name or ID', 'polygon')
  .option('--relay-url <url>', 'Relay URL override')
  .option('--native-limit <amount>', 'Max native token spend in session (human units, e.g. "1.0")')
  .option('--token-limits <limits>', 'ERC20 spend limits (e.g. "USDC:50,USDT:50,WETH:0.1")')
  .option('--session-expiry <dur>', 'Session duration (default: "24h", max: "7d")', '24h')
  .option('--no-browser', 'Print URL instead of auto-opening browser')
  .action(async (opts) => {
    try {
      const chainId = resolveChainId(opts.chain)

      // 1. Generate ephemeral X25519 keypair
      const { secretKey: cli_sk, publicKey: cli_pk } = generateX25519Keypair()
      const cli_pk_hex = bytesToHex(cli_pk)

      // 2. Register with relay
      const spinner = ui.spinner('Registering with relay…')
      const request_id = await relay.createRequest(cli_pk_hex)
      spinner.succeed('Registered with relay')

      // 3. Open browser
      const relayUrl = opts.relayUrl ?? RELAY_URL
      const params = new URLSearchParams({ rid: request_id, chain: String(chainId) })
      if (opts.nativeLimit) params.set('native_limit', opts.nativeLimit)
      if (opts.tokenLimits) params.set('token_limits', opts.tokenLimits)
      if (opts.sessionExpiry) params.set('expiry', opts.sessionExpiry)
      const connectUrl = `${relayUrl}/agent?${params}`

      if (opts.browser !== false) {
        await open(connectUrl)
        console.log(ui.info(`Browser opened. If it didn't, visit:\n  ${connectUrl}\n`))
      } else {
        console.log(ui.info(`Open this URL in your browser:\n  ${connectUrl}\n`))
      }

      // 4. Poll for status
      const pollSpinner = ui.spinner('Waiting for wallet connection…')
      const deadline = Date.now() + 300_000
      let status = 'pending'
      while (status === 'pending' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500))
        try {
          status = await relay.getStatus(request_id)
        } catch {
          // Transient error, keep polling
        }
      }

      if (status !== 'ready') {
        pollSpinner.fail('Timed out waiting for wallet connection.')
        cli_sk.fill(0)
        process.exit(1)
      }
      pollSpinner.succeed('Session approved in browser')

      // 5. Prompt for code
      const { code } = await prompts({
        type: 'text',
        name: 'code',
        message: 'Enter the 6-digit code from your browser',
        validate: (v: string) => /^\d{6}$/.test(v) || 'Must be exactly 6 digits',
      })

      if (!code) {
        console.log('Cancelled.')
        cli_sk.fill(0)
        process.exit(1)
      }

      // 6. Retrieve encrypted payload
      const retrieveSpinner = ui.spinner('Verifying code…')
      let payload
      try {
        payload = await relay.retrieve(request_id, code)
      } catch (e) {
        retrieveSpinner.fail(e instanceof Error ? e.message : 'Retrieval failed')
        cli_sk.fill(0)
        process.exit(1)
      }
      retrieveSpinner.succeed('Code verified')

      // 7. Decrypt
      const wallet_pk = hexToBytes(payload.wallet_pk)
      const nonce = hexToBytes(payload.nonce)
      const ciphertext = base64urlToBytes(payload.ciphertext)

      const session = decryptSession(cli_sk, cli_pk, wallet_pk, nonce, ciphertext, code)

      // 8. Store in Keychain
      const storeSpinner = ui.spinner('Storing session…')
      await keychain.storeSession(opts.name, session)
      storeSpinner.succeed('Session stored securely')

      // 9. Print summary
      console.log('\n' + ui.success(`Connected`))
      ui.kv('Wallet', ui.address(session.wallet_address))
      ui.kv('Chain', ui.chain(session.chain_id))
      ui.kv('Expires', new Date(session.expiry * 1000).toLocaleString())
      ui.kv('Alias', `"${opts.name}"`)
      console.log()

      // 10. Cleanup
      cli_sk.fill(0)
    } catch (e) {
      console.error(ui.error(e instanceof Error ? e.message : 'Connection failed'))
      process.exit(1)
    }
  })
