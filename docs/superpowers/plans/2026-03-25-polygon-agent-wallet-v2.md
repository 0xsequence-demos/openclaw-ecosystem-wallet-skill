# Polygon Agent Wallet v2 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prototype CLI + connector UI with a production-grade, relay-based session handoff system using X25519/HKDF/XChaCha20 encryption, Cloudflare Durable Objects, and a TypeScript monorepo.

**Architecture:** A pnpm monorepo with three packages: `shared` (crypto + types), `worker` (Cloudflare Worker with Durable Object relay + React SPA), and `cli` (TypeScript Node.js CLI using commander). The browser and CLI perform an X25519 ECDH key exchange, with session material encrypted via XChaCha20-Poly1305 using a key derived from HKDF-SHA256 where a 6-digit human-transferred code is mixed into the salt. A Durable Object acts as an ephemeral encrypted mailbox with 5-minute TTL and 3-attempt code gate.

**Tech Stack:** TypeScript, pnpm workspaces, Vite + React 18, Cloudflare Workers + Durable Objects, `@noble/curves` + `@noble/hashes` + `@noble/ciphers`, `@0xsequence/dapp-client` v3 beta, `commander`, `keytar`, `vitest`

**Reference Docs:**
- Implementation spec: `research/polygon-agent-wallet-impl-plan.md`
- Security architecture: `research/polygon-agent-session-security-architecture.md`
- Existing CLI prototype: `cli/sequence-eco/seq-eco.mjs` (1235 lines)
- Existing connector UI: `connector-ui/src/App.tsx` (503 lines)
- Existing bridge: `cli/sequence-eco/dapp-client-cli-bridge.mjs` (294 lines)

---

## File Structure

```
packages/
├── shared/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # Re-exports all public API
│       ├── constants.ts          # PROTOCOL_VERSION, CODE_LENGTH, MAX_CODE_ATTEMPTS, REQUEST_TTL_SECONDS
│       ├── types.ts              # SessionPayload, SessionPermissions, RelayPayload, RelaySessionPost
│       ├── crypto.ts             # encryptSession(), decryptSession(), hashCode()
│       ├── encoding.ts           # hexToBytes(), bytesToHex(), base64url encode/decode
│       └── crypto.test.ts        # Round-trip, wrong-code, AAD-tamper tests
│
├── worker/
│   ├── package.json
│   ├── tsconfig.json
│   ├── wrangler.toml
│   ├── src/
│   │   ├── index.ts              # Worker entry: router + CORS
│   │   ├── env.ts                # Env interface + Durable Object namespace types
│   │   ├── relay/
│   │   │   ├── handler.ts        # API route handlers (POST request, GET request/:rid, etc.)
│   │   │   ├── session-relay.ts  # Durable Object class (state machine, TTL alarm, code gate)
│   │   │   └── validation.ts     # Input validation helpers (hex length, base64url, etc.)
│   │   └── relay.test.ts         # Integration tests for relay handlers
│   └── ui/
│       ├── index.html
│       ├── vite.config.ts
│       ├── tsconfig.json
│       └── src/
│           ├── main.tsx          # React entry
│           ├── App.tsx           # Top-level router (checks rid param, renders AgentConnect)
│           ├── config.ts         # Vite env var exports (WALLET_URL, PROJECT_ACCESS_KEY, etc.)
│           ├── pages/
│           │   └── AgentConnect.tsx  # State machine: LOADING → WALLET_CONNECT → SESSION_APPROVAL → CODE_DISPLAY → DONE
│           ├── hooks/
│           │   ├── useEcosystemWallet.ts  # DappClient setup + wallet connection
│           │   └── useSessionEncryption.ts  # Calls shared/crypto encryptSession + posts to relay
│           ├── lib/
│           │   ├── relay-api.ts  # Browser-side relay HTTP client
│           │   └── indexer.ts    # Balance fetching (ported from connector-ui/src/indexer.ts)
│           └── components/
│               ├── WalletConnect.tsx     # Ecosystem wallet connect button + status
│               ├── SessionApproval.tsx   # Permission display + approve button
│               └── CodeDisplay.tsx       # 6-digit code display + countdown timer
│
├── cli/
│   ├── package.json
│   ├── tsconfig.json
│   ├── bin/
│   │   └── polygon-agent.mjs    # Hashbang entry: #!/usr/bin/env node
│   └── src/
│       ├── index.ts             # Commander program definition + command registration
│       ├── commands/
│       │   ├── connect.ts       # X25519 keygen → relay register → open browser → poll → prompt code → decrypt → store
│       │   ├── disconnect.ts    # Delete session from Keychain
│       │   ├── sessions.ts      # List all stored sessions
│       │   ├── address.ts       # Print wallet address from Keychain
│       │   ├── balances.ts      # Query Sequence Indexer (ported from seq-eco.mjs)
│       │   ├── send-native.ts   # Build + broadcast native token transfer
│       │   ├── send-erc20.ts    # Build + broadcast ERC20 transfer
│       │   └── send-token.ts    # Symbol-based transfer via token directory
│       ├── lib/
│       │   ├── keychain.ts      # keytar wrapper: store/load/delete/list sessions
│       │   ├── relay-client.ts  # HTTP client for relay API (createRequest, getStatus, retrieve)
│       │   ├── transaction.ts   # Reconstruct dapp-client-cli state, spawn subprocess, parse result
│       │   ├── token-directory.ts  # Token resolution via Sequence token-directory (ported from token-directory.mjs)
│       │   └── config.ts        # Env var loading + defaults (RELAY_URL, chain resolution, etc.)
│       └── commands/connect.test.ts  # Unit test for connect flow (mocked relay + keychain)
│
├── package.json                  # Root workspace config
├── pnpm-workspace.yaml           # packages/*
├── turbo.json                    # Build pipeline: shared → worker, cli
└── vitest.workspace.ts           # Vitest workspace config
```

**Key design decisions:**
- `shared` package contains ONLY the crypto protocol and types — no Node.js or browser APIs
- Worker relay logic is separate from UI code; they share only the `shared` package
- CLI commands are one file per command; all share `lib/` utilities
- The existing `connector-ui/` and `cli/sequence-eco/` directories remain untouched (prototype reference)

---

## Chunk 1: Monorepo Scaffold + Shared Crypto

This chunk sets up the pnpm workspace, builds the shared crypto module with full test coverage, and establishes the build pipeline. After this chunk, both the worker and CLI can import tested crypto functions.

### Task 1: Monorepo Root Scaffold

**Files:**
- Create: `packages/package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `vitest.workspace.ts`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "polygon-agent-wallet",
  "private": true,
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.4.0",
    "typescript": "^5.7.0"
  },
  "packageManager": "pnpm@9.15.0"
}
```

Save this as `packages/package.json`.

**Important:** The monorepo root is `packages/`, not the repo root. All workspace-relative paths below are relative to `packages/`.

- [ ] **Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "shared"
  - "worker"
  - "worker/ui"
  - "cli"
```

Save as `packages/pnpm-workspace.yaml`.

Note: `worker/ui` is a separate workspace member so it can resolve `@polygon-agent/shared` via `workspace:*`.

- [ ] **Step 3: Create turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {}
  }
}
```

Save as `packages/turbo.json`.

- [ ] **Step 4: Create vitest.workspace.ts**

```typescript
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'shared',
  'worker',
  'cli',
])
```

Save as `packages/vitest.workspace.ts`.

- [ ] **Step 5: Install root dependencies**

```bash
cd packages && pnpm install
```

Expected: lockfile created, turbo and typescript installed.

- [ ] **Step 6: Commit**

```bash
git add packages/package.json packages/pnpm-workspace.yaml packages/turbo.json packages/vitest.workspace.ts packages/pnpm-lock.yaml
git commit -m "scaffold: monorepo root with pnpm workspaces + turborepo"
```

---

### Task 2: Shared Package — Types + Constants

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Create shared/package.json**

