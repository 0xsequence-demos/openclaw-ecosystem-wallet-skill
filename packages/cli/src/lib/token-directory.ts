import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TOKEN_DIR_RAW = 'https://raw.githubusercontent.com/0xsequence/token-directory'
const CACHE_DIR = join(homedir(), '.polygon-agent', 'cache', 'token-directory')
const INDEX_TTL_MS = 10 * 60 * 1000 // 10 minutes

export interface Token {
  chainId: number
  address: string
  symbol: string
  name: string
  decimals: number
  logoURI: string | null
}

export async function resolveErc20BySymbol(
  chainId: number,
  symbol: string,
  ref = 'main',
): Promise<Token | null> {
  const sym = symbol.toUpperCase().trim()
  if (!sym) throw new Error('Missing token symbol')

  const list = await loadErc20List(chainId, ref)
  const tokens: any[] = Array.isArray(list) ? list : list?.tokens
  if (!Array.isArray(tokens)) throw new Error('Unexpected token list format')

  const matches = tokens.filter((t: any) => String(t?.symbol || '').toUpperCase() === sym)
  if (!matches.length) return null

  // Prefer verified, then with logo, then first match
  const pick = matches.find((t: any) => t?.extensions?.verified === true)
    || matches.find((t: any) => t?.logoURI)
    || matches[0]

  return {
    chainId: Number(pick.chainId ?? chainId),
    address: pick.address,
    symbol: pick.symbol,
    name: pick.name,
    decimals: pick.decimals,
    logoURI: pick.logoURI || null,
  }
}

// --- Internal ---

async function loadIndex(ref: string): Promise<any> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const fp = join(CACHE_DIR, `index.${ref}.json`)

  if (existsSync(fp)) {
    try {
      const st = statSync(fp)
      if (Date.now() - st.mtimeMs < INDEX_TTL_MS) {
        return JSON.parse(readFileSync(fp, 'utf8'))
      }
    } catch {}
  }

  const json = await fetchJson(`${TOKEN_DIR_RAW}/${ref}/index/index.json`)
  writeFileSync(fp, JSON.stringify(json), 'utf8')
  return json
}

async function loadErc20List(chainId: number, ref: string): Promise<any> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const index = await loadIndex(ref)

  // Find chain folder in index
  const idx = index?.index
  if (!idx || typeof idx !== 'object') throw new Error(`Token directory index is empty`)

  let chainName: string | null = null
  let sha256: string | null = null

  for (const [name, meta] of Object.entries(idx) as [string, any][]) {
    if (name === '_external') continue
    if (String(meta?.chainId) === String(chainId)) {
      chainName = name
      sha256 = meta?.tokenLists?.['erc20.json'] || null
      break
    }
  }

  if (!chainName) throw new Error(`No token list for chain ${chainId}`)
  if (!sha256) throw new Error(`No erc20 list for chain ${chainId} (${chainName})`)

  const cacheKey = `${chainId}.erc20.${ref}.${sha256.slice(0, 12)}.json`
  const fp = join(CACHE_DIR, cacheKey)

  if (existsSync(fp)) {
    try { return JSON.parse(readFileSync(fp, 'utf8')) } catch {}
  }

  const list = await fetchJson(`${TOKEN_DIR_RAW}/${ref}/index/${chainName}/erc20.json`)
  writeFileSync(fp, JSON.stringify(list), 'utf8')
  return list
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`fetch ${url} failed: ${res.status} ${text}`)
  }
  return res.json()
}
