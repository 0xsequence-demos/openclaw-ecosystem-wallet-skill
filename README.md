# openclaw-ecosystem-wallet-skill

OpenClaw skill + tooling for **Polygon Ecosystem Wallet** agent integration.

## v2 (Active Development)

The v2 implementation lives in [`packages/`](./packages/) — a pnpm monorepo with a relay-based session handoff protocol. See **[packages/README.md](./packages/README.md)** for setup, local dev, and architecture docs.

```bash
cd packages && pnpm install && pnpm build && pnpm test
```

## Prototype (Reference)

The original prototype directories remain as reference for SDK integration patterns:

- `connector-ui/` – web UI (Cloudflare Worker + Vite/React) for wallet linking via TweetNaCl sealed-box
- `cli/sequence-eco/` – Node CLI for wallet operations (plain .mjs, no build step)
- `cli/trails/` – Trails DEX swap CLI
- `research/` – design notes, security architecture, implementation plan

## Setup (from scratch)

### Prereqs

- Node.js 20+
- pnpm (for `connector-ui`)
- Cloudflare Wrangler (`wrangler deploy`)
- ngrok (only required if you want webhook ingestion)
- macOS Keychain access (the CLI uses `keytar` and stores sessions under Keychain service `openclaw.sequence-ecosystem`)

### 1) Install deps

#### Connector UI

```bash
cd connector-ui
pnpm install
```

#### CLI

```bash
cd cli/sequence-eco
npm install
```

### 2) Configure env

This repo uses `.env` files locally. **Do not commit secrets.**

- Connector UI: copy `connector-ui/.env.example` → `connector-ui/.env`
- CLI: copy `cli/sequence-eco/.env.local.example` → `cli/sequence-eco/.env.local`

Required env vars (CLI):

- `SEQUENCE_PROJECT_ACCESS_KEY` – Sequence project access key
- `SEQUENCE_INDEXER_ACCESS_KEY` – Sequence indexer access key (often the same as project access key)

Optional / advanced:

- `SEQUENCE_INDEXER_URL` – defaults to IndexerGateway
- `SEQUENCE_ECOSYSTEM_WALLET_URL` – defaults to `https://acme-wallet.ecosystem-demo.xyz`
- `SEQUENCE_DAPP_ORIGIN` – should match the connector worker origin (e.g. `https://moltbot-ecosystem-wallet.<you>.workers.dev`)
- `SEQUENCE_ECOSYSTEM_CONNECTOR_URL` – connector worker base URL (same as origin)

Notes on passphrases:

- `DAPP_CLIENT_CLI_PASSPHRASE` must be set when broadcasting transactions.
- The wrapper recreates the encrypted CLI state on each run (derived from Keychain), so the passphrase does not need to be stable across runs.

All `*.env*` files are gitignored except `*.example` files.

### 3) Run / deploy the connector UI

Local dev:

```bash
cd connector-ui
pnpm dev
```

Deploy to Cloudflare:

```bash
cd connector-ui
pnpm build
wrangler deploy
```

This publishes a static SPA Worker (see `connector-ui/wrangler.toml`). The `/link` path is supported via SPA fallback.

---

## Using the Ecosystem Wallet CLI

All commands below run from `cli/sequence-eco/`.

### Quick help

```bash
node seq-eco.mjs --help
```

### Link a wallet (webhook mode; recommended)

This generates a one-time link and starts a local webhook endpoint exposed via ngrok. After you approve in the wallet UI, the session is ingested automatically and stored in Keychain.

```bash
export SEQUENCE_ECOSYSTEM_CONNECTOR_URL='https://<your-worker>.workers.dev'

node seq-eco.mjs create-request \
  --name arb-nova-undep \
  --chain arbitrum-nova \
  --webhook \
  --native-limit 1
```

The output contains a `url` you should open to approve.

### Link a wallet (manual ingestion)

If you don’t want webhook/ngrok, omit `--webhook` and later run:

```bash
node seq-eco.mjs ingest-session --name <walletName> --rid <rid> --ciphertext '<b64url>'
```

### View wallet address

```bash
node seq-eco.mjs address --name arb-nova-undep
```

### View balances

```bash
node seq-eco.mjs balances --name arb-nova-undep --chain arbitrum-nova
```

### Send native ETH (relayed)

```bash
export DAPP_CLIENT_CLI_PASSPHRASE='anything-you-want'
export SEQUENCE_DAPP_ORIGIN='https://<your-worker>.workers.dev'
export SEQUENCE_ECOSYSTEM_WALLET_URL='https://acme-wallet.ecosystem-demo.xyz'
export SEQUENCE_PROJECT_ACCESS_KEY='...'

node seq-eco.mjs send-native \
  --name arb-nova-undep \
  --chain arbitrum-nova \
  --to 0xRecipient... \
  --amount 0.0001 \
  --broadcast
```

### Send ERC20 / token helpers

- `send-erc20` (explicit token address + decimals)
- `send-token` (symbol resolver via token directory)

---

## Notes

- The CLI intentionally routes broadcast transactions through `@0xsequence/dapp-client-cli` to match the official calldata bundling and fee-option behavior.
- Sessions and keys are stored locally; **do not commit secrets**.
