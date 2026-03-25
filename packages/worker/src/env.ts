import type { SessionRelay } from './relay/session-relay.js'

export interface Env {
  SESSION_RELAY: DurableObjectNamespace<SessionRelay>
  ASSETS: Fetcher
  ECOSYSTEM_WALLET_URL: string
  PROJECT_ACCESS_KEY?: string
  INDEXER_ACCESS_KEY?: string
  DEFAULT_CHAIN_ID: string
}
