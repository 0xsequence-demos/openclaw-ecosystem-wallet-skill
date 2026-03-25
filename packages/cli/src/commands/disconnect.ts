import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'

export const disconnectCommand = new Command('disconnect')
  .description('Remove a stored wallet session')
  .option('--name <name>', 'Wallet alias', 'default')
  .action(async (opts) => {
    const deleted = await keychain.deleteSession(opts.name)
    if (deleted) {
      console.log(`Session "${opts.name}" removed.`)
    } else {
      console.log(`No session found for "${opts.name}".`)
    }
  })
