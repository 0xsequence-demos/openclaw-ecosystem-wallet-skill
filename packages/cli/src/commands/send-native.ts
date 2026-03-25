import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { sendTransaction } from '../lib/transaction.js'
import { parseUnitsString } from '../lib/config.js'

export const sendNativeCommand = new Command('send-native')
  .description('Send native token (POL/ETH)')
  .requiredOption('--to <address>', 'Recipient address')
  .requiredOption('--amount <amount>', 'Amount in human units (e.g. "1.5")')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .option('--broadcast', 'Actually send the transaction', false)
  .action(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(`No session found for "${opts.name}".`)
      process.exit(1)
    }

    const wei = parseUnitsString(opts.amount, 18)
    const tx = { to: opts.to, value: '0x' + BigInt(wei).toString(16) }

    if (!opts.broadcast) {
      console.log('Dry run (add --broadcast to send):')
      console.log(JSON.stringify(tx, null, 2))
      return
    }

    const result = await sendTransaction(session, [tx])
    console.log(`✓ Transaction sent: ${result.txHash}`)
  })
