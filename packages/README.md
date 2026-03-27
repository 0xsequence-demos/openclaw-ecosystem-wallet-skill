# Polygon Agent Wallet v2

Relay-based session handoff protocol for connecting an AI agent CLI to a Polygon Ecosystem Wallet. The user approves a scoped smart session in their browser, and the CLI receives it via an encrypted relay with a 6-digit confirmation code.

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `@polygon-agent/shared` | `shared/` | Crypto protocol (X25519, HKDF, XChaCha20) + shared types |
| `@polygon-agent/worker` | `worker/` | Cloudflare Worker — Durable Object relay + API endpoints |
| `@polygon-agent/ui` | `worker/ui/` | React SPA — wallet connect + session approval + code display |
| `@pglabs/agent-wallet-cli` | `cli/` | Node.js CLI — `polygon-agent` command |

## Prerequisites

- Node.js 20+
- pnpm 9+
- Wrangler CLI (`npm i -g wrangler`) — for local Worker dev server
- macOS Keychain or Linux libsecret — required by `keytar` for session storage

## Quick Start

```bash
# 1. Install all dependencies
pnpm install

# 2. Build everything
pnpm build

# 3. Run tests
pnpm test
```

## Local Development

### Start the relay server

The relay dev server is a lightweight Node.js HTTP server with in-memory storage that implements the same API as the Cloudflare Worker + Durable Objects:

```bash
# Build shared package first, then start relay
pnpm dev:worker
# → Relay dev server running at http://localhost:8787
```

The CLI talks to this local server:

```bash
cd cli
cp .env.example .env    # POLYGON_AGENT_RELAY_URL=http://localhost:8787
pnpm build
node bin/polygon-agent.mjs connect --name test --chain polygon
```

### UI development (Vite HMR)

Run the relay server and Vite dev server together. Vite proxies `/api/*` to the relay:

```bash
# Terminal 1: Start the relay server (port 8787)
pnpm dev:worker

# Terminal 2: Start Vite with hot reload (port 4444)
pnpm dev:ui
```

Open `http://localhost:4444/agent?rid=test` — API calls proxy to port 8787.

### Wrangler (Cloudflare runtime)

If you need the full Cloudflare Workers runtime with Durable Objects:

```bash
cd worker && pnpm dev:wrangler
```

Note: `wrangler dev` requires `workerd` which may not work on all systems (known issues on NixOS). The Node.js dev server is the recommended local dev path.

## Integration Tests

Test the full relay flow (registration → encryption → code gate → decryption) against a running local Worker:

```bash
# Terminal 1: Start the Worker
pnpm dev:worker

# Terminal 2: Run the integration tests
pnpm test:relay
```

This exercises:
- Happy path: full crypto round-trip (X25519 ECDH → HKDF → XChaCha20 encrypt → relay → retrieve → decrypt)
- Wrong code: 3 failed attempts → request expiration (410)
- Input validation: bad hex, missing fields, nonexistent requests

## Environment Variables

### SPA (`worker/ui/.env`)

Production values are committed in `worker/ui/.env.production` (picked up automatically by `vite build`). For local dev, copy `.env.example` to `.env`.

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_WALLET_URL` | `https://wallet.polygon.technology` | Ecosystem Wallet URL |
| `VITE_PROJECT_ACCESS_KEY` | (empty) | Sequence project access key |
| `VITE_DAPP_ORIGIN` | `window.location.origin` | DApp origin for CORS |
| `VITE_RELAYER_URL` | (none) | Optional custom relayer |
| `VITE_NODES_URL` | `https://nodes.sequence.app` | Node gateway |

### CLI (`cli/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `POLYGON_AGENT_RELAY_URL` | `https://relay.polygon.agent.xyz` | Relay endpoint |
| `SEQUENCE_PROJECT_ACCESS_KEY` | (none) | For balances + transaction sending |

### Worker (`wrangler.toml` or dashboard)

| Variable | Default | Description |
|----------|---------|-------------|
| `ECOSYSTEM_WALLET_URL` | `https://wallet.polygon.technology` | Set in wrangler.toml |
| `DEFAULT_CHAIN_ID` | `137` | Set in wrangler.toml |
| `PROJECT_ACCESS_KEY` | (none) | Set via `wrangler secret` |

## Architecture

```
CLI                         Worker (Cloudflare)              Browser
 │                              │                              │
 │ 1. Generate X25519 keypair   │                              │
 │ 2. POST /api/relay/request ──►│ Create Durable Object       │
 │    ◄── { request_id }        │ (5-min TTL alarm)            │
 │                              │                              │
 │ 3. Open browser ─────────────┼──────────────────────────────►│
 │                              │  GET /api/relay/request/:rid  │
 │                              │◄──────────────────────────────│
 │                              │  → { cli_pk }                │
 │                              │                              │
 │                              │  [User connects wallet,      │
 │                              │   approves smart session]    │
 │                              │                              │
 │                              │  POST /api/relay/session/:rid │
 │                              │◄──────────────────────────────│
 │                              │  (encrypted session + code)  │
 │                              │                              │
 │                              │  Browser shows 6-digit code  │
 │                              │                              │
 │ 4. Poll GET /status/:rid ───►│                              │
 │    ◄── { status: "ready" }   │                              │
 │                              │                              │
 │ 5. User enters code          │                              │
 │ 6. POST /api/relay/retrieve ►│ Verify code (3 attempts max) │
 │    ◄── { ciphertext }        │ Delete state on success      │
 │                              │                              │
 │ 7. Decrypt with ECDH + code  │                              │
 │ 8. Store in OS Keychain      │                              │
```

**Crypto:** X25519 ECDH shared secret + 6-digit code mixed into HKDF-SHA256 salt → XChaCha20-Poly1305 AEAD. The code travels out-of-band (screen → keyboard), so even a compromised relay cannot decrypt.

## Scripts Reference

| Script | Description |
|--------|-------------|
| `pnpm build` | Build all packages (turborepo) |
| `pnpm test` | Run all unit tests |
| `pnpm dev` | Build + start Worker on port 8787 |
| `pnpm dev:worker` | Build shared + start Worker |
| `pnpm dev:ui` | Build shared + start Vite HMR on port 4444 |
| `pnpm test:relay` | Run relay integration tests (requires running Worker) |
