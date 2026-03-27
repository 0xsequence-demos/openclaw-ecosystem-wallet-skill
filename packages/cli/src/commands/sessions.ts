import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { ui } from '../lib/ui.js'

export const sessionsCommand = new Command('sessions')
  .description('List all stored wallet sessions')
  .action(async () => {
    const sessions = await keychain.listSessions()
    if (sessions.length === 0) {
      console.log(ui.info('No sessions stored. Run "polygon-agent connect" to add one.'))
      return
    }
    ui.header('Wallet Sessions')
    console.log()
    for (const { name, session } of sessions) {
      const expired = session.expiry * 1000 < Date.now()
      const expiryStr = new Date(session.expiry * 1000).toLocaleString()
      ui.sessionRow(name, session.wallet_address, session.chain_id, expiryStr, expired)
    }
    console.log()
  })
