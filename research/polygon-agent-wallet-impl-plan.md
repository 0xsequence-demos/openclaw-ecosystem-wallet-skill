# Polygon Wallet Agent Session Protocol — Implementation Plan

## Overview

This document specifies a secure, serverless session handoff protocol that connects an AI agent CLI to a Polygon Ecosystem Wallet via a Cloudflare Worker + Durable Object relay. The protocol enables a user to delegate a smart session from their browser-based wallet to a local agent CLI without exposing session material in plaintext to any intermediary.

**The user experience:**

1. User runs a command in their terminal (or the agent runs it)
2. Browser opens automatically to `wallet.polygon.technology/agent?rid=XXXXXX`
3. User creates/connects wallet, approves a smart session
4. Browser displays a 6-digit code
5. User types the code into the terminal
6. Done — the agent now has a scoped smart session

**Security guarantees:**

- End-to-end encrypted: the relay sees only opaque ciphertext
- MITM-proof: the 6-digit code is mixed into key derivation, not a post-hoc comparison
- Rate-limited: relay enforces 3 code attempts max, then nukes the request
- Ephemeral: all relay state auto-deletes after 5 minutes TTL
- Zero trust in relay: even a fully compromised relay cannot decrypt session material

---

## Architecture

```
┌──────────────┐       ┌─────────────────────────────┐       ┌─────────────────┐
│              │       │   Cloudflare Worker          │       │                 │
│   Agent CLI  │◄─────►│   (relay.polygon.agent.xyz)  │◄─────►│  Browser Wallet │
│   (Node.js)  │       │                             │       │  (React SPA on  │
│              │       │   ┌─────────────────────┐   │       │   same Worker)  │
│  - X25519 kp │       │   │  Durable Object     │   │       │                 │
│  - HKDF      │       │   │  "SessionRelay"     │   │       │  - Ecosystem    │
│  - XChaCha20 │       │   │                     │   │       │    Wallet SDK   │
│  - keytar    │       │   │  - cli_pk store     │   │       │  - Smart Session│
│              │       │   │  - ciphertext store  │   │       │    approval     │
│              │       │   │  - code_hash check   │   │       │  - X25519 kp    │
│              │       │   │  - attempt counter   │   │       │  - HKDF         │
│              │       │   │  - 5min TTL alarm    │   │       │  - XChaCha20    │
│              │       │   └─────────────────────┘   │       │                 │
└──────────────┘       └─────────────────────────────┘       └─────────────────┘
```

The Cloudflare Worker is a single deployable app that serves three roles:

1. **Static SPA host** — serves the React wallet connector UI at `/agent`
2. **Relay API** — JSON endpoints for session handoff at `/api/relay/*`
3. **Durable Object** — `SessionRelay` class for per-request state with TTL

---

## Part 1: Cryptographic Protocol

### 1.1 Constants

```
PROTOCOL_VERSION = "polygon-agent-session-v1"
CODE_LENGTH = 6
MAX_CODE_ATTEMPTS = 3
REQUEST_TTL_SECONDS = 300   // 5 minutes
REQUEST_ID_LENGTH = 8       // nanoid, alphanumeric, lowercase
```

### 1.2 Key Generation (CLI side)

When the user initiates a connection:

```
cli_sk, cli_pk = X25519.generateKeyPair()
// cli_pk is 32 bytes, hex-encoded for transport
```

Library: `@noble/curves/ed25519` (use `x25519` from this package). This is a pure JS implementation with no native dependencies, works in both Node.js and Cloudflare Workers.

### 1.3 Request Registration

CLI sends `cli_pk` to the relay and receives a short request ID:

```
POST /api/relay/request
Body: { "cli_pk": "<hex>" }
Response: { "request_id": "a7b3x9k2" }
```

The relay generates `request_id` using `nanoid` (8 chars, alphanumeric lowercase). The Durable Object is keyed by `request_id`.

### 1.4 Browser Wallet Flow

The CLI opens the browser:

```
open "https://relay.polygon.agent.xyz/agent?rid=a7b3x9k2"
```

The SPA:

1. Extracts `rid` from query string
2. Fetches `cli_pk` from the relay: `GET /api/relay/request/:rid`
3. Renders the Ecosystem Wallet connection flow (using `@0xsequence/wallet-webapp-provider` or the ecosystem SDK)
4. User creates/connects wallet
5. User approves the smart session (the approval screen shows scoped permissions)
6. After approval, the SPA has the session material (session private key, session config, wallet address, chain ID, permissions, expiry)

### 1.5 Session Encryption (Browser side)

After the user approves the smart session:

