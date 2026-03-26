export interface SessionPayload {
  version: 1
  wallet_address: string
  chain_id: number
  session_private_key: string
  session_address: string
  permissions: SessionPermissions
  expiry: number
  ecosystem_wallet_url: string
  /** The origin URL where the session was approved (dApp/connector origin) */
  dapp_origin: string
  project_access_key: string
  relayer_url?: string
  /** Full session config object as passed to dappClient.connect().
   *  Serialized with jsonReplacers for BigInt safety. */
  session_config?: string
  /** Implicit session material (optional, not used in v1 connect flow) */
  implicit_session?: ImplicitSession
}

export interface SessionPermissions {
  native_limit?: string
  erc20_limits?: Array<{ token_address: string; limit: string }>
  contract_calls?: Array<{ address: string; functions: string[] }>
}

export interface ImplicitSession {
  pk: string
  /** Attestation object, pre-serialized with jsonReplacers to preserve Uint8Arrays */
  attestation: string
  identity_signature: string
  chain_id: number
  /** Guard object, pre-serialized with jsonReplacers to preserve Sets */
  guard?: string
  login_method?: string
  user_email?: string
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
