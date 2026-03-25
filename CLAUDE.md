# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw skill for Sequence Ecosystem Wallet v3. Three independent packages (not a monorepo):

- **`connector-ui/`** — Cloudflare Worker + React/Vite SPA for wallet linking. Generates session material, encrypts with TweetNaCl sealed-box, exports ciphertext for CLI ingestion.
- **`cli/sequence-eco/`** — Node.js CLI for wallet operations (link, ingest, balances, send). Stores sessions in macOS Keychain via `keytar`. Bridges to `@0xsequence/dapp-client-cli` for headless transaction signing.
- **`cli/trails/`** — Node.js CLI for DEX swaps via Trails API using sessions from Keychain.

## Build & Dev Commands

### Connector UI (pnpm)
```bash
cd connector-ui
pnpm install
pnpm dev          # Vite dev server on localhost:4444
pnpm build        # tsc -b && vite build
pnpm lint         # ESLint
wrangler deploy   # Deploy to Cloudflare Workers
```

### CLI packages (npm, no build step — pure .mjs)
```bash
cd cli/sequence-eco && npm install
node seq-eco.mjs --help

cd cli/trails && npm install
node trails.mjs swap --help
```

## Architecture

**Session flow:** Connector UI creates encrypted session → CLI ingests & decrypts → stores in Keychain → subsequent commands reconstruct dapp-client-cli state from Keychain.

**Transaction signing:** CLI commands that broadcast transactions (`send-native`, `send-erc20`, `send-token`, Trails swaps) go through `dapp-client-cli-bridge.mjs`, which spawns `@0xsequence/dapp-client-cli` as a subprocess, passes JSON state via stdin, and parses JSON results from mixed stdout output.

**Crypto:** TweetNaCl sealed-box for session encryption between UI and CLI. `DAPP_CLIENT_CLI_PASSPHRASE` env var required for transaction broadcasting.

## Key Environment Variables

Required: `SEQUENCE_PROJECT_ACCESS_KEY`, `SEQUENCE_INDEXER_ACCESS_KEY`

Connector UI uses `VITE_` prefixed equivalents. See `.env.example` (connector-ui) and `.env.local.example` (cli/sequence-eco) for full lists.

## Conventions

- CLI packages are plain Node.js ES modules (`.mjs`), no TypeScript, no build step
- Connector UI uses TypeScript strict mode with React 18
- Core dependency: `@0xsequence/*` v3.0.0-beta.17
- No test suite exists; testing is manual via CLI commands
- ESLint configured only for connector-ui (flat config format)
- Package managers differ: pnpm for connector-ui, npm for CLI packages
