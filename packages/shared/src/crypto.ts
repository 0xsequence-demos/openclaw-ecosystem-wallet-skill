import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { PROTOCOL_VERSION, CODE_LENGTH } from './constants.js'
import { bytesToHex, bytesToBase64url, concatBytes } from './encoding.js'
import type { SessionPayload, EncryptResult } from './types.js'

export function generateX25519Keypair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = x25519.utils.randomPrivateKey()
  const publicKey = x25519.getPublicKey(secretKey)
  return { secretKey, publicKey }
}

export function encryptSession(
  cli_pk: Uint8Array,
  payload: SessionPayload,
  request_id: string,
): EncryptResult {
  const wallet_sk = x25519.utils.randomPrivateKey()
  const wallet_pk = x25519.getPublicKey(wallet_sk)
  const shared = x25519.getSharedSecret(wallet_sk, cli_pk)

  const codeInt = randomCodeInt()
  const code_str = codeInt.toString().padStart(CODE_LENGTH, '0')

  const enc_key = deriveKey(shared, code_str, cli_pk, wallet_pk)

  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const nonce = randomBytes(24)
  const aad = concatBytes(cli_pk, wallet_pk)

  const cipher = xchacha20poly1305(enc_key, nonce, aad)
  const ciphertext = cipher.encrypt(plaintext)

  const code_hash = hashCode(request_id, code_str)

  wallet_sk.fill(0)
  shared.fill(0)
  enc_key.fill(0)

  return {
    wallet_pk: bytesToHex(wallet_pk),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToBase64url(ciphertext),
    code_hash,
    code_plaintext: code_str,
  }
}

export function decryptSession(
  cli_sk: Uint8Array,
  cli_pk: Uint8Array,
  wallet_pk: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  code: string,
): SessionPayload {
  const shared = x25519.getSharedSecret(cli_sk, wallet_pk)
  const enc_key = deriveKey(shared, code, cli_pk, wallet_pk)

  const aad = concatBytes(cli_pk, wallet_pk)
  const cipher = xchacha20poly1305(enc_key, nonce, aad)
  const plaintext = cipher.decrypt(ciphertext)

  shared.fill(0)
  enc_key.fill(0)

  return JSON.parse(new TextDecoder().decode(plaintext)) as SessionPayload
}

export function hashCode(request_id: string, code: string): string {
  const input = new TextEncoder().encode(request_id + code)
  return bytesToHex(sha256(input))
}

// --- Internal helpers ---

function deriveKey(
  shared: Uint8Array,
  code: string,
  cli_pk: Uint8Array,
  wallet_pk: Uint8Array,
): Uint8Array {
  const salt = sha256(new TextEncoder().encode(code))
  const info = new TextEncoder().encode(
    bytesToHex(cli_pk) + bytesToHex(wallet_pk) + PROTOCOL_VERSION,
  )
  return hkdf(sha256, shared, salt, info, 32)
}

function randomCodeInt(): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] % 1_000_000
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  return buf
}