```json
{
  "name": "@polygon-agent/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@noble/ciphers": "^1.2.0",
    "@noble/curves": "^1.8.0",
    "@noble/hashes": "^1.7.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

Note: Use latest `@noble/*` v1.x releases — the impl plan references older versions but the APIs are the same. Check npm for exact latest versions at implementation time.

- [ ] **Step 2: Create shared/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create constants.ts**

```typescript
export const PROTOCOL_VERSION = 'polygon-agent-session-v1'
export const CODE_LENGTH = 6
export const MAX_CODE_ATTEMPTS = 3
export const REQUEST_TTL_SECONDS = 300
export const REQUEST_ID_LENGTH = 8
```

- [ ] **Step 4: Create types.ts**

Reference: `research/polygon-agent-wallet-impl-plan.md` Part 5.1

```typescript
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
```

- [ ] **Step 5: Create index.ts re-export**

```typescript
export * from './constants.js'
export * from './types.js'
export { encryptSession, decryptSession, hashCode } from './crypto.js'
export { hexToBytes, bytesToHex, bytesToBase64url, base64urlToBytes } from './encoding.js'
```

Note: The crypto.js and encoding.js imports will fail until Task 3 — that's expected. Build will fail until then.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/
git commit -m "shared: add types, constants, and package scaffold"
```

---

### Task 3: Shared Package — Crypto Module

**Files:**
- Create: `packages/shared/src/encoding.ts`
- Create: `packages/shared/src/crypto.ts`

This is the core of the protocol. Both the browser SPA and CLI import these functions.

Reference: `research/polygon-agent-session-security-architecture.md` Sections 4.3–4.5
Reference: `research/polygon-agent-wallet-impl-plan.md` Part 5.2

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/crypto.test.ts`:

```typescript
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
  project_access_key: 'test-access-key',
}

describe('crypto round-trip', () => {
  it('encrypts and decrypts a session payload', () => {
    const cli_sk = x25519.utils.randomPrivateKey()
    const cli_pk = x25519.getPublicKey(cli_sk)
    const request_id = 'testrid1'

    const encrypted = encryptSession(cli_pk, MOCK_SESSION, request_id)

    expect(encrypted.wallet_pk).toHaveLength(64) // 32 bytes hex
    expect(encrypted.nonce).toHaveLength(48)      // 24 bytes hex
    expect(encrypted.ciphertext).toBeTruthy()
    expect(encrypted.code_hash).toHaveLength(64)  // SHA-256 hex
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
    const request_id = 'testrid2'

    const encrypted = encryptSession(cli_pk, MOCK_SESSION, request_id)

    // Pick a different code
    const wrongCode = encrypted.code_plaintext === '000000' ? '000001' : '000000'

    expect(() =>
      decryptSession(
        cli_sk,
        cli_pk,
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
    const request_id = 'testrid3'

    const encrypted = encryptSession(cli_pk, MOCK_SESSION, request_id)

    const ct = base64urlToBytes(encrypted.ciphertext)
    ct[0] ^= 0xff // flip bits

    expect(() =>
      decryptSession(
        cli_sk,
        cli_pk,
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
    const request_id = 'testrid4'

    const encrypted = encryptSession(cli_pk, MOCK_SESSION, request_id)

    expect(() =>
      decryptSession(
        wrong_sk,
        cli_pk,
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
    const h1 = hashCode('request1', '123456')
    const h2 = hashCode('request1', '654321')
    expect(h1).not.toBe(h2)
  })

  it('produces different hashes for different request IDs', () => {
    const h1 = hashCode('request1', '123456')
    const h2 = hashCode('request2', '123456')
    expect(h1).not.toBe(h2)
  })
})

// hexToBytes and base64urlToBytes imported from ./encoding.js above
```

- [ ] **Step 2: Install shared dependencies and run the test to verify it fails**

```bash
cd packages/shared && pnpm install && pnpm test
```

Expected: FAIL — `encryptSession` not exported (crypto.ts doesn't exist yet).

- [ ] **Step 3: Create encoding.ts (shared byte/hex/base64url utilities)**

This module is used by crypto.ts, the test file, the CLI, and the Worker validation module.

```typescript
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function bytesToBase64url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlToBytes(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = (4 - (base64.length % 4)) % 4
  const padded = base64 + '='.repeat(pad)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length)
  result.set(a, 0)
  result.set(b, a.length)
  return result
}
```

- [ ] **Step 4: Implement crypto.ts**

Reference: `research/polygon-agent-session-security-architecture.md` Section 4.4 (Phase 3) and Section 4.5 (Phase 4)

```typescript
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { PROTOCOL_VERSION, CODE_LENGTH } from './constants.js'
import { bytesToHex, bytesToBase64url, concatBytes } from './encoding.js'
import type { SessionPayload, EncryptResult } from './types.js'

/**
 * Encrypt a session payload for transport via relay.
 * Called by the browser SPA after wallet approval.
 *
 * @param cli_pk  - CLI's X25519 public key (32 bytes, raw)
 * @param payload - Session data to encrypt
 * @param request_id - Relay request ID (for code hashing)
 * @returns Encrypted payload + plaintext code for display
 */
export function encryptSession(
  cli_pk: Uint8Array,
  payload: SessionPayload,
  request_id: string,
): EncryptResult {
  // 1. Generate ephemeral wallet-side X25519 keypair
  const wallet_sk = x25519.utils.randomPrivateKey()
  const wallet_pk = x25519.getPublicKey(wallet_sk)

  // 2. ECDH shared secret
  const shared = x25519.getSharedSecret(wallet_sk, cli_pk)

  // 3. Generate random 6-digit code
  const codeInt = randomCodeInt()
  const code_str = codeInt.toString().padStart(CODE_LENGTH, '0')

  // 4. Derive encryption key
  const enc_key = deriveKey(shared, code_str, cli_pk, wallet_pk)

  // 5. Encrypt session payload
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const nonce = randomBytes(24) // XChaCha20 nonce
  const aad = concatBytes(cli_pk, wallet_pk)

  const cipher = xchacha20poly1305(enc_key, nonce, aad)
  const ciphertext = cipher.encrypt(plaintext)

  // 6. Hash the code for relay-side rate limiting
  const code_hash = hashCode(request_id, code_str)

  // 7. Zero sensitive material
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

/**
 * Decrypt a session payload received from the relay.
 * Called by the CLI after code submission.
 *
 * @param cli_sk    - CLI's X25519 private key (32 bytes)
 * @param cli_pk    - CLI's X25519 public key (32 bytes)
 * @param wallet_pk - Wallet's X25519 public key (32 bytes, from relay)
 * @param nonce     - XChaCha20 nonce (24 bytes, from relay)
 * @param ciphertext - Encrypted payload (from relay, raw bytes)
 * @param code      - 6-digit code entered by user
 * @returns Decrypted and parsed SessionPayload
 * @throws If Poly1305 tag verification fails (wrong code or tampering)
 */
export function decryptSession(
  cli_sk: Uint8Array,
  cli_pk: Uint8Array,
  wallet_pk: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  code: string,
): SessionPayload {
  // 1. ECDH shared secret
  const shared = x25519.getSharedSecret(cli_sk, wallet_pk)

  // 2. Derive encryption key (same derivation as encrypt side)
  const enc_key = deriveKey(shared, code, cli_pk, wallet_pk)

  // 3. Decrypt
  const aad = concatBytes(cli_pk, wallet_pk)
  const cipher = xchacha20poly1305(enc_key, nonce, aad)
  const plaintext = cipher.decrypt(ciphertext) // throws on tag mismatch

  // 4. Zero sensitive material
  shared.fill(0)
  enc_key.fill(0)

  // 5. Parse
  return JSON.parse(new TextDecoder().decode(plaintext)) as SessionPayload
}

/**
 * Hash a code for relay-side rate limiting.
 * SHA-256(request_id || code_str)
 */
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/shared && pnpm test
```

Expected: All 7 tests pass.

- [ ] **Step 6: Build the shared package**

```bash
cd packages/shared && pnpm build
```

Expected: `dist/` directory created with `.js` and `.d.ts` files.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/
git commit -m "shared: implement encoding, crypto modules with tests"
```

---

## Chunk 2: Cloudflare Worker — Durable Object Relay

This chunk implements the Durable Object `SessionRelay` and the relay API route handlers. After this chunk, the relay can accept requests, store encrypted sessions, enforce the code gate, and auto-expire via TTL alarm.

### Task 4: Worker Package Scaffold

**Files:**
- Create: `packages/worker/package.json`
- Create: `packages/worker/tsconfig.json`
- Create: `packages/worker/wrangler.toml`
- Create: `packages/worker/src/env.ts`

- [ ] **Step 1: Create worker/package.json**

```json
{
  "name": "@polygon-agent/worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "build": "wrangler deploy --dry-run --outdir dist",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "dependencies": {
    "@polygon-agent/shared": "workspace:*",
    "nanoid": "^5.1.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250313.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create worker/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["@cloudflare/workers-types"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "lib": ["ES2022"]
  },
  "include": ["src"],
  "exclude": ["ui"]
}
```

- [ ] **Step 3: Create wrangler.toml**

Reference: `research/polygon-agent-wallet-impl-plan.md` Section 2.2

```toml
name = "polygon-agent-relay"
main = "src/index.ts"
compatibility_date = "2026-03-01"

[assets]
directory = "./ui/dist"

[[durable_objects.bindings]]
name = "SESSION_RELAY"
class_name = "SessionRelay"

[[migrations]]
tag = "v1"
new_classes = ["SessionRelay"]

[vars]
ECOSYSTEM_WALLET_URL = "https://wallet.polygon.technology"
DEFAULT_CHAIN_ID = "137"
# PROJECT_ACCESS_KEY and INDEXER_ACCESS_KEY set via wrangler secret or dashboard
```

- [ ] **Step 4: Create env.ts**

```typescript
import type { SessionRelay } from './relay/session-relay.js'

export interface Env {
  SESSION_RELAY: DurableObjectNamespace<SessionRelay>
  ASSETS: Fetcher
  ECOSYSTEM_WALLET_URL: string
  PROJECT_ACCESS_KEY?: string
  INDEXER_ACCESS_KEY?: string
  DEFAULT_CHAIN_ID: string
}
```

Note: `DurableObjectNamespace<SessionRelay>` ensures that `env.SESSION_RELAY.get(id)` returns a typed stub with RPC access to `SessionRelay` methods. This requires the `SessionRelay` class to extend `DurableObject` (which it does) and a compatibility date of `2024-04-03` or later (ours is `2026-03-01`).

- [ ] **Step 5: Install dependencies**

```bash
cd packages/worker && pnpm install
```

- [ ] **Step 6: Commit**

```bash
git add packages/worker/package.json packages/worker/tsconfig.json packages/worker/wrangler.toml packages/worker/src/env.ts
git commit -m "worker: scaffold package with wrangler + durable object config"
```

---

### Task 5: Durable Object — SessionRelay

**Files:**
- Create: `packages/worker/src/relay/session-relay.ts`
- Create: `packages/worker/src/relay/validation.ts`

Reference: `research/polygon-agent-wallet-impl-plan.md` Section 2.5
Reference: `research/polygon-agent-session-security-architecture.md` Section 6.1 (state lifecycle), Section 6.4 (constant-time comparison)

- [ ] **Step 1: Create validation.ts**

```typescript
// Re-export hexToBytes from shared (single source of truth for encoding)
export { hexToBytes } from '@polygon-agent/shared'

export function isValidHex(str: string, byteLength: number): boolean {
  return new RegExp(`^[0-9a-f]{${byteLength * 2}}$`).test(str)
}

export function isValidBase64url(str: string, maxBytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return false
  // Approximate decoded size: base64 expands ~4/3
  const approxBytes = Math.ceil((str.length * 3) / 4)
  return approxBytes <= maxBytes
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i]
  return result === 0
}
```

- [ ] **Step 2: Create session-relay.ts**

```typescript
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
    // TTL alarm: auto-delete after 5 minutes
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
      // Match: return payload and delete all state
      const result = {
        wallet_pk: state.wallet_pk!,
        nonce: state.nonce!,
        ciphertext: state.ciphertext!,
      }
      await this.ctx.storage.deleteAll()
      return result
    }

    // Mismatch: decrement attempts
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
```

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/relay/
git commit -m "worker: implement SessionRelay durable object with TTL + code gate"
```

---

### Task 6: Relay API Route Handlers

**Files:**
- Create: `packages/worker/src/relay/handler.ts`
- Create: `packages/worker/src/index.ts`

Reference: `research/polygon-agent-wallet-impl-plan.md` Sections 2.3–2.4 and Part 6

- [ ] **Step 1: Create handler.ts**

```typescript
import { customAlphabet } from 'nanoid'
import { isValidHex, isValidBase64url } from './validation.js'
import type { Env } from '../env.js'

// Spec requires alphanumeric lowercase request IDs
const generateRequestId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8)

