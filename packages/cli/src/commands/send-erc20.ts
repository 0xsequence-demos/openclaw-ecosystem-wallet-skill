import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { sendTransaction } from '../lib/transaction.js'
import { parseUnitsString } from '../lib/config.js'
import { checkTokenBalance } from '../lib/balances.js'
import { handleErrors } from '../lib/errors.js'

export const sendErc20Command = new Command('send-erc20')
  .description('Send ERC20 token by contract address')
  .requiredOption('--token <address>', 'ERC20 token contract address')
  .requiredOption('--to <address>', 'Recipient address')
  .requiredOption('--amount <amount>', 'Amount in human units')
  .requiredOption('--decimals <decimals>', 'Token decimals')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .option('--broadcast', 'Actually send the transaction', false)
  .action(handleErrors(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(`No session found for "${opts.name}".`)
      process.exit(1)
    }

    const decimals = parseInt(opts.decimals, 10)
    const rawAmount = BigInt(parseUnitsString(opts.amount, decimals))

    const selector = 'a9059cbb'
    const toPadded = opts.to.replace(/^0x/, '').padStart(64, '0')
    const amountPadded = rawAmount.toString(16).padStart(64, '0')
    const data = '0x' + selector + toPadded + amountPadded

    const tx = { to: opts.token, data }

    if (!opts.broadcast) {
      console.log('Dry run (add --broadcast to send):')
      console.log(JSON.stringify(tx, null, 2))
      return
    }

    await checkTokenBalance(session, opts.token, opts.token, decimals, rawAmount.toString())

    const result = await sendTransaction(session, [tx])
    console.log(`Transaction sent: ${result.txHash}`)
  }))
