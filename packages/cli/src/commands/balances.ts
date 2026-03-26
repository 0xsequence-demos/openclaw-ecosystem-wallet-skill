import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { fetchBalances, formatUnits } from '../lib/balances.js'
import { handleErrors } from '../lib/errors.js'

export const balancesCommand = new Command('balances')
  .description('Show token balances for a stored wallet')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .action(handleErrors(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(`No session found for "${opts.name}".`)
      process.exit(1)
    }

    const balances = await fetchBalances(session)

    if (balances.length === 0) {
      console.log('No balances found.')
      return
    }

    for (const b of balances) {
      const raw = BigInt(b.balance)
      const formatted = formatUnits(raw, b.decimals)
      const addr = b.contractAddress === '0x0000000000000000000000000000000000000000'
        ? '(native)'
        : b.contractAddress
      console.log(`  ${b.symbol.padEnd(10)} ${formatted.padStart(20)}  ${addr}`)
    }
  }))
