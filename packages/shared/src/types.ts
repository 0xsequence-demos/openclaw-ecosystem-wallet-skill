export interface SessionPayload {
  version: 1
  wallet_address: string
  chain_id: number
  session_private_key: string
  session_address: string
  permissions: SessionPermissions
  expiry: number
  ecosystem_wallet_url: string
  project_access_key: string
  relayer_url?: string
}

export interface SessionPermissions {
  native_limit?: string
  erc20_limits?: Array<{ token_address: string; limit: string }>
  contract_calls?: Array<{ address: string; functions: string[] }>
}

export interface RelayPayload {
  wallet_pk: string
  nonce: string
  ciphertext: string
}

export interface RelaySessionPost extends RelayPayload {
  code_hash: string
}

export interface EncryptResult extends RelaySessionPost {
  code_plaintext: string
}
