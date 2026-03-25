import type { SessionPayload } from '@polygon-agent/shared'

export interface Transaction {
  to: string
  value?: string
  data?: string
}

export async function sendTransaction(
  session: SessionPayload,
  transactions: Transaction[],
): Promise<{ txHash: string }> {
  // TODO: Port from cli/sequence-eco/dapp-client-cli-bridge.mjs
  // This involves:
  // 1. Reconstructing dapp-client-cli encrypted state from SessionPayload
  // 2. Spawning dapp-client-cli subprocess for fee-options
  // 3. Spawning dapp-client-cli subprocess for send-transaction
  // 4. Parsing JSON from mixed stdout
  throw new Error(
    'Transaction sending not yet implemented. Port from cli/sequence-eco/dapp-client-cli-bridge.mjs'
  )
}
