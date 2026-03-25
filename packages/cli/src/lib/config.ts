import 'dotenv/config'

export const RELAY_URL = process.env.POLYGON_AGENT_RELAY_URL ?? 'https://relay.polygon.agent.xyz'
export const KEYCHAIN_SERVICE = 'polygon.agent.wallet'

export function getEnv(key: string, fallback?: string): string {
  const val = process.env[key]
  if (val) return val
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required environment variable: ${key}`)
}

/**
 * Convert a human-readable decimal string (e.g. "1.5") to smallest-unit integer string
 * using string manipulation to avoid IEEE 754 float precision loss.
 * parseUnitsString("1.5", 18) → "1500000000000000000"
 */
export function parseUnitsString(amount: string, decimals: number): string {
  const [intPart, fracPart = ''] = amount.split('.')
  const paddedFrac = fracPart.slice(0, decimals).padEnd(decimals, '0')
  const raw = intPart + paddedFrac
  return raw.replace(/^0+/, '') || '0'
}

const CHAIN_MAP: Record<string, number> = {
  polygon: 137,
  'polygon-amoy': 80002,
  arbitrum: 42161,
  'arbitrum-nova': 42170,
  optimism: 10,
  base: 8453,
}

export function resolveChainId(chain: string): number {
  const id = parseInt(chain, 10)
  if (!isNaN(id) && id > 0) return id
  const mapped = CHAIN_MAP[chain.toLowerCase()]
  if (!mapped) throw new Error(`Unknown chain: ${chain}. Known: ${Object.keys(CHAIN_MAP).join(', ')}`)
  return mapped
}