```javascript
// 1. Generate ephemeral wallet-side X25519 keypair
const { secretKey: wallet_sk, publicKey: wallet_pk } = x25519.generateKeyPair()

// 2. ECDH shared secret
const shared = x25519.getSharedSecret(wallet_sk, cli_pk)

// 3. Generate random 6-digit code
const code = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
const code_str = code.toString().padStart(6, '0')

// 4. Derive encryption key (ECDH + code)
const enc_key = hkdf_sha256({
  ikm: shared,                                     // 32 bytes
  salt: sha256(utf8_encode(code_str)),             // 32 bytes (hashed code)
  info: utf8_encode(
    hex_encode(cli_pk) + hex_encode(wallet_pk) + PROTOCOL_VERSION
  ),
  length: 32
})

// 5. Encrypt session payload
const session_payload = JSON.stringify({
  version: 1,
  wallet_address: "0x...",
  chain_id: 137,
  session_private_key: "0x...",    // hex-encoded secp256k1 private key
  session_address: "0x...",
  permissions: { ... },            // smart session permission config
  expiry: 1711234567,              // unix timestamp
  ecosystem_wallet_url: "https://...",
  project_access_key: "..."
})

const nonce = crypto.getRandomValues(new Uint8Array(24))  // XChaCha20 nonce
const aad = concat_bytes(cli_pk, wallet_pk)               // additional authenticated data

const ciphertext = xchacha20poly1305_encrypt(enc_key, nonce, session_payload, aad)

// 6. Hash the code for relay-side rate limiting
// Use SHA-256(request_id || code_str) — fast is fine here because
// the relay rate-limits to 3 attempts anyway
const code_hash = sha256(utf8_encode(request_id + code_str))

// 7. Post to relay
POST /api/relay/session/:rid
Body: {
  wallet_pk: hex_encode(wallet_pk),
  nonce: hex_encode(nonce),
  ciphertext: base64url_encode(ciphertext),
  code_hash: hex_encode(code_hash)
}
```

The browser then displays:

```
✓ Session approved
  Enter this code in your terminal: 847291
```

### 1.6 Session Retrieval (CLI side)

CLI polls the relay for session availability, then submits the code:

```javascript
// 1. Poll until session is posted (or timeout)
// GET /api/relay/status/:rid → { "status": "pending" | "ready" | "expired" }

// 2. User enters the 6-digit code in the terminal

// 3. Submit code to relay (relay validates before releasing ciphertext)
POST /api/relay/retrieve/:rid
Body: { code_hash: hex_encode(sha256(utf8_encode(request_id + user_entered_code))) }

// If code matches:
Response 200: {
  wallet_pk: "...",
  nonce: "...",
  ciphertext: "..."
}

// If code doesn't match:
Response 403: { error: "invalid_code", attempts_remaining: 2 }

// If attempts exhausted:
Response 410: { error: "request_expired" }
```

```javascript
// 4. ECDH + decrypt
const shared = x25519.getSharedSecret(cli_sk, wallet_pk)

const enc_key = hkdf_sha256({
  ikm: shared,
  salt: sha256(utf8_encode(user_entered_code)),
  info: utf8_encode(
    hex_encode(cli_pk) + hex_encode(wallet_pk) + PROTOCOL_VERSION
  ),
  length: 32
})

const aad = concat_bytes(cli_pk, wallet_pk)
const session_payload = xchacha20poly1305_decrypt(enc_key, nonce, ciphertext, aad)

// If Poly1305 tag verifies → session is authentic
// If tag fails → should not happen if relay code check passed; abort

// 5. Parse and store
const session = JSON.parse(session_payload)
// Store in macOS Keychain via keytar, keyed by wallet_address + chain_id
```

### 1.7 Crypto Library Choices

Both the CLI (Node.js) and the browser SPA must use the same primitives. Recommended packages:

| Primitive | Package | Notes |
|-----------|---------|-------|
| X25519 | `@noble/curves` | `import { x25519 } from '@noble/curves/ed25519'` |
| HKDF-SHA256 | `@noble/hashes` | `import { hkdf } from '@noble/hashes/hkdf'` and `import { sha256 } from '@noble/hashes/sha256'` |
| XChaCha20-Poly1305 | `@noble/ciphers` | `import { xchacha20poly1305 } from '@noble/ciphers/chacha'` |
| SHA-256 | `@noble/hashes` | For code hashing |
| nanoid | `nanoid` | For request ID generation |

The `@noble/*` family is audited, zero-dependency, pure JS, and works in Cloudflare Workers (no Node.js-only crypto APIs). This is critical — the same code can run in both environments.

---

## Part 2: Cloudflare Worker (Relay + SPA Host)

### 2.1 Project Structure

```
worker/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Worker entry: router
│   ├── relay/
│   │   ├── handler.ts            # API route handlers
│   │   ├── session-relay.ts      # Durable Object class
│   │   └── crypto.ts             # Code hash verification helper
│   └── types.ts                  # Shared types
├── ui/                           # React SPA (Vite)
│   ├── index.html
│   ├── vite.config.ts
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   └── AgentConnect.tsx  # Main connection flow page
│   │   ├── hooks/
│   │   │   ├── useEcosystemWallet.ts
│   │   │   └── useSessionEncryption.ts
│   │   ├── lib/
│   │   │   └── crypto.ts         # Browser-side crypto (X25519, HKDF, XChaCha20)
│   │   └── components/
│   │       ├── WalletConnect.tsx
│   │       ├── SessionApproval.tsx
│   │       └── CodeDisplay.tsx
│   └── public/
│       └── _headers
└── test/
    ├── relay.test.ts
    └── crypto.test.ts
```