function getRelayDO(env: Env, requestId: string) {
  const id = env.SESSION_RELAY.idFromName(requestId)
  return env.SESSION_RELAY.get(id)
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handleRelayRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const path = url.pathname.replace('/api/relay/', '')
  const method = request.method

  // POST /api/relay/request — Create new session handoff request
  if (method === 'POST' && path === 'request') {
    const body = await request.json<{ cli_pk: string }>()
    if (!body.cli_pk || !isValidHex(body.cli_pk, 32)) {
      return json({ error: 'cli_pk must be 64 hex characters (32 bytes)' }, 400)
    }

    const request_id = generateRequestId()
    const stub = getRelayDO(env, request_id)
    await stub.init(body.cli_pk)

    return json({ request_id }, 201)
  }

  // GET /api/relay/request/:rid — Fetch CLI public key
  const getRequestMatch = path.match(/^request\/([a-zA-Z0-9_-]+)$/)
  if (method === 'GET' && getRequestMatch) {
    const rid = getRequestMatch[1]
    const stub = getRelayDO(env, rid)
    const result = await stub.getPublicKey()
    if (!result) return json({ error: 'not_found' }, 404)
    return json(result)
  }

  // POST /api/relay/session/:rid — Browser posts encrypted session
  const postSessionMatch = path.match(/^session\/([a-zA-Z0-9_-]+)$/)
  if (method === 'POST' && postSessionMatch) {
    const rid = postSessionMatch[1]
    const body = await request.json<{
      wallet_pk: string
      nonce: string
      ciphertext: string
      code_hash: string
    }>()

    if (!isValidHex(body.wallet_pk, 32)) {
      return json({ error: 'wallet_pk must be 64 hex characters' }, 400)
    }
    if (!isValidHex(body.nonce, 24)) {
      return json({ error: 'nonce must be 48 hex characters' }, 400)
    }
    if (!body.ciphertext || !isValidBase64url(body.ciphertext, 8192)) {
      return json({ error: 'ciphertext must be valid base64url, max 8KB' }, 400)
    }
    if (!isValidHex(body.code_hash, 32)) {
      return json({ error: 'code_hash must be 64 hex characters' }, 400)
    }

    const stub = getRelayDO(env, rid)
    const result = await stub.postSession(
      body.wallet_pk,
      body.nonce,
      body.ciphertext,
      body.code_hash,
    )

    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409
      return json({ error: result.error }, status)
    }
    return json({ ok: true })
  }

  // GET /api/relay/status/:rid — Poll for session readiness
  const statusMatch = path.match(/^status\/([a-zA-Z0-9_-]+)$/)
  if (method === 'GET' && statusMatch) {
    const rid = statusMatch[1]
    const stub = getRelayDO(env, rid)
    const result = await stub.getStatus()
    if (!result) return json({ error: 'not_found' }, 404)
    return json(result)
  }

  // POST /api/relay/retrieve/:rid — CLI submits code hash
  const retrieveMatch = path.match(/^retrieve\/([a-zA-Z0-9_-]+)$/)
  if (method === 'POST' && retrieveMatch) {
    const rid = retrieveMatch[1]
    const body = await request.json<{ code_hash: string }>()

    if (!isValidHex(body.code_hash, 32)) {
      return json({ error: 'code_hash must be 64 hex characters' }, 400)
    }

    const stub = getRelayDO(env, rid)
    const result = await stub.retrieve(body.code_hash)

    if ('error' in result) {
      const status = result.error === 'request_expired' ? 410 : result.error === 'not_found' ? 404 : 403
      return json(result, status)
    }
    return json(result)
  }

  return json({ error: 'not_found' }, 404)
}
```

- [ ] **Step 2: Create index.ts (Worker entry)**

```typescript
import { SessionRelay } from './relay/session-relay.js'
import { handleRelayRequest } from './relay/handler.js'
import type { Env } from './env.js'

export { SessionRelay }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // CORS for API routes
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    // API routes
    if (url.pathname.startsWith('/api/relay/')) {
      const response = await handleRelayRequest(request, env, url)
      response.headers.set('Access-Control-Allow-Origin', '*')
      return response
    }

    // SPA: serve static assets
    return env.ASSETS.fetch(request)
  },
}
```

- [ ] **Step 3: Verify the worker compiles**

```bash
cd packages/worker && npx wrangler deploy --dry-run --outdir dist
```

Expected: Build succeeds (may warn about missing ui/dist — that's fine, the SPA isn't built yet).

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/
git commit -m "worker: implement relay API handlers + worker entry router"
```

---

## Chunk 3: React SPA — Agent Connect UI

