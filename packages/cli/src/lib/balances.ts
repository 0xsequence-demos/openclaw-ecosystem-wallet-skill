import type { SessionPayload } from '@polygon-agent/shared'
import { getEnv } from './config.js'

interface TokenBalance {
  contractAddress: string
  symbol: string
  decimals: number
  balance: string
}

export async function fetchBalances(session: SessionPayload): Promise<TokenBalance[]> {
  const indexerKey = session.project_access_key || getEnv('SEQUENCE_PROJECT_ACCESS_KEY')
  const indexerUrl = process.env.SEQUENCE_INDEXER_URL ??
    'https://indexer.sequence.app/rpc/IndexerGateway/GetTokenBalancesSummary'

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
    throw new Error(`Indexer error: ${res.status} ${res.statusText}`)
  }

  const data = await res.json() as any
  const chainId = session.chain_id
  const balances: TokenBalance[] = []

  // Native balances: array of { chainId, results: [{ symbol, balance, ... }] }
  const nativeEntry = (data.nativeBalances || []).find((e: any) => e.chainId === chainId)
  if (nativeEntry?.results) {
    for (const r of nativeEntry.results) {
      if (r.balance && r.balance !== '0') {
        balances.push({
          contractAddress: '0x0000000000000000000000000000000000000000',
          symbol: r.symbol || r.name || 'NATIVE',
          decimals: 18,
          balance: r.balance,
        })
      }
    }
  }

  // Token balances: array of { chainId, results: [{ contractAddress, balance, contractInfo, ... }] }
  const tokenEntry = (data.balances || []).find((e: any) => e.chainId === chainId)
  if (tokenEntry?.results) {
    for (const r of tokenEntry.results) {
      if (r.balance && r.balance !== '0') {
        balances.push({
          contractAddress: r.contractAddress || r.contractInfo?.address || '',
          symbol: r.contractInfo?.symbol || '???',
          decimals: r.contractInfo?.decimals ?? 18,
          balance: r.balance,
        })
      }
    }
  }

  return balances
}

export async function checkNativeBalance(session: SessionPayload, amountWei: string): Promise<void> {
  const balances = await fetchBalances(session)
  const native = balances.find(b => b.contractAddress === '0x0000000000000000000000000000000000000000')
  const balance = BigInt(native?.balance || '0')
  const required = BigInt(amountWei)

  if (balance < required) {
    const symbol = native?.symbol || 'native token'
    throw new Error(
      `Insufficient ${symbol} balance: have ${formatUnits(balance, 18)}, need ${formatUnits(required, 18)}. ` +
      `Fund wallet ${session.wallet_address}`
    )
  }
}

export async function checkTokenBalance(
  session: SessionPayload,
  contractAddress: string,
  symbol: string,
  decimals: number,
  amountRaw: string,
): Promise<void> {
  const balances = await fetchBalances(session)
  const token = balances.find(b => b.contractAddress.toLowerCase() === contractAddress.toLowerCase())
  const balance = BigInt(token?.balance || '0')
  const required = BigInt(amountRaw)

  if (balance < required) {
    throw new Error(
      `Insufficient ${symbol} balance: have ${formatUnits(balance, decimals)}, need ${formatUnits(required, decimals)}. ` +
      `Fund wallet ${session.wallet_address}`
    )
  }
}

export function formatUnits(raw: bigint, decimals: number): string {
  const str = raw.toString().padStart(decimals + 1, '0')
  const intPart = str.slice(0, str.length - decimals) || '0'
  const fracPart = str.slice(str.length - decimals).replace(/0+$/, '')
  return fracPart ? `${intPart}.${fracPart}` : intPart
}