### 2.2 Wrangler Configuration

```toml
# wrangler.toml
name = "polygon-agent-relay"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[site]
bucket = "./ui/dist"   # Vite build output

[[durable_objects.bindings]]
name = "SESSION_RELAY"
class_name = "SessionRelay"

[[migrations]]
tag = "v1"
new_classes = ["SessionRelay"]
```

### 2.3 Worker Router (`src/index.ts`)

```typescript
import { SessionRelay } from './relay/session-relay'
import { handleRelayRequest } from './relay/handler'

export { SessionRelay }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // CORS headers for all API routes
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      })
    }

    // API routes
    if (url.pathname.startsWith('/api/relay/')) {
      return handleRelayRequest(request, env, url)
    }

    // SPA: serve static assets, fall back to index.html for client-side routing
    return env.ASSETS.fetch(request)
  }
}

interface Env {
  SESSION_RELAY: DurableObjectNamespace
  ASSETS: Fetcher
}
```

### 2.4 Relay API Handlers (`src/relay/handler.ts`)

```typescript
// Route: POST /api/relay/request
// Creates a new session handoff request
// Body: { cli_pk: string }  (hex-encoded 32-byte X25519 public key)
// Response: { request_id: string }
//
// Validation:
//   - cli_pk must be exactly 64 hex characters (32 bytes)
//   - Generate request_id via nanoid(8, alphanumeric lowercase)
//   - Create Durable Object instance keyed by request_id
//   - Call DO.init(cli_pk) which sets TTL alarm for 5 minutes

// Route: GET /api/relay/request/:rid
// Fetches the CLI's public key for a given request
// Response: { cli_pk: string, status: "pending" | "ready" | "expired" }
//
// Called by the browser SPA to get the key it needs for ECDH.
// The DO returns cli_pk and current status.

// Route: POST /api/relay/session/:rid
// Browser posts encrypted session material after wallet approval
// Body: { wallet_pk: string, nonce: string, ciphertext: string, code_hash: string }
// Response: { ok: true }
//
// Validation:
//   - Request must be in "pending" status (not already submitted)
//   - wallet_pk must be 64 hex chars
//   - nonce must be 48 hex chars (24 bytes)
//   - ciphertext must be valid base64url, max 8KB
//   - code_hash must be 64 hex chars (SHA-256 output)
//   - DO stores all fields, transitions status to "ready"

// Route: GET /api/relay/status/:rid
// CLI polls this to know when the browser has posted session material
// Response: { status: "pending" | "ready" | "expired" }

// Route: POST /api/relay/retrieve/:rid
// CLI submits code hash to retrieve the encrypted session
// Body: { code_hash: string }
// Response on match: { wallet_pk, nonce, ciphertext }
// Response on mismatch: { error: "invalid_code", attempts_remaining: N }
// Response on exhaustion: { error: "request_expired" }
//
// The DO:
//   1. Compares submitted code_hash with stored code_hash
//   2. If match: return payload, delete all state
//   3. If no match: decrement attempts_remaining
//   4. If attempts_remaining == 0: delete all state, return 410
```

All routes proxy to the Durable Object by constructing the DO stub from the `request_id`:

```typescript
function getRelayDO(env: Env, requestId: string): DurableObjectStub {
  const id = env.SESSION_RELAY.idFromName(requestId)
  return env.SESSION_RELAY.get(id)
}
```

### 2.5 Durable Object (`src/relay/session-relay.ts`)

```typescript
// SessionRelay Durable Object
//
// State shape:
// {
//   cli_pk: string,              // hex, set on init
//   status: "pending" | "ready", // transitions once
//   wallet_pk?: string,          // hex, set when browser posts
//   nonce?: string,              // hex
//   ciphertext?: string,         // base64url
//   code_hash?: string,          // hex (SHA-256 of request_id + code)
//   attempts_remaining: number,  // starts at MAX_CODE_ATTEMPTS (3)
//   created_at: number           // unix ms
// }
//
// Methods:
//
// init(cli_pk: string)
//   - Store cli_pk, set status="pending", attempts_remaining=3
//   - Set alarm for REQUEST_TTL_SECONDS (5 min) from now
//
// getPublicKey()
//   - Return { cli_pk, status }
//
// postSession(wallet_pk, nonce, ciphertext, code_hash)
//   - Validate status == "pending"
//   - Store all fields, set status = "ready"
//
// getStatus()
//   - Return { status }
//
// retrieve(code_hash)
//   - Validate status == "ready"
//   - Compare code_hash with stored code_hash (constant-time comparison)
//   - If match: return { wallet_pk, nonce, ciphertext }, then delete all state
//   - If no match: decrement attempts_remaining
//     - If attempts_remaining == 0: delete all state, throw "expired"
//     - Else: throw "invalid_code" with attempts_remaining
//
// alarm()
//   - Called by Cloudflare after TTL expires
//   - Delete all state unconditionally (auto-cleanup)
//
// IMPORTANT: Use this.ctx.storage for all state. Do not use in-memory variables
// that would be lost on DO eviction. All state must survive restarts within TTL.
//
// IMPORTANT: Use constant-time comparison for code_hash to prevent timing attacks:
//   function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
//     if (a.length !== b.length) return false
//     let result = 0
//     for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i]
//     return result === 0
//   }
```

