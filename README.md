# Polygon Agent Wallet

OpenClaw skill + CLI for **Polygon Ecosystem Wallet** agent integration.

## Quick Start

```bash
cd packages && pnpm install && pnpm build && pnpm test
```

See **[packages/README.md](./packages/README.md)** for full setup, local dev, and architecture docs.

## Structure

- **`packages/`** — pnpm monorepo (shared crypto, Cloudflare Worker relay, React SPA, CLI)
- **`cli/trails/`** — Trails DEX swap CLI (to be ported)
- **`research/`** — Security architecture, implementation plan, design notes
