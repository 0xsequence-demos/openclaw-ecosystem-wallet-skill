import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { getEnv } from '../lib/config.js'

export const balancesCommand = new Command('balances')
  .description('Show token balances for a stored wallet')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .action(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(`No session found for "${opts.name}".`)
      process.exit(1)
    }

    const indexerKey = getEnv('SEQUENCE_INDEXER_ACCESS_KEY', session.project_access_key)
    const indexerUrl = process.env.SEQUENCE_INDEXER_URL ??
      'https://indexer.sequence.app/rpc/Indexer/GetTokenBalancesSummary'

    const res = await fetch(indexerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Key': indexerKey,
      },
      body: JSON.stringify({
        omitMetadata: false,
        filter: {
          contractStatus: 'VERIFIED',
          accountAddresses: [session.wallet_address],
        },
      }),
    })

    if (!res.ok) {
      console.error(`Indexer error: ${res.status} ${res.statusText}`)
      process.exit(1)
    }

    const data = await res.json() as Record<string, unknown>
    console.log(JSON.stringify(data, null, 2))
  })