### 2.6 React SPA — Agent Connect Page (`ui/src/pages/AgentConnect.tsx`)

This is the page served at `/agent?rid=XXXXXX`. The flow is:

```
State Machine:
  LOADING → WALLET_CONNECT → SESSION_APPROVAL → CODE_DISPLAY → DONE | ERROR

LOADING:
  - Extract `rid` from URL query params
  - Fetch cli_pk from GET /api/relay/request/:rid
  - If expired or not found → ERROR
  - Else → WALLET_CONNECT

WALLET_CONNECT:
  - Render Ecosystem Wallet connection UI
  - Use @0xsequence/wallet-webapp-provider (or current ecosystem wallet SDK)
  - Configure for the Polygon ecosystem (chain ID, project key, etc.)
  - On wallet connected → WALLET_CONNECT transitions to SESSION_APPROVAL

SESSION_APPROVAL:
  - Display the smart session approval screen
  - Permissions should be scoped to what the agent skill requires:
    - Send native tokens (with optional spending limit)
    - Send ERC20 tokens (with optional per-token allowance)
    - Call specific contracts (if skill defines them)
  - Session expiry: configurable, default 24 hours, max 7 days
    (the ecosystem config controls the upper bound)
  - On approval → run encryption flow (section 1.5), POST to relay → CODE_DISPLAY

CODE_DISPLAY:
  - Display the 6-digit code prominently
  - Show message: "Enter this code in your terminal"
  - Show a countdown timer matching the relay TTL (5 minutes)
  - On relay confirmation (CLI retrieved successfully) or TTL expiry → DONE

DONE:
  - "Your agent is connected!" or error message
  - Link to wallet dashboard
```

**Wallet SDK integration notes:**

The SPA needs to integrate with the Sequence Ecosystem Wallet. The existing `connector-ui` in the prototype repo uses the ecosystem wallet's WaaS v3 flow. Replicate that integration here, specifically:

- The wallet URL (ecosystem wallet URL) should be configurable via environment variable
- The dApp origin must match the Worker's deployed domain
- Smart session creation uses the wallet's built-in session approval UI
- After session approval, the SPA receives the session private key and configuration

The session material that gets encrypted and sent to the CLI:

```typescript
interface SessionPayload {
  version: 1
  wallet_address: string        // checksummed address of the user's wallet
  chain_id: number              // e.g. 137 for Polygon PoS
  session_private_key: string   // hex-encoded secp256k1 private key for the session
  session_address: string       // address derived from the session key
  permissions: {
    native_limit?: string       // wei, max native token spend
    erc20_limits?: Array<{
      token_address: string
      limit: string             // smallest unit
    }>
    contract_calls?: Array<{
      address: string
      functions: string[]       // function selectors
    }>
  }
  expiry: number                // unix timestamp
  ecosystem_wallet_url: string  // needed by CLI to route transactions
  project_access_key: string    // needed by CLI for API access
  relayer_url?: string          // optional custom relayer
}
```

### 2.7 Environment Variables

Worker environment (set via `wrangler.toml` or dashboard):

```
ECOSYSTEM_WALLET_URL = "https://wallet.polygon.technology"
PROJECT_ACCESS_KEY = "..."       # Sequence project access key (public, embedded in SPA)
INDEXER_ACCESS_KEY = "..."       # Sequence indexer access key (public, embedded in SPA)
DEFAULT_CHAIN_ID = "137"
```

These are public values — they're embedded in the SPA bundle. No secrets are needed in the Worker. All secrets (session keys, encryption keys) exist only in the CLI and browser, never on the server.

---

## Part 3: CLI

### 3.1 Project Structure

```
cli/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Entry point, command router
│   ├── commands/
│   │   ├── connect.ts            # New: connection flow (replaces create-request + ingest-session)
│   │   ├── disconnect.ts         # Remove stored session
│   │   ├── address.ts            # Show wallet address
│   │   ├── balances.ts           # Show token balances
│   │   ├── send-native.ts        # Send native tokens
│   │   ├── send-erc20.ts         # Send ERC20 tokens
│   │   ├── send-token.ts         # Send by symbol (token directory)
│   │   └── sessions.ts           # List active sessions
│   ├── lib/
│   │   ├── crypto.ts             # X25519, HKDF, XChaCha20 (shared with browser)
│   │   ├── relay-client.ts       # HTTP client for relay API
│   │   ├── keychain.ts           # keytar wrapper for session storage
│   │   ├── transaction.ts        # Transaction building + broadcast via dapp-client-cli
│   │   └── config.ts             # Environment + defaults
│   └── shared/
│       └── types.ts              # SessionPayload and other shared types (duplicated from worker)
├── bin/
│   └── polygon-agent.mjs         # CLI entry point (hashbang)
└── test/
    ├── crypto.test.ts
    └── connect.test.ts
```