This chunk builds the browser-side wallet connection flow. After this chunk, a user can open `/agent?rid=XXX` in a browser, connect their ecosystem wallet, approve a smart session, and see a 6-digit code.

### Task 7: SPA Scaffold (Vite + React)

**Files:**
- Create: `packages/worker/ui/index.html`
- Create: `packages/worker/ui/vite.config.ts`
- Create: `packages/worker/ui/tsconfig.json`
- Create: `packages/worker/ui/package.json`
- Create: `packages/worker/ui/src/main.tsx`
- Create: `packages/worker/ui/src/App.tsx`
- Create: `packages/worker/ui/src/config.ts`

- [ ] **Step 1: Create ui/package.json**

This is nested inside the worker package. Vite builds it and the output goes to `ui/dist/` which is served by the Worker's ASSETS binding.

```json
{
  "name": "@polygon-agent/ui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build"
  },
  "dependencies": {
    "@polygon-agent/shared": "workspace:*",
    "@0xsequence/dapp-client": "3.0.0-beta.17",
    "@0xsequence/wallet-primitives": "3.0.0-beta.17",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create ui/vite.config.ts**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 4444 },
  build: { outDir: 'dist' },
})
```

- [ ] **Step 3: Create ui/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create ui/index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Polygon Agent — Connect Wallet</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create ui/src/main.tsx**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 6: Create ui/src/config.ts**

```typescript
export const walletUrl = (import.meta.env.VITE_WALLET_URL ?? 'https://wallet.polygon.technology').replace(/\/+$/, '')
export const dappOrigin = import.meta.env.VITE_DAPP_ORIGIN ?? window.location.origin
export const projectAccessKey = import.meta.env.VITE_PROJECT_ACCESS_KEY ?? ''
export const relayerUrl: string | undefined = import.meta.env.VITE_RELAYER_URL || undefined
export const nodesUrl: string = import.meta.env.VITE_NODES_URL ?? 'https://nodes.sequence.app'
export const indexerAccessKey: string = import.meta.env.VITE_INDEXER_ACCESS_KEY ?? ''
```

- [ ] **Step 7: Create ui/src/App.tsx (minimal shell)**

```tsx
import { AgentConnect } from './pages/AgentConnect.js'

export function App() {
  const params = new URLSearchParams(window.location.search)
  const rid = params.get('rid')

  if (!rid) {
    return <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>Polygon Agent Wallet</h1>
      <p>Missing <code>rid</code> parameter. This page should be opened from the CLI.</p>
    </div>
  }

  return <AgentConnect rid={rid} />
}
```

- [ ] **Step 8: Create a stub AgentConnect page (placeholder)**

Create `packages/worker/ui/src/pages/AgentConnect.tsx`:

```tsx
export function AgentConnect({ rid }: { rid: string }) {
  return <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
    <h1>Connecting...</h1>
    <p>Request ID: <code>{rid}</code></p>
    <p>Wallet connection flow will be implemented here.</p>
  </div>
}
```

- [ ] **Step 9: Install UI dependencies and verify build**

```bash
cd packages/worker/ui && pnpm install && pnpm build
```

Expected: Build succeeds, `ui/dist/` contains index.html + JS bundles.

- [ ] **Step 10: Commit**

```bash
git add packages/worker/ui/
git commit -m "worker/ui: scaffold Vite + React SPA with routing shell"
```

---

### Task 8: Relay API Client (Browser-side)

**Files:**
- Create: `packages/worker/ui/src/lib/relay-api.ts`

- [ ] **Step 1: Implement relay-api.ts**

```typescript
import type { RelayPayload, RelaySessionPost } from '@polygon-agent/shared'

const RELAY_BASE = '' // Same origin — Worker serves both API and SPA

export async function fetchCliPublicKey(
  rid: string,
): Promise<{ cli_pk: string; status: string }> {
  const res = await fetch(`${RELAY_BASE}/api/relay/request/${rid}`)
  if (!res.ok) throw new Error(`Request ${rid} not found or expired`)
  return res.json()
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
```

- [ ] **Step 2: Commit**

```bash
git add packages/worker/ui/src/lib/
git commit -m "worker/ui: add browser-side relay API client"
```

---

### Task 9: AgentConnect Page — Full State Machine

**Files:**
- Modify: `packages/worker/ui/src/pages/AgentConnect.tsx`
- Create: `packages/worker/ui/src/hooks/useEcosystemWallet.ts`
- Create: `packages/worker/ui/src/hooks/useSessionEncryption.ts`
- Create: `packages/worker/ui/src/components/WalletConnect.tsx`
- Create: `packages/worker/ui/src/components/SessionApproval.tsx`
- Create: `packages/worker/ui/src/components/CodeDisplay.tsx`

Reference: `research/polygon-agent-wallet-impl-plan.md` Section 2.6
Reference: existing `connector-ui/src/App.tsx` for Ecosystem Wallet SDK integration patterns

This task is the most complex in the plan. The existing `connector-ui/src/App.tsx` has the working wallet SDK integration — port the DappClient initialization, session extraction, and permission building from there. Key patterns to preserve:

- `DappClient` initialization with `TransportMode.Popup` (or the correct transport for the ecosystem wallet)
- `jsonReplacers` for serializing session material (Uint8Array, Signature types)
- `Permission` building via `Utils.PermissionBuilder` if available, or manual construction
- Session material extraction: `client.getSession()` → explicit session data

**Important:** The exact Ecosystem Wallet SDK API may have changed between the prototype and now. The implementer should check the `@0xsequence/dapp-client` v3.0.0-beta.17 API surface and adapt. The prototype's `App.tsx` is the authoritative reference for what works.

- [ ] **Step 1: Create useEcosystemWallet.ts hook**

This hook manages DappClient lifecycle and wallet connection. Port the initialization pattern from `connector-ui/src/App.tsx` lines ~70–130 (DappClient creation with WebStorage, popup transport, ecosystem wallet URL config).

The hook should expose:
```typescript
interface UseEcosystemWalletResult {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  walletAddress: string | null
  connect: () => Promise<void>
  getSessionMaterial: () => Promise<SessionPayload>
  error: string | null
}
```

The `getSessionMaterial()` function should extract the session payload from the connected wallet, following the same approach as `App.tsx` lines ~200–300 (session extraction, permission building, serialization).

- [ ] **Step 2: Create useSessionEncryption.ts hook**

```typescript
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

      // Decode pre-fetched CLI public key from hex
      const cli_pk_bytes = hexToBytes(cliPkHex)

      // 3. Encrypt session + generate code
      const result = encryptSession(cli_pk_bytes, session, rid)

      // 4. Post encrypted payload to relay
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
```

- [ ] **Step 3: Create component stubs**

Create `packages/worker/ui/src/components/WalletConnect.tsx`:

```tsx
interface Props {
  onConnect: () => void
  status: 'idle' | 'connecting' | 'connected' | 'error'
  error: string | null
}

export function WalletConnect({ onConnect, status, error }: Props) {
  return (
    <div>
      <h2>Connect Your Wallet</h2>
      {status === 'idle' && (
        <button onClick={onConnect}>Connect Polygon Wallet</button>
      )}
      {status === 'connecting' && <p>Connecting...</p>}
      {status === 'connected' && <p>Wallet connected!</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  )
}
```

Create `packages/worker/ui/src/components/SessionApproval.tsx`:

```tsx
interface Props {
  walletAddress: string
  onApprove: () => void
  status: 'idle' | 'approving' | 'approved' | 'error'
  error: string | null
}

export function SessionApproval({ walletAddress, onApprove, status, error }: Props) {
  return (
    <div>
      <h2>Approve Agent Session</h2>
      <p>Wallet: <code>{walletAddress}</code></p>
      <p>This will create a scoped session for your agent with limited permissions.</p>
      {status === 'idle' && (
        <button onClick={onApprove}>Approve Session</button>
      )}
      {status === 'approving' && <p>Waiting for approval...</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  )
}
```

Create `packages/worker/ui/src/components/CodeDisplay.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { REQUEST_TTL_SECONDS } from '@polygon-agent/shared'

interface Props {
  code: string
}

export function CodeDisplay({ code }: Props) {
  const [secondsLeft, setSecondsLeft] = useState(REQUEST_TTL_SECONDS)

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval)
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60

  return (
    <div style={{ textAlign: 'center' }}>
      <h2>Session Approved</h2>
      <p>Enter this code in your terminal:</p>
      <div style={{
        fontSize: '3rem',
        fontFamily: 'monospace',
        letterSpacing: '0.5em',
        padding: '1rem',
        margin: '1rem 0',
        background: '#f0f0f0',
        borderRadius: '8px',
      }}>
        {code}
      </div>
      <p>Expires in {minutes}:{seconds.toString().padStart(2, '0')}</p>
      {secondsLeft === 0 && <p style={{ color: 'red' }}>Code expired. Please try again.</p>}
    </div>
  )
}
```

