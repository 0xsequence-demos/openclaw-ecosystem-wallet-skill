import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { ui } from '../lib/ui.js'

export const addressCommand = new Command('address')
  .description('Show wallet address for a stored session')
  .option('--name <name>', 'Wallet alias', 'default')
  .action(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(ui.error(`No session found for "${opts.name}". Run "polygon-agent connect" first.`))
      process.exit(1)
    }
    console.log(ui.address(session.wallet_address))
  })
