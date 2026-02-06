---
name: sequence-ecosystem-wallet
description: Create and operate a Sequence Ecosystem Wallet (v3) from OpenClaw. Use when Taylan asks to create a wallet request/link, ingest an explicit+implicit session ciphertext, check Polygon balances via Sequence Indexer, or execute Trails intent swaps (exact-input) like USDC->USDT or USDC->POL from the CLI.
---

# Sequence Ecosystem Wallet (Polygon) — Operator Workflow

This repo contains:
- **Connector UI** (Cloudflare Worker) that creates an explicit session and returns ciphertext.
- **CLI** to create wallet requests/links, ingest session material into Keychain, check balances, and execute Trails swaps.

## Assumptions / scope

- Chain: **Polygon (137)** only.
- Nodes URL must remain base: `https://nodes.sequence.app/{network}` (access key stays separate).
- For swaps: **Trails intents** with **exact-input** semantics.

## Environment variables

Required (most commands):
- `SEQUENCE_PROJECT_ACCESS_KEY` (Sequence project access key)

For connector link generation:
- `SEQUENCE_ECOSYSTEM_CONNECTOR_URL` (defaults to the deployed worker URL if you pass it)

For balances via Indexer:
- `SEQUENCE_INDEXER_ACCESS_KEY`

For Trails swaps:
- `TRAILS_API_KEY` (defaults to `SEQUENCE_PROJECT_ACCESS_KEY`)
- `SEQUENCE_ECOSYSTEM_WALLET_URL` (e.g. `https://acme-wallet.ecosystem-demo.xyz`)
- `SEQUENCE_DAPP_ORIGIN` (must match the connector origin; e.g. `https://moltbot-ecosystem-wallet.taylanpince.workers.dev`)

## 1) Create a wallet request / session link

From repo root:

```bash
cd /Users/taylan/.openclaw/workspace/openclaw-ecosystem-wallet-skill
SEQUENCE_ECOSYSTEM_CONNECTOR_URL='https://moltbot-ecosystem-wallet.taylanpince.workers.dev' \
  node cli/sequence-eco/seq-eco.mjs create-request --name demo-eco --chain polygon
```

This prints a `rid` + a `url`.

### Recommended permission shape (open-ended, value-limited)

When generating the link, include limits so we don’t mint per-target sessions:
- `usdcLimit=50`
- `usdtLimit=50`
- `polLimit=100`

Example (append to the `url` printed above):

```
&usdcLimit=50&usdtLimit=50&polLimit=100
```

## 2) Ingest the ciphertext back into the CLI (stores in macOS Keychain)

After Taylan connects in the wallet UI, he sends back a ciphertext blob.

```bash
node cli/sequence-eco/seq-eco.mjs ingest-session \
  --name demo-eco \
  --rid <rid_from_create_request> \
  --ciphertext "<ciphertext>"
```

## 3) Check balances (Polygon)

Requires `SEQUENCE_INDEXER_ACCESS_KEY`.

```bash
SEQUENCE_INDEXER_ACCESS_KEY='...' \
  node cli/sequence-eco/seq-eco.mjs balances --name demo-eco --chain polygon
```

## 4) Swap via Trails (USDC -> USDT or USDC -> POL)

The Trails CLI uses the explicit+implicit session stored in Keychain.

```bash
cd cli/trails
node trails.mjs swap --name demo-eco --from USDC --to USDT --amount 1 --broadcast
```

Output includes:
- `depositTxHash`
- a PolygonScan link
- `intentId`
- receipt status from `waitIntentReceipt`

### Notes

- If a Trails execution errors with internal relayer connectivity issues, the **deposit tx can still be mined**; re-check receipt status by re-running the command (or add a dedicated status command later).
- For user-visible transaction responses: always include the block explorer link.
