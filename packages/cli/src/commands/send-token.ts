import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { sendTransaction } from '../lib/transaction.js'
import { resolveErc20BySymbol } from '../lib/token-directory.js'
import { parseUnitsString } from '../lib/config.js'

export const sendTokenCommand = new Command('send-token')
  .description('Send token by symbol (resolved via token directory)')
  .requiredOption('--symbol <symbol>', 'Token symbol (e.g. USDC)')
  .requiredOption('--to <address>', 'Recipient address')
  .requiredOption('--amount <amount>', 'Amount in human units')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .option('--broadcast', 'Actually send the transaction', false)
  .action(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(`No session found for "${opts.name}".`)
      process.exit(1)
    }

    const token = await resolveErc20BySymbol(session.chain_id, opts.symbol)
    if (!token) {
      console.error(`Token "${opts.symbol}" not found for chain ${session.chain_id}`)
      process.exit(1)
    }

    console.log(`Resolved: ${token.name} (${token.symbol}) at ${token.address}, ${token.decimals} decimals`)

    const rawAmount = BigInt(parseUnitsString(opts.amount, token.decimals))
    const selector = 'a9059cbb'
    const toPadded = opts.to.replace(/^0x/, '').padStart(64, '0')
    const amountPadded = rawAmount.toString(16).padStart(64, '0')
    const data = '0x' + selector + toPadded + amountPadded

    const tx = { to: token.address, data }

    if (!opts.broadcast) {
      console.log('Dry run (add --broadcast to send):')
      console.log(JSON.stringify(tx, null, 2))
      return
    }

    const result = await sendTransaction(session, [tx])
    console.log(`✓ Transaction sent: ${result.txHash}`)
  })
