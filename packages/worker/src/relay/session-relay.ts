import { DurableObject } from 'cloudflare:workers'
import { MAX_CODE_ATTEMPTS, REQUEST_TTL_SECONDS } from '@polygon-agent/shared'
import { constantTimeEqual, hexToBytes } from './validation.js'

interface RelayState {
  cli_pk: string
  status: 'pending' | 'ready'
  wallet_pk?: string
  nonce?: string
  ciphertext?: string
  code_hash?: string
  attempts_remaining: number
  created_at: number
}

export class SessionRelay extends DurableObject {
  async init(cli_pk: string): Promise<void> {
    await this.ctx.storage.put<RelayState>('state', {
      cli_pk,
      status: 'pending',
      attempts_remaining: MAX_CODE_ATTEMPTS,
      created_at: Date.now(),
    })
    await this.ctx.storage.setAlarm(Date.now() + REQUEST_TTL_SECONDS * 1000)
  }

  async getPublicKey(): Promise<{ cli_pk: string; status: string } | null> {
    const state = await this.ctx.storage.get<RelayState>('state')
    if (!state) return null
    return { cli_pk: state.cli_pk, status: state.status }
  }

  async postSession(
    wallet_pk: string,
    nonce: string,
    ciphertext: string,
    code_hash: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const state = await this.ctx.storage.get<RelayState>('state')
    if (!state) return { ok: false, error: 'not_found' }
    if (state.status !== 'pending') return { ok: false, error: 'already_posted' }

    state.wallet_pk = wallet_pk
    state.nonce = nonce
    state.ciphertext = ciphertext
    state.code_hash = code_hash
    state.status = 'ready'
    await this.ctx.storage.put('state', state)

    return { ok: true }
  }

  async getStatus(): Promise<{ status: string } | null> {
    const state = await this.ctx.storage.get<RelayState>('state')
    if (!state) return null
    return { status: state.status }
  }

  async retrieve(
    code_hash: string,
  ): Promise<
    | { wallet_pk: string; nonce: string; ciphertext: string }
    | { error: string; attempts_remaining?: number }
  > {
    const state = await this.ctx.storage.get<RelayState>('state')
    if (!state) return { error: 'not_found' }
    if (state.status !== 'ready') return { error: 'not_ready' }

    const submittedHash = hexToBytes(code_hash)
    const storedHash = hexToBytes(state.code_hash!)

    if (constantTimeEqual(submittedHash, storedHash)) {
      const result = {
        wallet_pk: state.wallet_pk!,
        nonce: state.nonce!,
        ciphertext: state.ciphertext!,
      }
      await this.ctx.storage.deleteAll()
      return result
    }

    state.attempts_remaining--
    if (state.attempts_remaining <= 0) {
      await this.ctx.storage.deleteAll()
      return { error: 'request_expired' }
    }

    await this.ctx.storage.put('state', state)
    return { error: 'invalid_code', attempts_remaining: state.attempts_remaining }
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
}