- [ ] **Step 4: Implement AgentConnect page state machine**

Replace `packages/worker/ui/src/pages/AgentConnect.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { WalletConnect } from '../components/WalletConnect.js'
import { SessionApproval } from '../components/SessionApproval.js'
import { CodeDisplay } from '../components/CodeDisplay.js'
import { useEcosystemWallet } from '../hooks/useEcosystemWallet.js'
import { useSessionEncryption } from '../hooks/useSessionEncryption.js'
import { fetchCliPublicKey } from '../lib/relay-api.js'

type Phase = 'loading' | 'wallet_connect' | 'session_approval' | 'code_display' | 'done' | 'error'

export function AgentConnect({ rid }: { rid: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [cliPk, setCliPk] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const wallet = useEcosystemWallet()
  const encryption = useSessionEncryption()

  // LOADING phase: validate rid and fetch CLI public key before showing wallet UI
  useEffect(() => {
    fetchCliPublicKey(rid)
      .then(({ cli_pk }) => {
        setCliPk(cli_pk)
        setPhase('wallet_connect')
      })
      .catch((e) => {
        setErrorMsg(e instanceof Error ? e.message : 'Request not found or expired')
        setPhase('error')
      })
  }, [rid])

  async function handleConnect() {
    try {
      await wallet.connect()
      setPhase('session_approval')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Connection failed')
      setPhase('error')
    }
  }

  async function handleApprove() {
    try {
      const session = await wallet.getSessionMaterial()
      // Pass pre-fetched cliPk to avoid redundant relay fetch
      await encryption.encrypt(rid, session, cliPk!)
      setPhase('code_display')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Session approval failed')
      setPhase('error')
    }
  }

  return (
    <div style={{ maxWidth: '480px', margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <h1>Polygon Agent</h1>

      {phase === 'loading' && <p>Validating request...</p>}

      {phase === 'wallet_connect' && (
        <WalletConnect
          onConnect={handleConnect}
          status={wallet.status}
          error={wallet.error}
        />
      )}

      {phase === 'session_approval' && wallet.walletAddress && (
        <SessionApproval
          walletAddress={wallet.walletAddress}
          onApprove={handleApprove}
          status={encryption.status === 'encrypting' ? 'approving' : 'idle'}
          error={encryption.error}
        />
      )}

      {phase === 'code_display' && encryption.code && (
        <CodeDisplay code={encryption.code} />
      )}

      {phase === 'done' && (
        <div>
          <h2>Connected!</h2>
          <p>Your agent is now connected. You can close this tab.</p>
        </div>
      )}

      {phase === 'error' && (
        <div>
          <h2>Error</h2>
          <p style={{ color: 'red' }}>{errorMsg}</p>
          <button onClick={() => window.location.reload()}>Try Again</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Create useEcosystemWallet.ts (ported from prototype)**

This is the most critical porting task. Refer to `connector-ui/src/App.tsx` for the working DappClient setup. The implementer must:

1. Initialize `DappClient` with the same config pattern (walletUrl, dappOrigin, projectAccessKey, transport)
2. Handle the wallet connection flow (popup mode)
3. Extract session material after connection (explicit session: private key, session address, permissions)
4. Build the `SessionPayload` object matching the type from `@polygon-agent/shared`

Key difference from prototype: The prototype uses `tweetnacl-sealedbox-js` for encryption. The new version uses `@noble/*` via the shared crypto module. The wallet SDK integration remains the same.

```typescript
// Skeleton — fill in with patterns from connector-ui/src/App.tsx
import { useState, useRef } from 'react'
import { DappClient } from '@0xsequence/dapp-client'
// ... import TransportMode, WebStorage, etc. as needed
import type { SessionPayload } from '@polygon-agent/shared'
import { walletUrl, dappOrigin, projectAccessKey, relayerUrl, nodesUrl } from '../config.js'

export function useEcosystemWallet() {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<DappClient | null>(null)

  async function connect() {
    setStatus('connecting')
    try {
      // Initialize DappClient — port pattern from connector-ui/src/App.tsx
      // Use: walletUrl, dappOrigin, projectAccessKey from config.ts
      // Transport: popup mode (same as prototype)
      // Storage: WebStorage or equivalent

      // After connection:
      // - Extract wallet address
      // - Store client reference for session extraction
      setStatus('connected')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed')
      setStatus('error')
      throw e
    }
  }

  async function getSessionMaterial(): Promise<SessionPayload> {
    if (!clientRef.current) throw new Error('Wallet not connected')

    // Port session extraction from connector-ui/src/App.tsx
    // Key steps:
    // 1. Get explicit session from client
    // 2. Extract session private key, session address
    // 3. Build permissions object
    // 4. Return SessionPayload

    throw new Error('TODO: implement session extraction')
  }

  return { status, walletAddress, connect, getSessionMaterial, error }
}
```

**Note to implementer:** The `useEcosystemWallet` hook skeleton above is intentionally incomplete. The DappClient API surface is complex and version-specific. Port directly from `connector-ui/src/App.tsx` which has working code. The key areas to copy:

- DappClient constructor config (lines ~70–130 of App.tsx)
- Session extraction after connection (lines ~200–300)
- Permission building (lines ~150–200)

Do NOT attempt to write this from scratch — the prototype is the authoritative reference.

- [ ] **Step 6: Build the SPA**

```bash
cd packages/worker/ui && pnpm install && pnpm build
```

Expected: Build succeeds (the useEcosystemWallet TODO will throw at runtime, not build time).

- [ ] **Step 7: Commit**

```bash
git add packages/worker/ui/
git commit -m "worker/ui: implement AgentConnect state machine with wallet SDK integration"
```

---

## Chunk 4: CLI — Core Infrastructure + Connect Command

This chunk builds the CLI package with the `connect` command — the primary new feature that replaces the old `create-request` + `ingest-session` two-step flow.

### Task 10: CLI Package Scaffold

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/bin/polygon-agent.mjs`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/lib/config.ts`

- [ ] **Step 1: Create cli/package.json**

```json
{
  "name": "@pglabs/agent-wallet-cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "polygon-agent": "./bin/polygon-agent.mjs"
  },
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@polygon-agent/shared": "workspace:*",
    "@noble/curves": "^1.8.0",
    "@noble/hashes": "^1.7.0",
    "@0xsequence/dapp-client": "3.0.0-beta.17",
    "@0xsequence/dapp-client-cli": "0.1.3",
    "@0xsequence/wallet-primitives": "3.0.0-beta.17",
    "@0xsequence/builder": "3.0.0-beta.17",
    "@0xsequence/abi": "3.0.0-beta.17",
    "commander": "^13.0.0",
    "keytar": "^7.9.0",
    "open": "^10.0.0",
    "ora": "^8.0.0",
    "chalk": "^5.0.0",
    "prompts": "^2.4.0",
    "dotenv": "^17.2.4"
  },
  "devDependencies": {
    "@types/prompts": "^2.4.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create cli/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create bin/polygon-agent.mjs**

```javascript
#!/usr/bin/env node
import '../dist/index.js'
```

- [ ] **Step 4: Create src/lib/config.ts**

Port env var loading pattern from `cli/sequence-eco/seq-eco.mjs`. Key difference: relay URL is the primary new config.

```typescript
import 'dotenv/config'

export const RELAY_URL = process.env.POLYGON_AGENT_RELAY_URL ?? 'https://relay.polygon.agent.xyz'
export const KEYCHAIN_SERVICE = 'polygon.agent.wallet'

export function getEnv(key: string, fallback?: string): string {
  const val = process.env[key]
  if (val) return val
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required environment variable: ${key}`)
}

// Resolve chain name → chain ID. Extend as needed.
const CHAIN_MAP: Record<string, number> = {
  polygon: 137,
  'polygon-amoy': 80002,
  arbitrum: 42161,
  'arbitrum-nova': 42170,
  optimism: 10,
  base: 8453,
}

/**
 * Convert a human-readable decimal string (e.g. "1.5") to smallest-unit integer string
 * using string manipulation to avoid IEEE 754 float precision loss.
 * parseUnitsString("1.5", 18) → "1500000000000000000"
 */
