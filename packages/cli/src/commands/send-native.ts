import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { sendTransaction } from '../lib/transaction.js'
import { parseUnitsString } from '../lib/config.js'

// Session permissions are scoped to the ValueForwarder contract.
// Native sends must go through it: forwardValue(address to, uint256 value)
const VALUE_FORWARDER = '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca'
const FORWARD_VALUE_SELECTOR = '0x98f850f1' // forwardValue(address,uint256)

function pad(hex: string, n = 64): string {
  return hex.replace(/^0x/, '').padStart(n, '0')
}

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
    const value = '0x' + BigInt(wei).toString(16)

    // Route through ValueForwarder (required by session permissions)
    const data = FORWARD_VALUE_SELECTOR + pad(opts.to) + pad('0x' + BigInt(wei).toString(16))
    const tx = { to: VALUE_FORWARDER, value, data }

    if (!opts.broadcast) {
      console.log('Dry run (add --broadcast to send):')
      console.log(`  To: ${opts.to}`)
      console.log(`  Amount: ${opts.amount} (${wei} wei)`)
      console.log(`  Via: ValueForwarder ${VALUE_FORWARDER}`)
      return
    }

    const result = await sendTransaction(session, [tx])
    console.log(`Transaction sent: ${result.txHash}`)
  })