### 3.2 Dependencies

```json
{
  "dependencies": {
    "@noble/curves": "^1.4.0",
    "@noble/hashes": "^1.4.0",
    "@noble/ciphers": "^0.6.0",
    "@0xsequence/dapp-client-cli": "...",
    "keytar": "^7.9.0",
    "nanoid": "^5.0.0",
    "commander": "^12.0.0",
    "open": "^10.0.0",
    "ora": "^8.0.0",
    "chalk": "^5.0.0",
    "prompts": "^2.4.0"
  }
}
```

### 3.3 Connect Command (`src/commands/connect.ts`)

This is the primary new command. It replaces the old `create-request` + `ingest-session` two-step flow.

```typescript
// polygon-agent connect [options]
//
// Options:
//   --name <name>           Wallet name / alias for local storage (default: "default")
//   --chain <chain>         Chain name or ID (default: "polygon")
//   --relay-url <url>       Relay URL (default: "https://relay.polygon.agent.xyz")
//   --native-limit <amount> Max native token spend in session (in human units, e.g. "1.0")
//   --session-expiry <dur>  Session duration (default: "24h", max: "7d")
//   --no-browser            Don't auto-open browser (print URL instead)
//
// Flow:
//
// 1. Generate X25519 keypair
//    const { secretKey: cli_sk, publicKey: cli_pk } = x25519.utils.randomPrivateKey()
//    // Note: @noble/curves x25519.getPublicKey(secretKey) for public key
//
// 2. Register with relay
//    const { request_id } = await relayClient.createRequest(cli_pk)
//
// 3. Open browser
//    const connectUrl = `${relayUrl}/agent?rid=${request_id}&chain=${chain}&native_limit=${nativeLimit}&expiry=${sessionExpiry}`
//    await open(connectUrl)
//    // If --no-browser, print the URL and ask user to open manually
//
// 4. Show spinner + poll for status
//    const spinner = ora('Waiting for wallet connection...').start()
//    while (status === 'pending') {
//      await sleep(1500)
//      status = await relayClient.getStatus(request_id)
//    }
//    spinner.succeed('Wallet connected and session approved')
//
// 5. Prompt for code
//    const { code } = await prompts({
//      type: 'text',
//      name: 'code',
//      message: 'Enter the 6-digit code from your browser',
//      validate: v => /^\d{6}$/.test(v) || 'Must be exactly 6 digits'
//    })
//
// 6. Submit code, retrieve encrypted payload
//    const code_hash = sha256(utf8_encode(request_id + code))
//    const { wallet_pk, nonce, ciphertext } = await relayClient.retrieve(request_id, code_hash)
//    // Handle 403 (wrong code, retry up to 3 times) and 410 (expired)
//
// 7. Decrypt
//    const shared = x25519.getSharedSecret(cli_sk, wallet_pk)
//    const enc_key = hkdf(sha256, shared, sha256(code), cli_pk + wallet_pk + PROTOCOL_VERSION, 32)
//    const aad = concat(cli_pk, wallet_pk)
//    const plaintext = xchacha20poly1305(enc_key, nonce).decrypt(ciphertext, aad)
//    const session: SessionPayload = JSON.parse(new TextDecoder().decode(plaintext))
//
// 8. Store in Keychain
//    await keychain.store(name, session)
//    // keytar service: "polygon.agent.wallet"
//    // keytar account: name (e.g. "default" or user-chosen alias)
//    // keytar password: JSON.stringify(session) — encrypted at rest by OS Keychain
//
// 9. Print summary
//    console.log(`✓ Connected: ${session.wallet_address}`)
//    console.log(`  Chain: ${session.chain_id}`)
//    console.log(`  Session expires: ${new Date(session.expiry * 1000).toLocaleString()}`)
//    console.log(`  Stored as: "${name}"`)
//
// 10. Cleanup
//     // Zero out cli_sk, shared, enc_key from memory
//     // (In JS this is best-effort: fill TypedArrays with zeros)
//     cli_sk.fill(0)
//     shared.fill(0)
```

### 3.4 Keychain Storage (`src/lib/keychain.ts`)

```typescript
// Service name: "polygon.agent.wallet"
//
// keytar.setPassword(service, account, password)
//   - account = wallet alias (e.g. "default", "arb-nova-undep")
//   - password = JSON.stringify(SessionPayload)
//
// keytar.getPassword(service, account) → SessionPayload | null
//
// keytar.deletePassword(service, account) → boolean
//
// keytar.findCredentials(service) → Array<{ account, password }>
//   Used by `sessions` command to list all stored sessions
//
// On Linux where keytar may not work (no libsecret), fall back to
// an encrypted file at ~/.polygon-agent/sessions.enc
// encrypted with a passphrase from POLYGON_AGENT_PASSPHRASE env var.
// This is the same pattern the existing CLI prototype uses.
```

