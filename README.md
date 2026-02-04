# openclaw-ecosystem-wallet-skill

Work-in-progress OpenClaw skill + tooling for a **Sequence Ecosystem Wallet (v3)** demo flow.

This repo contains:

- `connector-ui/` – a small web UI (Cloudflare Worker + Vite/React) that initiates an Ecosystem Wallet connection and exports session material as an encrypted blob for copy/paste.
- `cli/sequence-eco/` – a Node CLI that:
  - creates a link request
  - ingests the encrypted blob
  - stores session material locally (Keychain on macOS via `keytar`)
  - (WIP) headless transaction sending
- `research/` – notes and links used while building the prototype

## Status

- Linking + ingest works.
- Headless send support is still being finalized upstream in `sequence.js`.

## Setup

### Prereqs

- Node.js 20+
- pnpm (for `connector-ui`)
- Cloudflare Wrangler (for deploying the worker UI)

### Connector UI

```bash
cd connector-ui
pnpm install
pnpm dev
```

To deploy:

```bash
pnpm build
wrangler deploy
```

### CLI

```bash
cd cli/sequence-eco
npm install
node seq-eco.mjs --help
```

## Configuration / Secrets

This repo uses `.env` files locally. **Do not commit secrets.**

- Copy `.env.example` → `.env` where needed and fill in values.
- All `*.env` files are gitignored (except `.env.example`).

## Notes

This repo intentionally avoids machine-specific paths and personal identifiers.
