import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { ui } from '../lib/ui.js'

export const disconnectCommand = new Command('disconnect')
  .description('Remove a stored wallet session')
  .option('--name <name>', 'Wallet alias', 'default')
  .action(async (opts) => {
    const deleted = await keychain.deleteSession(opts.name)
    if (deleted) {
      console.log(ui.success(`Session "${opts.name}" removed.`))
    } else {
      console.log(ui.warn(`No session found for "${opts.name}".`))
    }
  })
