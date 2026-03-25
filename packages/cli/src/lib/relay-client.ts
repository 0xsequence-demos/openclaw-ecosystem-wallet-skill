import { hashCode } from '@polygon-agent/shared'
import type { RelayPayload } from '@polygon-agent/shared'
import { RELAY_URL } from './config.js'

export async function createRequest(cli_pk_hex: string): Promise<string> {
  const res = await fetch(`${RELAY_URL}/api/relay/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cli_pk: cli_pk_hex }),
  })
  if (!res.ok) throw new Error(`Relay error: ${res.status}`)
  const data = await res.json() as { request_id: string }
  return data.request_id
}

export async function getStatus(request_id: string): Promise<string> {
  const res = await fetch(`${RELAY_URL}/api/relay/status/${request_id}`)
  if (!res.ok) throw new Error(`Relay error: ${res.status}`)
  const data = await res.json() as { status: string }
  return data.status
}

export async function retrieve(
  request_id: string,
  code: string,
): Promise<RelayPayload> {
  const code_hash = hashCode(request_id, code)
  const res = await fetch(`${RELAY_URL}/api/relay/retrieve/${request_id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code_hash }),
  })

  if (res.status === 403) {
    const err = await res.json() as { error: string; attempts_remaining?: number }
    throw new Error(
      `Invalid code. ${err.attempts_remaining ?? 0} attempt(s) remaining.`,
    )
  }
  if (res.status === 410) {
    throw new Error('Request expired (too many failed attempts or timeout).')
  }
  if (!res.ok) throw new Error(`Relay error: ${res.status}`)

  return res.json() as Promise<RelayPayload>
}
