import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { fetchBalances, formatUnits } from '../lib/balances.js'
import { handleErrors } from '../lib/errors.js'
import { ui } from '../lib/ui.js'

export const balancesCommand = new Command('balances')
  .description('Show token balances for a stored wallet')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .action(handleErrors(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(ui.error(`No session found for "${opts.name}".`))
      process.exit(1)
    }

    const spinner = ui.spinner('Fetching balances…')
    const balances = await fetchBalances(session)
    spinner.stop()

    ui.header(`Balances — ${session.wallet_address.slice(0, 6)}…${session.wallet_address.slice(-4)}`)
    ui.kv('Wallet', ui.address(session.wallet_address))
    ui.kv('Chain', ui.chain(session.chain_id))
    console.log()

    const rows = balances.map(b => ({
      symbol: b.symbol,
      amount: formatUnits(BigInt(b.balance), b.decimals),
      address: b.contractAddress === '0x0000000000000000000000000000000000000000'
        ? '(native)'
        : b.contractAddress,
    }))

    ui.balanceTable(rows)
    console.log()
  }))