export function parseUnitsString(amount: string, decimals: number): string {
  const [intPart, fracPart = ''] = amount.split('.')
  const paddedFrac = fracPart.slice(0, decimals).padEnd(decimals, '0')
  const raw = intPart + paddedFrac
  // Strip leading zeros but keep at least "0"
  return raw.replace(/^0+/, '') || '0'
}

export function resolveChainId(chain: string): number {
  const id = parseInt(chain, 10)
  if (!isNaN(id) && id > 0) return id
  const mapped = CHAIN_MAP[chain.toLowerCase()]
  if (!mapped) throw new Error(`Unknown chain: ${chain}. Known: ${Object.keys(CHAIN_MAP).join(', ')}`)
  return mapped
}
```

- [ ] **Step 5: Create src/index.ts (commander setup)**

```typescript
import { Command } from 'commander'
import { connectCommand } from './commands/connect.js'

const program = new Command()
  .name('polygon-agent')
  .description('Polygon Agent Wallet CLI')
  .version('0.1.0')

program.addCommand(connectCommand)

// Additional commands will be added in Task 12

program.parse()
```

- [ ] **Step 6: Install and build**

```bash
cd packages/cli && pnpm install && pnpm build
```

Expected: Build fails because `connectCommand` doesn't exist yet — that's fine, confirms the scaffold.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/
git commit -m "cli: scaffold package with commander, config, and bin entry"
```

---

### Task 11: CLI — Keychain + Relay Client

**Files:**
- Create: `packages/cli/src/lib/keychain.ts`
- Create: `packages/cli/src/lib/relay-client.ts`

- [ ] **Step 1: Create keychain.ts**

Reference: `research/polygon-agent-wallet-impl-plan.md` Section 3.4
Port pattern from: `cli/sequence-eco/seq-eco.mjs` (keytar usage)

```typescript
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
```

- [ ] **Step 2: Create relay-client.ts**

```typescript
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
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/lib/
git commit -m "cli: add keychain wrapper and relay HTTP client"
```

---

### Task 12: CLI — Connect Command

**Files:**
- Create: `packages/cli/src/commands/connect.ts`

Reference: `research/polygon-agent-wallet-impl-plan.md` Section 3.3

- [ ] **Step 1: Implement connect.ts**

```typescript
import { Command } from 'commander'
import { x25519 } from '@noble/curves/ed25519'
import { decryptSession, bytesToHex, hexToBytes, base64urlToBytes } from '@polygon-agent/shared'
import open from 'open'
import ora from 'ora'
import prompts from 'prompts'
import * as relay from '../lib/relay-client.js'
import * as keychain from '../lib/keychain.js'
import { RELAY_URL, resolveChainId } from '../lib/config.js'

export const connectCommand = new Command('connect')
  .description('Connect a Polygon Ecosystem Wallet via browser')
  .option('--name <name>', 'Wallet alias for local storage', 'default')
  .option('--chain <chain>', 'Chain name or ID', 'polygon')
  .option('--relay-url <url>', 'Relay URL override')
  .option('--native-limit <amount>', 'Max native token spend in session (human units, e.g. "1.0")')
  .option('--session-expiry <dur>', 'Session duration (default: "24h", max: "7d")', '24h')
  .option('--no-browser', 'Print URL instead of auto-opening browser')
  .action(async (opts) => {
    try {
      const chainId = resolveChainId(opts.chain)

      // 1. Generate ephemeral X25519 keypair
      const cli_sk = x25519.utils.randomPrivateKey()
      const cli_pk = x25519.getPublicKey(cli_sk)
      const cli_pk_hex = bytesToHex(cli_pk)

      // 2. Register with relay
      const spinner = ora('Registering with relay...').start()
      const request_id = await relay.createRequest(cli_pk_hex)
      spinner.succeed(`Registered: ${request_id}`)

      // 3. Open browser
      const relayUrl = opts.relayUrl ?? RELAY_URL
      const params = new URLSearchParams({ rid: request_id, chain: String(chainId) })
      if (opts.nativeLimit) params.set('native_limit', opts.nativeLimit)
      if (opts.sessionExpiry) params.set('expiry', opts.sessionExpiry)
      const connectUrl = `${relayUrl}/agent?${params}`

      if (opts.browser !== false) {
        await open(connectUrl)
        console.log(`\nBrowser opened. If it didn't, visit:\n  ${connectUrl}\n`)
      } else {
        console.log(`\nOpen this URL in your browser:\n  ${connectUrl}\n`)
      }

      // 4. Poll for status
      const pollSpinner = ora('Waiting for wallet connection...').start()
      const deadline = Date.now() + 300_000 // 5 min
      let status = 'pending'
      while (status === 'pending' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500))
        try {
          status = await relay.getStatus(request_id)
        } catch {
          // Transient error, keep polling
        }
      }

      if (status !== 'ready') {
        pollSpinner.fail('Timed out waiting for wallet connection.')
        cli_sk.fill(0)
        process.exit(1)
      }
      pollSpinner.succeed('Session approved in browser.')

      // 5. Prompt for code
      const { code } = await prompts({
        type: 'text',
        name: 'code',
        message: 'Enter the 6-digit code from your browser',
        validate: (v: string) => /^\d{6}$/.test(v) || 'Must be exactly 6 digits',
      })

      if (!code) {
        console.log('Cancelled.')
        cli_sk.fill(0)
        process.exit(1)
      }

      // 6. Retrieve encrypted payload
      const retrieveSpinner = ora('Verifying code...').start()
      let payload
      try {
        payload = await relay.retrieve(request_id, code)
      } catch (e) {
        retrieveSpinner.fail(e instanceof Error ? e.message : 'Retrieval failed')
        cli_sk.fill(0)
        process.exit(1)
      }
      retrieveSpinner.succeed('Code verified.')

      // 7. Decrypt
      const wallet_pk = hexToBytes(payload.wallet_pk)
      const nonce = hexToBytes(payload.nonce)
      const ciphertext = base64urlToBytes(payload.ciphertext)

      const session = decryptSession(cli_sk, cli_pk, wallet_pk, nonce, ciphertext, code)

      // 8. Store in Keychain
      await keychain.storeSession(opts.name, session)

      // 9. Print summary
      console.log(`\n✓ Connected: ${session.wallet_address}`)
      console.log(`  Chain: ${session.chain_id}`)
      console.log(`  Session expires: ${new Date(session.expiry * 1000).toLocaleString()}`)
      console.log(`  Stored as: "${opts.name}"`)

      // 10. Cleanup
      cli_sk.fill(0)
    } catch (e) {
      console.error(e instanceof Error ? e.message : 'Connection failed')
      process.exit(1)
    }
  })

// hexToBytes and base64urlToBytes imported from @polygon-agent/shared
```

- [ ] **Step 2: Build and verify**

```bash
cd packages/cli && pnpm build
node bin/polygon-agent.mjs connect --help
```

Expected: Help text printed with options `--name`, `--chain`, `--relay-url`, `--no-browser`.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/connect.ts packages/cli/src/index.ts
git commit -m "cli: implement connect command with X25519 handshake + relay polling"
```

---

## Chunk 5: CLI — Port Remaining Commands

This chunk ports all operational commands from the prototype (`cli/sequence-eco/seq-eco.mjs`) into TypeScript modules.

### Task 13: CLI — Simple Query Commands (address, sessions, disconnect, balances)

**Files:**
- Create: `packages/cli/src/commands/address.ts`
- Create: `packages/cli/src/commands/sessions.ts`
- Create: `packages/cli/src/commands/disconnect.ts`
- Create: `packages/cli/src/commands/balances.ts`
- Modify: `packages/cli/src/index.ts` (register new commands)

- [ ] **Step 1: Create address.ts**

```typescript
import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'

export const addressCommand = new Command('address')
  .description('Show wallet address for a stored session')
  .option('--name <name>', 'Wallet alias', 'default')
  .action(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(`No session found for "${opts.name}". Run "polygon-agent connect" first.`)
      process.exit(1)
    }
    console.log(session.wallet_address)
  })
```

- [ ] **Step 2: Create sessions.ts**

```typescript
import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'

export const sessionsCommand = new Command('sessions')
  .description('List all stored wallet sessions')
  .action(async () => {
    const sessions = await keychain.listSessions()
    if (sessions.length === 0) {
      console.log('No sessions stored. Run "polygon-agent connect" to add one.')
      return
    }
    for (const { name, session } of sessions) {
      const expired = session.expiry * 1000 < Date.now()
      const expiryStr = new Date(session.expiry * 1000).toLocaleString()
      console.log(`  ${name}: ${session.wallet_address} (chain ${session.chain_id}) — expires ${expiryStr}${expired ? ' [EXPIRED]' : ''}`)
    }
  })
```

