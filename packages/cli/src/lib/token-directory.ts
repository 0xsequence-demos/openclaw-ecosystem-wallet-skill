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
): Promise<Token | null> {
  // TODO: Port from cli/sequence-eco/token-directory.mjs
  throw new Error(
    'Token directory not yet implemented. Port from cli/sequence-eco/token-directory.mjs'
  )
}
