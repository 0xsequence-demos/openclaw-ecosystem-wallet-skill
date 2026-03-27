# Polygon Agent Wallet

OpenClaw skill + CLI for **Polygon Ecosystem Wallet** agent integration. Connect a wallet via browser, approve a scoped session, and operate it headlessly from the CLI.

## Quick Start

```bash
pnpm install && pnpm build && pnpm test
```

## Local Development

```bash
# Start the relay + SPA dev server (port 8787)
pnpm dev:worker

# Connect a wallet (opens browser)
pnpm cli:connect --name mywall --token-limits "USDC:50"

# Check balances
pnpm cli:balances --name mywall

# Send tokens
pnpm cli:send-native --name mywall --to 0x... --amount 0.001 --broadcast
pnpm cli:send-token --name mywall --symbol USDC --to 0x... --amount 1 --broadcast
```

## All Commands

| Command | Description |
|---------|-------------|
| `pnpm install` | Install all dependencies |
| `pnpm build` | Build all packages |
| `pnpm test` | Run all tests |
| `pnpm dev:worker` | Start relay + SPA on port 8787 |
| `pnpm dev:ui` | Start Vite HMR on port 4444 |
| `pnpm test:relay` | Run relay integration tests (26 tests) |
| `pnpm deploy` | Deploy Worker to Cloudflare |

### CLI

All CLI commands accept `--help` for usage details.

| Command | Description |
|---------|-------------|
| `pnpm cli --help` | Show all CLI commands |
| `pnpm cli:connect --name <n>` | Connect wallet via browser |
| `pnpm cli:sessions` | List stored sessions |
| `pnpm cli:address --name <n>` | Show wallet address |
| `pnpm cli:balances --name <n>` | Show token balances |
| `pnpm cli:send-native --name <n> --to <addr> --amount <amt> --broadcast` | Send native token (POL/ETH) |
| `pnpm cli:send-token --name <n> --symbol USDC --to <addr> --amount <amt> --broadcast` | Send token by symbol |
| `pnpm cli:send-erc20 --name <n> --token <addr> --decimals <d> --to <addr> --amount <amt> --broadcast` | Send ERC20 by address |
| `pnpm cli:disconnect --name <n>` | Remove stored session |

### Connect Options

```bash
pnpm cli:connect \
  --name mywall \
  --chain polygon \
  --native-limit 2 \
  --token-limits "USDC:50,USDT:50,WETH:0.1" \
  --no-browser   # print URL instead of opening browser
```

## Structure

| Path | Description |
|------|-------------|
| `packages/shared` | Crypto protocol (X25519, HKDF, XChaCha20) + shared types |
| `packages/worker` | Cloudflare Worker — Durable Object relay + API |
| `packages/worker/ui` | React SPA — wallet connect + session approval + code display |
| `packages/cli` | TypeScript CLI — `polygon-agent` command |
| `cli/trails` | Trails DEX swap CLI (to be ported) |
| `research` | Security architecture, implementation plan, design notes |

## Architecture

See [packages/README.md](./packages/README.md) for the full protocol description, environment variables, and architecture diagram.