- [ ] **Step 3: Create disconnect.ts**

```typescript
import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'

export const disconnectCommand = new Command('disconnect')
  .description('Remove a stored wallet session')
  .option('--name <name>', 'Wallet alias', 'default')
  .action(async (opts) => {
    const deleted = await keychain.deleteSession(opts.name)
    if (deleted) {
      console.log(`Session "${opts.name}" removed.`)
    } else {
      console.log(`No session found for "${opts.name}".`)
    }
  })
```

- [ ] **Step 4: Create balances.ts**

Port from `cli/sequence-eco/seq-eco.mjs` balances command. Uses Sequence Indexer API.

```typescript
import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { getEnv } from '../lib/config.js'

export const balancesCommand = new Command('balances')
  .description('Show token balances for a stored wallet')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .action(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(`No session found for "${opts.name}".`)
      process.exit(1)
    }

    const indexerKey = getEnv('SEQUENCE_INDEXER_ACCESS_KEY', session.project_access_key)
    const indexerUrl = process.env.SEQUENCE_INDEXER_URL ??
      'https://indexer.sequence.app/rpc/Indexer/GetTokenBalancesSummary'

    const res = await fetch(indexerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Key': indexerKey,
      },
      body: JSON.stringify({
        omitMetadata: false,
        filter: {
          contractStatus: 'VERIFIED',
          accountAddresses: [session.wallet_address],
        },
      }),
    })

    if (!res.ok) {
      console.error(`Indexer error: ${res.status} ${res.statusText}`)
      process.exit(1)
    }

    const data = await res.json() as Record<string, unknown>
    // Format and print balances — adapt the response parsing from
    // connector-ui/src/indexer.ts pickChainBalances() pattern
    console.log(JSON.stringify(data, null, 2))
  })
```

**Note to implementer:** The balances output formatting should be improved to match the prototype's user-friendly output. The JSON dump above is a starting point. Port the `formatUnits()` helper from `seq-eco.mjs` and the chain-specific balance extraction from `connector-ui/src/indexer.ts`.

- [ ] **Step 5: Register all commands in index.ts**

Update `packages/cli/src/index.ts`:

```typescript
import { Command } from 'commander'
import { connectCommand } from './commands/connect.js'
import { addressCommand } from './commands/address.js'
import { sessionsCommand } from './commands/sessions.js'
import { disconnectCommand } from './commands/disconnect.js'
import { balancesCommand } from './commands/balances.js'
// send commands will be added in Task 14

const program = new Command()
  .name('polygon-agent')
  .description('Polygon Agent Wallet CLI')
  .version('0.1.0')

program.addCommand(connectCommand)
program.addCommand(addressCommand)
program.addCommand(sessionsCommand)
program.addCommand(disconnectCommand)
program.addCommand(balancesCommand)

program.parse()
```

- [ ] **Step 6: Build and verify**

```bash
cd packages/cli && pnpm build
node bin/polygon-agent.mjs --help
```

Expected: All 5 commands listed in help output.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/
git commit -m "cli: add address, sessions, disconnect, and balances commands"
```

---

### Task 14: CLI — Transaction Commands (send-native, send-erc20, send-token)

**Files:**
- Create: `packages/cli/src/lib/transaction.ts`
- Create: `packages/cli/src/lib/token-directory.ts`
- Create: `packages/cli/src/commands/send-native.ts`
- Create: `packages/cli/src/commands/send-erc20.ts`
- Create: `packages/cli/src/commands/send-token.ts`
- Modify: `packages/cli/src/index.ts` (register send commands)

- [ ] **Step 1: Create transaction.ts**

Port from `cli/sequence-eco/dapp-client-cli-bridge.mjs`. This is the subprocess bridge to `@0xsequence/dapp-client-cli`.

Reference: `cli/sequence-eco/dapp-client-cli-bridge.mjs` — `syncStateFromKeychain()` and `sendTransactionViaDappClientCli()`

The implementation should:
1. Reconstruct dapp-client-cli encrypted state from `SessionPayload` (loaded from keychain)
2. Generate an ephemeral passphrase per invocation
3. Spawn `dapp-client-cli fee-options` subprocess
4. Parse JSON from potentially mixed stdout (port `parseJsonFromMixedOutput()`)
5. Spawn `dapp-client-cli send-transaction` with selected fee option
6. Return the transaction hash

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import type { SessionPayload } from '@polygon-agent/shared'

const execFileAsync = promisify(execFile)

// Port the full implementation from cli/sequence-eco/dapp-client-cli-bridge.mjs
// Key functions to port:
//   - syncStateFromKeychain() → buildCliState(session: SessionPayload)
//   - sendTransactionViaDappClientCli() → sendTransaction(session, transactions)
//   - parseJsonFromMixedOutput()
//
// The new version differs only in input: instead of reading multiple keytar keys,
// it receives a single SessionPayload object.

export interface Transaction {
  to: string
  value?: string
  data?: string
}

export async function sendTransaction(
  session: SessionPayload,
  transactions: Transaction[],
): Promise<{ txHash: string }> {
  // TODO: Port from dapp-client-cli-bridge.mjs
  // 1. Build encrypted state file from session
  // 2. Get fee options
  // 3. Send transaction
  // 4. Parse and return txHash
  throw new Error('TODO: port from dapp-client-cli-bridge.mjs')
}
```

**Note to implementer:** This is a direct port of `cli/sequence-eco/dapp-client-cli-bridge.mjs`. The logic is well-tested in the prototype. Port it line by line, adapting only the input (SessionPayload instead of individual keytar keys). Preserve the `parseJsonFromMixedOutput()` resilience pattern — it handles the case where dapp-client-cli dependencies print logs to stdout mixed with JSON output.

- [ ] **Step 2: Create token-directory.ts**

Port from `cli/sequence-eco/token-directory.mjs` — identical logic, just typed.

```typescript
// Port from cli/sequence-eco/token-directory.mjs
// Key functions:
//   - loadTokenDirectoryIndex(ref?)
//   - loadErc20ListForChain(chainId, ref?)
//   - resolveErc20BySymbol(chainId, symbol, ref?)
//
// Cache directory: ~/.polygon-agent/cache/token-directory/

export interface Token {
  chainId: number
  address: string
  symbol: string
  name: string
  decimals: number
  logoURI: string | null
}

export async function resolveErc20BySymbol(
  chainId: number,
  symbol: string,
): Promise<Token | null> {
  // TODO: Port from token-directory.mjs
  throw new Error('TODO: port from token-directory.mjs')
}
```

- [ ] **Step 3: Create send-native.ts**

```typescript
import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { sendTransaction } from '../lib/transaction.js'
import { parseUnitsString } from '../lib/config.js'

export const sendNativeCommand = new Command('send-native')
  .description('Send native token (POL/ETH)')
  .requiredOption('--to <address>', 'Recipient address')
  .requiredOption('--amount <amount>', 'Amount in human units (e.g. "1.5")')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .option('--broadcast', 'Actually send the transaction', false)
  .action(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(`No session found for "${opts.name}".`)
      process.exit(1)
    }

    // Convert human amount to wei (18 decimals) using string math to avoid float precision loss
    const wei = parseUnitsString(opts.amount, 18)

    const tx = { to: opts.to, value: '0x' + BigInt(wei).toString(16) }

    if (!opts.broadcast) {
      console.log('Dry run (add --broadcast to send):')
      console.log(JSON.stringify(tx, null, 2))
      return
    }

    const result = await sendTransaction(session, [tx])
    console.log(`✓ Transaction sent: ${result.txHash}`)
  })
```

- [ ] **Step 4: Create send-erc20.ts**

