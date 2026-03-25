import keytar from 'keytar'
import type { SessionPayload } from '@polygon-agent/shared'
import { KEYCHAIN_SERVICE } from './config.js'

export async function storeSession(name: string, session: SessionPayload): Promise<void> {
  await keytar.setPassword(KEYCHAIN_SERVICE, name, JSON.stringify(session))
}

export async function loadSession(name: string): Promise<SessionPayload | null> {
  const raw = await keytar.getPassword(KEYCHAIN_SERVICE, name)
  if (!raw) return null
  return JSON.parse(raw) as SessionPayload
}

export async function deleteSession(name: string): Promise<boolean> {
  return keytar.deletePassword(KEYCHAIN_SERVICE, name)
}

export async function listSessions(): Promise<Array<{ name: string; session: SessionPayload }>> {
  const creds = await keytar.findCredentials(KEYCHAIN_SERVICE)
  return creds.map((c) => ({
    name: c.account,
    session: JSON.parse(c.password) as SessionPayload,
  }))
}
