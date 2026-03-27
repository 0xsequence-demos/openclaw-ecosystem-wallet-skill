import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { sendTransaction } from '../lib/transaction.js'
import { resolveErc20BySymbol } from '../lib/token-directory.js'
import { parseUnitsString } from '../lib/config.js'
import { checkTokenBalance } from '../lib/balances.js'
import { handleErrors } from '../lib/errors.js'
import { ui } from '../lib/ui.js'

export const sendTokenCommand = new Command('send-token')
  .description('Send token by symbol (resolved via token directory)')
  .requiredOption('--symbol <symbol>', 'Token symbol (e.g. USDC)')
  .requiredOption('--to <address>', 'Recipient address')
  .requiredOption('--amount <amount>', 'Amount in human units')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .option('--broadcast', 'Actually send the transaction', false)
  .action(handleErrors(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(ui.error(`No session found for "${opts.name}".`))
      process.exit(1)
    }

    let spinner = ui.spinner(`Resolving ${opts.symbol}…`)
    const token = await resolveErc20BySymbol(session.chain_id, opts.symbol)
    if (!token) {
      spinner.fail(`Token "${opts.symbol}" not found for chain ${session.chain_id}`)
      process.exit(1)
    }
    spinner.succeed(`${ui.token(token.symbol)} — ${token.name} (${token.decimals} decimals)`)

    const rawAmount = BigInt(parseUnitsString(opts.amount, token.decimals))
    const selector = 'a9059cbb'
    const toPadded = opts.to.replace(/^0x/, '').padStart(64, '0')
    const amountPadded = rawAmount.toString(16).padStart(64, '0')
    const data = '0x' + selector + toPadded + amountPadded

    const tx = { to: token.address, data }

    if (!opts.broadcast) {
      ui.dryRun([
        ['Token', ui.token(token.symbol) + ` at ${ui.shortAddress(token.address)}`],
        ['To', ui.address(opts.to)],
        ['Amount', ui.amount(opts.amount) + ` ${token.symbol}`],
        ['From', ui.shortAddress(session.wallet_address)],
        ['Chain', ui.chain(session.chain_id)],
      ])
      return
    }

    spinner = ui.spinner(`Checking ${token.symbol} balance…`)
    await checkTokenBalance(session, token.address, token.symbol, token.decimals, rawAmount.toString())
    spinner.succeed('Balance sufficient')

    spinner = ui.spinner('Sending transaction…')
    const result = await sendTransaction(session, [tx], (step) => {
      spinner.text = step
    })
    spinner.succeed('Transaction confirmed')

    ui.txResult(result.txHash, session.chain_id, [
      ['Amount', ui.amount(opts.amount) + ` ${ui.token(token.symbol)}`],
      ['To', ui.address(opts.to)],
    ])
  }))
