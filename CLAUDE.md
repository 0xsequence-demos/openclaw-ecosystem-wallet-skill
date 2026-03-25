# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw skill for Sequence Ecosystem Wallet v3. Two codebases coexist:

### v2 (packages/) — Active Development

pnpm monorepo under `packages/` with relay-based session handoff:

- **`packages/shared`** — Crypto protocol (X25519/HKDF/XChaCha20) + shared types/encoding
- **`packages/worker`** — Cloudflare Worker with Durable Object relay + React SPA at `/agent`
- **`packages/cli`** — TypeScript Node.js CLI (`polygon-agent` command) using commander

### Prototype (connector-ui/, cli/) — Reference Only

The original prototype directories remain as reference for porting:

- **`connector-ui/`** — Original React/Vite SPA (TweetNaCl sealed-box encryption)
- **`cli/sequence-eco/`** — Original Node.js CLI (plain .mjs, no build step)
- **`cli/trails/`** — Trails DEX swap CLI

## Build & Dev Commands

### v2 Monorepo (packages/)
```bash
cd packages && pnpm install       # install all workspace deps
cd packages && pnpm build         # build all packages (turborepo)
cd packages && pnpm test          # run all tests

cd packages/shared && pnpm test   # crypto tests only (vitest, 7 tests)
cd packages/shared && pnpm build  # shared types + crypto

cd packages/cli && pnpm build     # CLI (TypeScript → dist/)
cd packages/worker && pnpm dev    # local Worker dev server
cd packages/worker/ui && pnpm dev # Vite SPA dev server (port 4444)
cd packages/worker && pnpm deploy # deploy Worker to Cloudflare
```

### Prototype (reference)
```bash
cd connector-ui && pnpm install && pnpm dev
cd cli/sequence-eco && npm install && node seq-eco.mjs --help
cd cli/trails && npm install && node trails.mjs swap --help
```

## Architecture

### v2 Session Handoff Protocol

CLI generates X25519 keypair → registers public key with Durable Object relay → user opens browser at `/agent?rid=XXX` → wallet connects + approves smart session → browser encrypts session with ECDH + 6-digit code mixed into HKDF salt → posts ciphertext to relay → user types code into terminal → CLI retrieves + decrypts → stores in OS Keychain.

**Crypto:** `@noble/curves` (X25519), `@noble/hashes` (HKDF-SHA256), `@noble/ciphers` (XChaCha20-Poly1305). Pure JS, audited, works in both Node.js and Cloudflare Workers.

**Relay:** Cloudflare Durable Object with 5-minute TTL alarm and 3-attempt code gate. Constant-time hash comparison. Stores only opaque ciphertext — never sees plaintext session material.

**Transaction signing:** CLI reconstructs `@0xsequence/dapp-client-cli` state from Keychain, spawns subprocess for fee-options + send-transaction.

## Key Environment Variables

v2 CLI: `POLYGON_AGENT_RELAY_URL` (defaults to `https://relay.polygon.agent.xyz`), `SEQUENCE_INDEXER_ACCESS_KEY`

v2 Worker: `ECOSYSTEM_WALLET_URL`, `PROJECT_ACCESS_KEY`, `DEFAULT_CHAIN_ID` (set via wrangler.toml or dashboard)

v2 SPA: `VITE_WALLET_URL`, `VITE_PROJECT_ACCESS_KEY`, `VITE_DAPP_ORIGIN` (Vite env vars)

## Conventions

- v2 uses pnpm workspaces with turborepo for builds
- All v2 code is TypeScript strict mode
- Crypto primitives from `@noble/*` family (not tweetnacl)
- Shared types/encoding in `packages/shared`, imported by both worker and cli
- Tests use vitest
- Never bypass GPG signing — if commits fail, stage files and let the user commit manually
