import { describe, it, expect } from 'vitest'
import { x25519 } from '@noble/curves/ed25519'
import { encryptSession, decryptSession, hashCode } from './crypto.js'
import { hexToBytes, base64urlToBytes } from './encoding.js'
import type { SessionPayload } from './types.js'

const MOCK_SESSION: SessionPayload = {
  version: 1,
  wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
  chain_id: 137,
  session_private_key: '0x' + 'ab'.repeat(32),
  session_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  permissions: { native_limit: '1000000000000000000' },
  expiry: Math.floor(Date.now() / 1000) + 86400,
  ecosystem_wallet_url: 'https://wallet.polygon.technology',
  dapp_origin: 'https://polygon-agent-relay.0xsequence.workers.dev',
  project_access_key: 'test-access-key',
}

describe('crypto round-trip', () => {
  it('encrypts and decrypts a session payload', () => {
    const cli_sk = x25519.utils.randomPrivateKey()
    const cli_pk = x25519.getPublicKey(cli_sk)
    const request_id = 'testrid1'

    const encrypted = encryptSession(cli_pk, MOCK_SESSION, request_id)

    expect(encrypted.wallet_pk).toHaveLength(64)
    expect(encrypted.nonce).toHaveLength(48)
    expect(encrypted.ciphertext).toBeTruthy()
    expect(encrypted.code_hash).toHaveLength(64)
    expect(encrypted.code_plaintext).toMatch(/^\d{6}$/)

    const decrypted = decryptSession(
      cli_sk,
      cli_pk,
      hexToBytes(encrypted.wallet_pk),
      hexToBytes(encrypted.nonce),
      base64urlToBytes(encrypted.ciphertext),
      encrypted.code_plaintext,
    )

    expect(decrypted).toEqual(MOCK_SESSION)
  })

  it('fails decryption with wrong code', () => {
    const cli_sk = x25519.utils.randomPrivateKey()
    const cli_pk = x25519.getPublicKey(cli_sk)

    const encrypted = encryptSession(cli_pk, MOCK_SESSION, 'testrid2')
    const wrongCode = encrypted.code_plaintext === '000000' ? '000001' : '000000'

    expect(() =>
      decryptSession(
        cli_sk, cli_pk,
        hexToBytes(encrypted.wallet_pk),
        hexToBytes(encrypted.nonce),
        base64urlToBytes(encrypted.ciphertext),
        wrongCode,
      ),
    ).toThrow()
  })

  it('fails decryption with tampered ciphertext', () => {
    const cli_sk = x25519.utils.randomPrivateKey()
    const cli_pk = x25519.getPublicKey(cli_sk)

    const encrypted = encryptSession(cli_pk, MOCK_SESSION, 'testrid3')
    const ct = base64urlToBytes(encrypted.ciphertext)
    ct[0] ^= 0xff

    expect(() =>
      decryptSession(
        cli_sk, cli_pk,
        hexToBytes(encrypted.wallet_pk),
        hexToBytes(encrypted.nonce),
        ct,
        encrypted.code_plaintext,
      ),
    ).toThrow()
  })

  it('fails decryption with wrong CLI private key', () => {
    const cli_sk = x25519.utils.randomPrivateKey()
    const cli_pk = x25519.getPublicKey(cli_sk)
    const wrong_sk = x25519.utils.randomPrivateKey()

    const encrypted = encryptSession(cli_pk, MOCK_SESSION, 'testrid4')

    expect(() =>
      decryptSession(
        wrong_sk, cli_pk,
        hexToBytes(encrypted.wallet_pk),
        hexToBytes(encrypted.nonce),
        base64urlToBytes(encrypted.ciphertext),
        encrypted.code_plaintext,
      ),
    ).toThrow()
  })
})

describe('hashCode', () => {
  it('produces consistent hashes', () => {
    const h1 = hashCode('request1', '123456')
    const h2 = hashCode('request1', '123456')
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(64)
  })

  it('produces different hashes for different codes', () => {
    expect(hashCode('request1', '123456')).not.toBe(hashCode('request1', '654321'))
  })

  it('produces different hashes for different request IDs', () => {
    expect(hashCode('request1', '123456')).not.toBe(hashCode('request2', '123456'))
  })
})