### 3.5 Transaction Flow (`src/lib/transaction.ts`)

Transaction broadcast continues to use `@0xsequence/dapp-client-cli` as the canonical path, exactly as the existing prototype does. The difference is that session material now comes from Keychain (via `connect`) instead of the old blob ingestion.

```typescript
// The dapp-client-cli expects an encrypted state blob + passphrase.
// Our wrapper:
// 1. Reads SessionPayload from Keychain
// 2. Constructs the dapp-client-cli state structure
// 3. Encrypts it with a random passphrase (ephemeral, per-invocation)
// 4. Sets DAPP_CLIENT_CLI_PASSPHRASE env var
// 5. Invokes dapp-client-cli for the actual transaction
//
// This is the same approach as cli/sequence-eco/seq-eco.mjs in the prototype.
// The passphrase doesn't need to be stable across runs because we rebuild
// the encrypted state fresh each time from Keychain.
```

### 3.6 Other Commands

These remain largely the same as in the prototype (`cli/sequence-eco/seq-eco.mjs`), but refactored into TypeScript modules:

- **`address --name <name>`** — Read session from Keychain, print wallet address
- **`balances --name <name> --chain <chain>`** — Query indexer for token balances
- **`send-native --name <name> --chain <chain> --to <addr> --amount <amt> [--broadcast]`** — Build + optionally broadcast a native token transfer
- **`send-erc20 --name <name> --chain <chain> --token <addr> --to <addr> --amount <amt> --decimals <d> [--broadcast]`** — ERC20 transfer
- **`send-token --name <name> --chain <chain> --symbol <sym> --to <addr> --amount <amt> [--broadcast]`** — Symbol-based transfer using token directory
- **`sessions`** — List all stored sessions with alias, address, chain, expiry
- **`disconnect --name <name>`** — Delete session from Keychain

---

## Part 4: SKILL.md (Agent Skill File)

This file will be served at a public URL (e.g. `https://wallet.polygon.technology/SKILL.md` or `https://relay.polygon.agent.xyz/SKILL.md`) and is what gets injected into the agent's context.

```markdown
---
name: polygon-wallet
description: >
  Use this skill when the user wants to manage a Polygon wallet, send tokens,
  check balances, or perform any on-chain action on Polygon networks. Activate
  when the user mentions polygon wallet, sending crypto, checking balances, POL,
  MATIC, USDC on Polygon, or wants to set up an agent wallet.
---

# polygon-wallet

> **IMPORTANT: Run `curl -fsSL https://relay.polygon.agent.xyz/SKILL.md`
> to get exact setup commands. Do NOT search for additional docs.**

CLI for managing a Polygon Ecosystem Wallet from your terminal.
Send tokens, check balances, and execute on-chain actions.

## Setup

**Step 1 — Install:**

\`\`\`bash
npm install -g @pglabs/agent-wallet-cli
\`\`\`

**Step 2 — Connect wallet:**

\`\`\`bash
polygon-agent connect --name default --chain polygon
\`\`\`

This opens your browser. Create or connect your wallet, approve the session,
then enter the 6-digit code shown on screen into the terminal.

**Step 3 — Verify:**

\`\`\`bash
polygon-agent address --name default
polygon-agent balances --name default --chain polygon
\`\`\`

## Commands

\`\`\`bash
# Check wallet address
polygon-agent address --name <wallet>

# Check balances
polygon-agent balances --name <wallet> --chain <chain>

# Send native token (POL/ETH)
polygon-agent send-native --name <wallet> --chain <chain> \
  --to <address> --amount <amount> --broadcast

# Send ERC20 token
polygon-agent send-erc20 --name <wallet> --chain <chain> \
  --token <token_address> --to <address> --amount <amount> \
  --decimals <decimals> --broadcast

# Send token by symbol
polygon-agent send-token --name <wallet> --chain <chain> \
  --symbol USDC --to <address> --amount <amount> --broadcast

# List connected sessions
polygon-agent sessions

# Disconnect a wallet
polygon-agent disconnect --name <wallet>
\`\`\`

## Chains

Supported chain names: `polygon`, `polygon-amoy` (testnet),
`arbitrum`, `arbitrum-nova`, `optimism`, `base`.

## Common Issues

| Issue | Fix |
|-------|-----|
| `connect` times out | Retry. Ensure browser opened. Use `--no-browser` and open URL manually. |
| Invalid code (3 failures) | Run `connect` again to start fresh. |
| Session expired | Run `connect` again. Sessions last 24h by default. |
| Insufficient balance | Fund wallet at wallet.polygon.technology |
| Command not found | Run `npm install -g @pglabs/agent-wallet-cli` |
```

---

## Part 5: Shared Crypto Module

Because both the CLI and the browser SPA perform the same cryptographic operations (X25519, HKDF, XChaCha20-Poly1305), extract a shared module that can be used in both environments.

