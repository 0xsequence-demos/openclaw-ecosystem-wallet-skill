const TOKEN_DIR_RAW = 'https://raw.githubusercontent.com/0xsequence/token-directory/main'
const INDEX_TTL_MS = 10 * 60 * 1000

export interface Token {
  chainId: number
  address: string
  symbol: string
  name: string
  decimals: number
}

export async function resolveErc20Symbol(chainId: number, symbol: string): Promise<Token | null> {
  const sym = symbol.toUpperCase().trim()
  if (!sym) return null

  const list = await loadErc20List(chainId)
  const tokens: any[] = Array.isArray(list) ? list : list?.tokens
  if (!Array.isArray(tokens)) return null

  const matches = tokens.filter((t: any) => String(t?.symbol || '').toUpperCase() === sym)
  if (!matches.length) return null

  const pick = matches.find((t: any) => t?.extensions?.verified === true)
    || matches.find((t: any) => t?.logoURI)
    || matches[0]

  return {
    chainId: Number(pick.chainId ?? chainId),
    address: pick.address,
    symbol: pick.symbol,
    name: pick.name,
    decimals: pick.decimals,
  }
}

// --- Internal (localStorage cache) ---

function cacheGet(key: string): any | null {
  try {
    const raw = localStorage.getItem(`token-dir:${key}`)
    if (!raw) return null
    const { ts, data } = JSON.parse(raw)
    if (key.startsWith('index') && Date.now() - ts > INDEX_TTL_MS) return null
    return data
  } catch { return null }
}

function cacheSet(key: string, data: any): void {
  try {
    localStorage.setItem(`token-dir:${key}`, JSON.stringify({ ts: Date.now(), data }))
  } catch {}
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  return res.json()
}

async function loadIndex(): Promise<any> {
  const cached = cacheGet('index')
  if (cached) return cached
  const json = await fetchJson(`${TOKEN_DIR_RAW}/index/index.json`)
  cacheSet('index', json)
  return json
}

async function loadErc20List(chainId: number): Promise<any> {
  const index = await loadIndex()
  const idx = index?.index
  if (!idx) throw new Error('Empty token directory index')

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
  if (!chainName || !sha256) throw new Error(`No token list for chain ${chainId}`)

  const cacheKey = `erc20:${chainId}:${sha256.slice(0, 12)}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  const list = await fetchJson(`${TOKEN_DIR_RAW}/index/${chainName}/erc20.json`)
  cacheSet(cacheKey, list)
  return list
}
