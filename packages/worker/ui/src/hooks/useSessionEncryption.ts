import { useState } from 'react'
import { encryptSession, hexToBytes } from '@polygon-agent/shared'
import type { SessionPayload } from '@polygon-agent/shared'
import { postEncryptedSession } from '../lib/relay-api.js'

interface UseSessionEncryptionResult {
  encrypt: (rid: string, session: SessionPayload, cliPkHex: string) => Promise<string>
  code: string | null
  status: 'idle' | 'encrypting' | 'posted' | 'error'
  error: string | null
}

export function useSessionEncryption(): UseSessionEncryptionResult {
  const [code, setCode] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'encrypting' | 'posted' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function encrypt(rid: string, session: SessionPayload, cliPkHex: string): Promise<string> {
    try {
      setStatus('encrypting')

      const cli_pk_bytes = hexToBytes(cliPkHex)

      const result = encryptSession(cli_pk_bytes, session, rid)

      await postEncryptedSession(rid, {
        wallet_pk: result.wallet_pk,
        nonce: result.nonce,
        ciphertext: result.ciphertext,
        code_hash: result.code_hash,
      })

      setCode(result.code_plaintext)
      setStatus('posted')
      return result.code_plaintext
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Encryption failed')
      setStatus('error')
      throw e
    }
  }

  return { encrypt, code, status, error }
}
