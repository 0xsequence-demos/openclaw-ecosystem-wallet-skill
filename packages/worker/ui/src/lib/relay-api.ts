import type { RelaySessionPost } from '@polygon-agent/shared'

const RELAY_BASE = ''

export async function fetchCliPublicKey(
  rid: string,
): Promise<{ cli_pk: string; status: string }> {
  const res = await fetch(`${RELAY_BASE}/api/relay/request/${rid}`)
  if (!res.ok) throw new Error(`Request ${rid} not found or expired`)
  return res.json()
}

export async function pollRelayStatus(
  rid: string,
): Promise<'pending' | 'ready' | 'gone'> {
  try {
    const res = await fetch(`${RELAY_BASE}/api/relay/status/${rid}`)
    if (res.status === 404) return 'gone'
    if (!res.ok) return 'gone'
    const data = await res.json() as { status: string }
    return data.status as 'pending' | 'ready'
  } catch {
    return 'gone'
  }
}

export async function postEncryptedSession(
  rid: string,
  payload: RelaySessionPost,
): Promise<void> {
  const res = await fetch(`${RELAY_BASE}/api/relay/session/${rid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'unknown' }))
    throw new Error(`Failed to post session: ${(err as { error: string }).error}`)
  }
}