### 5.1 Shared Types (`shared/types.ts`)

```typescript
export const PROTOCOL_VERSION = 'polygon-agent-session-v1'
export const CODE_LENGTH = 6
export const MAX_CODE_ATTEMPTS = 3
export const REQUEST_TTL_SECONDS = 300

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
  wallet_pk: string      // hex
  nonce: string          // hex
  ciphertext: string     // base64url
}

export interface RelaySessionPost extends RelayPayload {
  code_hash: string      // hex
}
```

### 5.2 Shared Crypto (`shared/crypto.ts`)

```typescript
// encryptSession(cli_pk, session_payload, request_id)
//   → { wallet_pk, nonce, ciphertext, code_hash, code_plaintext }
//
// Called by the browser SPA.
// Generates wallet keypair, ECDH, random code, HKDF, encrypts.
// Returns the code_plaintext so the UI can display it.

// decryptSession(cli_sk, cli_pk, wallet_pk, nonce, ciphertext, code)
//   → SessionPayload
//
// Called by the CLI.
// ECDH with cli_sk + wallet_pk, HKDF with code, decrypts.
// Throws if Poly1305 tag verification fails.

// hashCode(request_id, code)
//   → hex string (SHA-256)
//
// Used by both browser (to post code_hash) and CLI (to submit code_hash).
// hash = SHA-256(request_id + code_str)
```

This module should be published as a shared package or simply duplicated in both the `worker/ui` and `cli` packages with a build-time copy step. Given this is a monorepo, symlink or workspace reference is fine.

---

## Part 6: Relay API Reference

### `POST /api/relay/request`

Create a new session handoff request.

**Request:**
```json
{ "cli_pk": "a1b2c3d4...64 hex chars" }
```

**Response (201):**
```json
{ "request_id": "a7b3x9k2" }
```

**Errors:**
- `400` — Invalid `cli_pk` format
- `429` — Rate limited (max 10 requests/min per IP)

---

### `GET /api/relay/request/:rid`

Fetch the CLI's public key for a request.

**Response (200):**
```json
{ "cli_pk": "a1b2c3d4...64 hex chars", "status": "pending" }
```

**Errors:**
- `404` — Request not found or expired

---

### `POST /api/relay/session/:rid`

Browser posts encrypted session material.

**Request:**
```json
{
  "wallet_pk": "e5f6a7b8...64 hex chars",
  "nonce": "...48 hex chars",
  "ciphertext": "...base64url",
  "code_hash": "...64 hex chars"
}
```

**Response (200):**
```json
{ "ok": true }
```

**Errors:**
- `404` — Request not found or expired
- `409` — Session already posted (no overwrite)
- `400` — Invalid payload format

---

### `GET /api/relay/status/:rid`

Poll for session readiness.

**Response (200):**
```json
{ "status": "pending" | "ready" }
```

**Errors:**
- `404` — Request not found or expired

---

### `POST /api/relay/retrieve/:rid`

CLI submits code hash to retrieve encrypted session.

**Request:**
```json
{ "code_hash": "...64 hex chars" }
```

**Response (200) — on code match:**
```json
{
  "wallet_pk": "e5f6a7b8...64 hex chars",
  "nonce": "...48 hex chars",
  "ciphertext": "...base64url"
}
```

**Response (403) — on code mismatch:**
```json
{ "error": "invalid_code", "attempts_remaining": 2 }
```

**Response (410) — on expiry or attempts exhausted:**
```json
{ "error": "request_expired" }
```

---

## Part 7: Security Considerations

### 7.1 Threat Model

| Threat | Mitigation |
|--------|-----------|
| Passive network eavesdropper | X25519 ECDH + XChaCha20-Poly1305 — all session material is encrypted in transit |
| Compromised relay | Relay only sees public keys + ciphertext; cannot derive ECDH secret or learn the code |
| MITM substituting public keys at relay | Code is mixed into HKDF salt — attacker doesn't have code, can't produce valid enc_key |
| Brute-force code at relay | 3 attempts max, then request is nuked; attacker gets at most 3 guesses out of 1M |
| Brute-force code offline | Attacker needs both ECDH shared secret AND ciphertext; relay withholds ciphertext until correct code_hash is submitted |
| Replay attack | Each request_id is single-use; payload deleted after successful retrieval |
| Session material leaked from Keychain | OS Keychain encryption at rest; attacker needs device access + OS credentials |
| Stale sessions | TTL alarm auto-deletes relay state; session expiry enforced by smart session contract on-chain |

### 7.2 Rate Limiting

The Worker should enforce:

- **Request creation:** 10 per minute per IP (prevent relay flooding)
- **Status polling:** 60 per minute per IP (prevent excessive polling)
- **Code submission:** Handled by Durable Object (3 attempts per request)

Use Cloudflare's built-in rate limiting rules or implement in the Worker with `cf` object IP extraction.

### 7.3 Content Security

The SPA should set strict CSP headers:

