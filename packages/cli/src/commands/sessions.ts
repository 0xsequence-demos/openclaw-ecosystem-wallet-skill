import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'

export const sessionsCommand = new Command('sessions')
  .description('List all stored wallet sessions')
  .action(async () => {
    const sessions = await keychain.listSessions()
    if (sessions.length === 0) {
      console.log('No sessions stored. Run "polygon-agent connect" to add one.')
      return
    }
    for (const { name, session } of sessions) {
      const expired = session.expiry * 1000 < Date.now()
      const expiryStr = new Date(session.expiry * 1000).toLocaleString()
      console.log(`  ${name}: ${session.wallet_address} (chain ${session.chain_id}) — expires ${expiryStr}${expired ? ' [EXPIRED]' : ''}`)
    }
  })
