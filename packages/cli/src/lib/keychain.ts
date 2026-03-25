import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SessionPayload } from '@polygon-agent/shared'
import { KEYCHAIN_SERVICE } from './config.js'

// --- Backend selection: keytar if available, file-based fallback ---

interface KeychainBackend {
  store(name: string, session: SessionPayload): Promise<void>
  load(name: string): Promise<SessionPayload | null>
  remove(name: string): Promise<boolean>
  list(): Promise<Array<{ name: string; session: SessionPayload }>>
}

let backend: KeychainBackend | null = null

async function getBackend(): Promise<KeychainBackend> {
  if (backend) return backend

  try {
    const keytar = await import('keytar')
    // Test that keytar actually works (will throw if libsecret missing)
    await keytar.default.findCredentials(KEYCHAIN_SERVICE)
    backend = new KeytarBackend(keytar.default)
  } catch {
    backend = new FileBackend()
  }

  return backend
}

// --- Keytar backend (macOS Keychain / Linux libsecret) ---

class KeytarBackend implements KeychainBackend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private keytar: any) {}

  async store(name: string, session: SessionPayload) {
    await this.keytar.setPassword(KEYCHAIN_SERVICE, name, JSON.stringify(session))
  }

  async load(name: string) {
    const raw = await this.keytar.getPassword(KEYCHAIN_SERVICE, name)
    if (!raw) return null
    return JSON.parse(raw) as SessionPayload
  }

  async remove(name: string) {
    return this.keytar.deletePassword(KEYCHAIN_SERVICE, name)
  }

  async list() {
    const creds = await this.keytar.findCredentials(KEYCHAIN_SERVICE) as Array<{ account: string; password: string }>
    return creds.map((c: { account: string; password: string }) => ({
      name: c.account,
      session: JSON.parse(c.password) as SessionPayload,
    }))
  }
}

// --- File-based fallback (encrypted with passphrase) ---

const SESSIONS_DIR = join(homedir(), '.polygon-agent')
const SESSIONS_FILE = join(SESSIONS_DIR, 'sessions.enc')

function getFilePassphrase(): string {
  const passphrase = process.env.POLYGON_AGENT_PASSPHRASE
  if (passphrase) return passphrase

  // Default passphrase derived from machine identity — not high security,
  // but better than plaintext. Users who care should set POLYGON_AGENT_PASSPHRASE.
  return `polygon-agent-${homedir()}-${KEYCHAIN_SERVICE}`
}

function encrypt(plaintext: string): string {
  const key = scryptSync(getFilePassphrase(), 'polygon-agent-salt', 32)
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return iv.toString('hex') + ':' + encrypted.toString('hex')
}

function decrypt(data: string): string {
  const [ivHex, encHex] = data.split(':')
  const key = scryptSync(getFilePassphrase(), 'polygon-agent-salt', 32)
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8')
}

type SessionStore = Record<string, SessionPayload>

function readStore(): SessionStore {
  if (!existsSync(SESSIONS_FILE)) return {}
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf8')
    return JSON.parse(decrypt(raw))
  } catch {
    return {}
  }
}

function writeStore(store: SessionStore): void {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  writeFileSync(SESSIONS_FILE, encrypt(JSON.stringify(store)), 'utf8')
}

class FileBackend implements KeychainBackend {
  private logged = false

  private log() {
    if (!this.logged) {
      console.error('  (Using file-based session storage at ~/.polygon-agent/sessions.enc)')
      this.logged = true
    }
  }

  async store(name: string, session: SessionPayload) {
    this.log()
    const store = readStore()
    store[name] = session
    writeStore(store)
  }

  async load(name: string) {
    this.log()
    return readStore()[name] ?? null
  }

  async remove(name: string) {
    this.log()
    const store = readStore()
    if (!(name in store)) return false
    delete store[name]
    writeStore(store)
    return true
  }

  async list() {
    this.log()
    const store = readStore()
    return Object.entries(store).map(([name, session]) => ({ name, session }))
  }
}

// --- Public API (unchanged interface) ---

export async function storeSession(name: string, session: SessionPayload): Promise<void> {
  const b = await getBackend()
  return b.store(name, session)
}

export async function loadSession(name: string): Promise<SessionPayload | null> {
  const b = await getBackend()
  return b.load(name)
}

export async function deleteSession(name: string): Promise<boolean> {
  const b = await getBackend()
  return b.remove(name)
}

export async function listSessions(): Promise<Array<{ name: string; session: SessionPayload }>> {
  const b = await getBackend()
  return b.list()
}