```
Content-Security-Policy: default-src 'self';
  script-src 'self';
  connect-src 'self' https://wallet.polygon.technology https://*.sequence.info;
  frame-src https://wallet.polygon.technology;
  style-src 'self' 'unsafe-inline';
```

### 7.4 Memory Hygiene

After the handshake completes (both CLI and browser sides):

- Zero-fill all `Uint8Array` buffers containing private keys, shared secrets, encryption keys
- Discard ephemeral keypairs (they are single-use by design)
- The 6-digit code should not be logged or persisted anywhere

---

## Part 8: Build & Deploy

### 8.1 Monorepo Structure

```
polygon-agent-wallet/
├── packages/
│   ├── shared/                # Shared types + crypto
│   │   ├── package.json
│   │   └── src/
│   ├── cli/                   # Node.js CLI
│   │   ├── package.json
│   │   └── src/
│   └── worker/                # Cloudflare Worker + SPA
│       ├── package.json
│       ├── wrangler.toml
│       ├── src/               # Worker code
│       └── ui/                # React SPA (Vite)
├── package.json               # Root workspace
├── pnpm-workspace.yaml
└── turbo.json                 # Turborepo config
```

Use `pnpm` workspaces. The `shared` package is referenced by both `cli` and `worker/ui`.

### 8.2 Build Commands

```bash
# Install all dependencies
pnpm install

# Build shared types + crypto
pnpm --filter shared build

# Build CLI
pnpm --filter cli build

# Build SPA + deploy Worker
pnpm --filter worker build      # Vite builds the SPA
pnpm --filter worker deploy     # wrangler deploy

# Run tests
pnpm --filter shared test
pnpm --filter cli test
pnpm --filter worker test
```

### 8.3 CI/CD

GitHub Actions workflow:

1. On push to `main`: build all packages, run tests
2. On tag `v*`: build CLI, publish to npm as `@pglabs/agent-wallet-cli`
3. On push to `main` (worker changed): deploy Worker via `wrangler deploy`

---

## Part 9: Migration from Prototype

The existing prototype at `0xsequence-demos/openclaw-ecosystem-wallet-skill` has working code for:

- Ecosystem Wallet SDK integration (in `connector-ui/`)
- Headless transaction sending via `@0xsequence/dapp-client-cli` (in `cli/sequence-eco/`)
- Keychain storage via `keytar`

### What carries over:

- The wallet SDK integration code from `connector-ui/` → into `worker/ui/`
- The transaction broadcast logic from `cli/sequence-eco/seq-eco.mjs` → into `cli/src/lib/transaction.ts`
- The Keychain storage pattern → into `cli/src/lib/keychain.ts`
- The env var configuration pattern → into `cli/src/lib/config.ts`

### What's new:

- The entire relay layer (Durable Object, API handlers)
- The cryptographic handshake (X25519, HKDF, XChaCha20)
- The `connect` command replacing `create-request` + `ingest-session`
- The shared crypto module
- The SKILL.md file

### What's removed:

- ngrok dependency (replaced by the relay)
- Webhook mode (replaced by the relay polling + code flow)
- Manual blob copy-paste (replaced by encrypted relay + code)
- The `.env.local` file with `DAPP_CLIENT_CLI_PASSPHRASE` (now ephemeral per-invocation)

---

## Part 10: Future — Smart Sessions API (Option 4)

When the Smart Sessions API lands (~April 2026), the protocol simplifies dramatically:

1. CLI generates a session keypair locally
2. CLI calls the Smart Sessions API to create a pending session (submits the session public key + desired permissions)
3. API returns a session ID
4. CLI opens browser: `wallet.polygon.technology/approve?session_id=XXX`
5. User approves in the wallet UI (standard approval screen)
6. CLI polls the API for session status → "approved"
7. CLI already holds the session private key — no handoff needed

This eliminates the relay entirely. The session private key never leaves the CLI. The wallet only sees the session public key. The API only knows the session was approved. This is the ideal end-state architecture.

The relay-based protocol (this document) is designed to be forward-compatible: when the Smart Sessions API is available, the `connect` command switches to the new flow internally, but the SKILL.md and user-facing CLI interface remain identical.

---

## Implementation Priority

1. **Shared crypto module** — implement and test the X25519 + HKDF + XChaCha20 flow with unit tests covering encrypt/decrypt round-trip, wrong code rejection, and AAD tampering detection
2. **Durable Object + relay API** — implement SessionRelay with all state transitions, TTL alarms, code verification, and rate limiting
3. **Worker router + SPA scaffold** — basic Vite React app with routing, connect to relay API
4. **Wallet SDK integration** — port ecosystem wallet connection + smart session approval from prototype
5. **CLI connect command** — implement the full flow end-to-end
6. **Port transaction commands** — migrate `send-native`, `send-erc20`, `send-token`, `balances`, `address` from prototype
7. **SKILL.md** — finalize and host
8. **CI/CD + npm publish** — GitHub Actions, `@pglabs/agent-wallet-cli`