```typescript
import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { sendTransaction } from '../lib/transaction.js'
import { parseUnitsString } from '../lib/config.js'

export const sendErc20Command = new Command('send-erc20')
  .description('Send ERC20 token by contract address')
  .requiredOption('--token <address>', 'ERC20 token contract address')
  .requiredOption('--to <address>', 'Recipient address')
  .requiredOption('--amount <amount>', 'Amount in human units')
  .requiredOption('--decimals <decimals>', 'Token decimals')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .option('--broadcast', 'Actually send the transaction', false)
  .action(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(`No session found for "${opts.name}".`)
      process.exit(1)
    }

    const decimals = parseInt(opts.decimals, 10)
    const rawAmount = BigInt(parseUnitsString(opts.amount, decimals))

    // ERC20 transfer(address to, uint256 value) — selector 0xa9059cbb
    const selector = 'a9059cbb'
    const toPadded = opts.to.replace(/^0x/, '').padStart(64, '0')
    const amountPadded = rawAmount.toString(16).padStart(64, '0')
    const data = '0x' + selector + toPadded + amountPadded

    const tx = { to: opts.token, data }

    if (!opts.broadcast) {
      console.log('Dry run (add --broadcast to send):')
      console.log(JSON.stringify(tx, null, 2))
      return
    }

    const result = await sendTransaction(session, [tx])
    console.log(`✓ Transaction sent: ${result.txHash}`)
  })
```

- [ ] **Step 5: Create send-token.ts**

```typescript
import { Command } from 'commander'
import * as keychain from '../lib/keychain.js'
import { sendTransaction } from '../lib/transaction.js'
import { resolveErc20BySymbol } from '../lib/token-directory.js'
import { parseUnitsString } from '../lib/config.js'

export const sendTokenCommand = new Command('send-token')
  .description('Send token by symbol (resolved via token directory)')
  .requiredOption('--symbol <symbol>', 'Token symbol (e.g. USDC)')
  .requiredOption('--to <address>', 'Recipient address')
  .requiredOption('--amount <amount>', 'Amount in human units')
  .option('--name <name>', 'Wallet alias', 'default')
  .option('--chain <chain>', 'Chain name or ID (default: use session chain)')
  .option('--broadcast', 'Actually send the transaction', false)
  .action(async (opts) => {
    const session = await keychain.loadSession(opts.name)
    if (!session) {
      console.error(`No session found for "${opts.name}".`)
      process.exit(1)
    }

    const token = await resolveErc20BySymbol(session.chain_id, opts.symbol)
    if (!token) {
      console.error(`Token "${opts.symbol}" not found for chain ${session.chain_id}`)
      process.exit(1)
    }

    console.log(`Resolved: ${token.name} (${token.symbol}) at ${token.address}, ${token.decimals} decimals`)

    const rawAmount = BigInt(parseUnitsString(opts.amount, token.decimals))
    const selector = 'a9059cbb'
    const toPadded = opts.to.replace(/^0x/, '').padStart(64, '0')
    const amountPadded = rawAmount.toString(16).padStart(64, '0')
    const data = '0x' + selector + toPadded + amountPadded

    const tx = { to: token.address, data }

    if (!opts.broadcast) {
      console.log('Dry run (add --broadcast to send):')
      console.log(JSON.stringify(tx, null, 2))
      return
    }

    const result = await sendTransaction(session, [tx])
    console.log(`✓ Transaction sent: ${result.txHash}`)
  })
```

- [ ] **Step 6: Register send commands in index.ts**

Add to `packages/cli/src/index.ts`:

```typescript
import { sendNativeCommand } from './commands/send-native.js'
import { sendErc20Command } from './commands/send-erc20.js'
import { sendTokenCommand } from './commands/send-token.js'

// ... after existing addCommand calls:
program.addCommand(sendNativeCommand)
program.addCommand(sendErc20Command)
program.addCommand(sendTokenCommand)
```

- [ ] **Step 7: Build and verify**

```bash
cd packages/cli && pnpm build
node bin/polygon-agent.mjs --help
```

Expected: All 8 commands listed (connect, address, sessions, disconnect, balances, send-native, send-erc20, send-token).

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/
git commit -m "cli: add send-native, send-erc20, send-token commands with transaction bridge"
```

---

## Chunk 6: SKILL.md + Integration Testing + Cleanup

This chunk finalizes the SKILL.md file, adds integration test scaffolding, and ensures end-to-end build succeeds.

### Task 15: SKILL.md

**Files:**
- Create: `packages/worker/ui/public/SKILL.md`

Reference: `research/polygon-agent-wallet-impl-plan.md` Part 4

- [ ] **Step 1: Create SKILL.md**

Copy the SKILL.md content from the implementation plan Part 4 verbatim into `packages/worker/ui/public/SKILL.md`. This ensures it's served as a static asset by the Worker.

- [ ] **Step 2: Commit**

```bash
git add packages/worker/ui/public/SKILL.md
git commit -m "skill: add polygon-wallet SKILL.md for agent consumption"
```

---

### Task 16: End-to-End Build Verification

- [ ] **Step 1: Full workspace install**

```bash
cd packages && pnpm install
```

- [ ] **Step 2: Build all packages in dependency order**

```bash
cd packages && pnpm build
```

Expected: shared builds first (types + crypto), then worker and cli build in parallel. No errors.

- [ ] **Step 3: Run all tests**

```bash
cd packages && pnpm test
```

Expected: Shared crypto tests pass. Worker and CLI may not have tests yet — that's OK for this phase.

- [ ] **Step 4: Verify CLI help**

```bash
node packages/cli/bin/polygon-agent.mjs --help
```

Expected: All 8 commands listed with descriptions.

- [ ] **Step 5: Verify Worker dry-run deploy**

```bash
cd packages/worker && npx wrangler deploy --dry-run --outdir dist
```

Expected: Bundle created successfully.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A && git commit -m "chore: fix build issues from integration testing"
```

(Only if fixes were needed.)

---

### Task 17: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md with new monorepo structure**

Add a section about the new `packages/` directory and its build/test commands. Keep the existing prototype documentation since those directories still exist.

Add:
```markdown
## New Implementation (packages/)

The v2 implementation lives in `packages/` as a pnpm monorepo:

### Build
\`\`\`bash
cd packages && pnpm install && pnpm build
\`\`\`

### Test
\`\`\`bash
cd packages && pnpm test                        # all packages
cd packages/shared && pnpm test                  # crypto tests only
\`\`\`

### Packages
- `packages/shared` — Crypto protocol (X25519, HKDF, XChaCha20) + shared types
- `packages/worker` — Cloudflare Worker (Durable Object relay + React SPA)
- `packages/cli` — Node.js CLI (`polygon-agent` command)

### Worker Development
\`\`\`bash
cd packages/worker && pnpm dev                   # local Worker dev server
cd packages/worker/ui && pnpm dev                # Vite SPA dev server (port 4444)
cd packages/worker && pnpm deploy                # deploy to Cloudflare
\`\`\`
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with v2 monorepo commands"
```

---

## Implementation Notes

### What's intentionally left as TODO

Two modules contain `TODO` markers that require careful porting from the prototype:

1. **`packages/cli/src/lib/transaction.ts`** — Must be ported from `cli/sequence-eco/dapp-client-cli-bridge.mjs`. This involves reconstructing dapp-client-cli state from a `SessionPayload`, spawning the subprocess, and parsing mixed stdout output. The prototype code works; port it directly.

2. **`packages/worker/ui/src/hooks/useEcosystemWallet.ts`** — Must be ported from `connector-ui/src/App.tsx`. The DappClient initialization, wallet connection, and session material extraction are version-specific SDK code. Port directly from the working prototype.

3. **`packages/cli/src/lib/token-directory.ts`** — Must be ported from `cli/sequence-eco/token-directory.mjs`. Straightforward TypeScript conversion of the GitHub-based token resolution with filesystem caching.

These are marked as TODOs because they involve porting complex, version-specific SDK integrations that must be done with the prototype code open as reference. They are not new design — they are direct ports.

### Dependencies to verify at implementation time

- `@noble/ciphers`, `@noble/curves`, `@noble/hashes` — Verify latest v1.x versions on npm. The API is stable but exact versions may differ from what's listed.
- `@0xsequence/dapp-client` v3.0.0-beta.17 — Verify the DappClient API hasn't changed. If a newer beta is available, check for breaking changes.
- `@cloudflare/workers-types` — Use the latest version matching the wrangler version.
- `commander` — v13.x is current; the plan uses basic features that are stable.

### What's NOT in this plan (future work)

- Argon2id KDF hardening (see security architecture Section 5.3) — deferred until browser performance is validated
- Smart Sessions API integration (see impl plan Part 10) — deferred until API is available (~April 2026)
- CI/CD GitHub Actions (see impl plan Section 8.3) — separate plan
- npm publishing of `@pglabs/agent-wallet-cli` — separate plan
- Trails swap integration in the new CLI — port after core commands are stable
- Rate limiting implementation in the Worker — can use Cloudflare dashboard rules initially
