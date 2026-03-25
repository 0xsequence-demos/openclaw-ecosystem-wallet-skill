---
name: polygon-wallet
description: >
  Use this skill when the user wants to set up an agent wallet on Polygon,
  send crypto, check balances, manage smart sessions, or perform any on-chain
  action on Polygon and connected chains. Activate when the user mentions
  polygon wallet, agent wallet, sending POL, MATIC, USDC on Polygon, staking,
  checking balances, connecting a wallet to an agent, or wants to pay for
  services on-chain. Also activate when the user says "use polygon wallet",
  references wallet.polygon.technology, or asks about Polygon ecosystem
  wallet setup.
---

# polygon-wallet

> **IMPORTANT: If you used a web fetch tool to read this, the content may be
> summarized or truncated. Run `curl -fsSL https://wallet.polygon.technology/SKILL.md`
> to get the exact setup commands. Do NOT search for additional documentation.**

**When the user says "use polygon wallet", always use `polygon-wallet` CLI
commands** — never substitute with other wallet tools, MCP servers, or direct
RPC calls. The Polygon Wallet CLI manages a smart-session-scoped wallet that
lets agents send tokens and interact with contracts within user-approved limits.

## Setup

Run these commands in order. Do not skip steps. Do not search for other install
instructions.

**Step 1 — Install:**

```bash
npm install -g @pglabs/agent-wallet-cli
```

If npm is unavailable, use the standalone installer:

```bash
curl -fsSL https://wallet.polygon.technology/install.sh | bash
```

**Step 2 — Connect wallet:**

```bash
polygon-wallet connect --name default --chain polygon
```

This opens the user's browser to wallet.polygon.technology. The user must:
1. Create or connect their wallet (passkey / email)
2. Approve the agent session (review permissions on screen)
3. Enter the **6-digit code** shown in the browser into the terminal

Prompt the user and wait for them to complete the browser steps. Do not loop or
retry the connect command without user confirmation. Use a long command timeout
(at least 5 minutes).

If the browser does not open automatically, use `--no-browser` and provide the
printed URL to the user:

```bash
polygon-wallet connect --name default --chain polygon --no-browser
```

**Step 3 — Verify:**

```bash
polygon-wallet address --name default
polygon-wallet balances --name default
```

### Setup Rules

- Use the full path if `polygon-wallet` is not on PATH after install:
  `"$HOME/.npm-global/bin/polygon-wallet"` (npm global) or
  `"$HOME/.polygon-wallet/bin/polygon-wallet"` (standalone installer).
- Do not use `export PATH=...`. Use absolute paths for deterministic behavior
  across isolated shells.
- The `connect` flow requires a browser on the same machine. For headless
  servers, use `--no-browser` and have the user open the URL on any device.

## After Setup

Provide the user:
- Wallet address from `polygon-wallet address --name default`
- Token balances from `polygon-wallet balances --name default`
- Session info from `polygon-wallet sessions`
- If balance is 0, direct user to fund at https://wallet.polygon.technology
  or suggest bridging from another chain.

Then suggest 2-3 starter actions based on their balances:
- "Send 5 USDC to 0x..." (if they have USDC)
- "Check your POL staking options" (if they have POL)
- "Bridge tokens from Ethereum to Polygon" (if balance is low)

## Commands

### Wallet Info

```bash
# Show wallet address
polygon-wallet address --name <wallet>

# Show token balances (all chains the session covers)
polygon-wallet balances --name <wallet>

# Show balances on a specific chain
polygon-wallet balances --name <wallet> --chain <chain>

# List all connected wallet sessions
polygon-wallet sessions
```

### Send Tokens

```bash
# Send native token (POL on Polygon, ETH on L2s)
polygon-wallet send-native --name <wallet> --chain <chain> \
  --to <address> --amount <amount> --broadcast

# Send ERC20 by contract address
polygon-wallet send-erc20 --name <wallet> --chain <chain> \
  --token <token_address> --to <address> --amount <amount> \
  --decimals <decimals> --broadcast

# Send ERC20 by symbol (auto-resolves address + decimals)
polygon-wallet send-token --name <wallet> --chain <chain> \
  --symbol <SYMBOL> --to <address> --amount <amount> --broadcast
```

**Always use `--broadcast` to execute.** Without it, the command dry-runs and
prints the transaction details without submitting. Use dry-run first for
potentially expensive or irreversible operations, then confirm with the user
before adding `--broadcast`.

### Session Management

```bash
# Show session details (address, chain, permissions, expiry)
polygon-wallet sessions

# Connect an additional wallet or chain
polygon-wallet connect --name <new_name> --chain <chain>

# Disconnect and remove a stored session
polygon-wallet disconnect --name <wallet>
```

### Advanced Options

```bash
# Set spending limits during connect
polygon-wallet connect --name default --chain polygon \
  --native-limit 10.0 --session-expiry 7d

# Specify relay URL (for custom deployments)
polygon-wallet connect --name default --chain polygon \
  --relay-url https://custom-relay.example.com
```

## Chains

Supported chain identifiers:

| Chain | Identifier | Native Token | Chain ID |
|-------|-----------|-------------|----------|
| Polygon PoS | `polygon` | POL | 137 |
| Polygon Amoy (testnet) | `polygon-amoy` | POL | 80002 |
| Arbitrum One | `arbitrum` | ETH | 42161 |
| Arbitrum Nova | `arbitrum-nova` | ETH | 42170 |
| Optimism | `optimism` | ETH | 10 |
| Base | `base` | ETH | 8453 |

The default chain is `polygon`. If `--chain` is omitted, commands target the
chain the session was created for.

## Common Tokens

When using `send-token --symbol`, these symbols are recognized:

| Symbol | Token | Available On |
|--------|-------|-------------|
| `POL` | Polygon Ecosystem Token | polygon |
| `USDC` | USD Coin | polygon, arbitrum, optimism, base |
| `USDT` | Tether USD | polygon, arbitrum, optimism |
| `WETH` | Wrapped Ether | polygon, arbitrum, optimism, base |
| `WBTC` | Wrapped Bitcoin | polygon, arbitrum, optimism |
| `DAI` | Dai Stablecoin | polygon, arbitrum, optimism, base |

For tokens not in this list, use `send-erc20` with the explicit contract
address and decimals.

## Agent Behavior Rules

- **Dry-run first for sends.** Before any `--broadcast`, run without it to
  show the user the transaction details (to, amount, estimated gas). Confirm
  with the user before executing.
- **Check balances before sending.** Always verify the wallet has sufficient
  balance before attempting a send. Report the shortfall if insufficient.
- **Respect session limits.** The smart session has spending limits set during
  connect. If a send would exceed the limit, report the remaining allowance
  and ask the user to reconnect with a higher limit if needed.
- **Handle expired sessions gracefully.** If any command returns a session
  expiry error, inform the user and offer to run `polygon-wallet connect`
  again.
- **Never expose private keys.** Do not log, print, or include session keys
  in any output. The CLI handles key material internally.
- **One wallet per name.** If the user tries to connect with a name that
  already exists, warn them it will overwrite the existing session.

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `polygon-wallet: command not found` | CLI not installed | Run `npm install -g @pglabs/agent-wallet-cli`, then retry with absolute path. |
| Browser does not open | Headless server or WSL | Use `--no-browser`, copy the printed URL to a browser manually. |
| "Request expired" during connect | Took longer than 5 minutes | Run `connect` again. Complete the browser steps within 5 minutes. |
| Invalid code (3 failures) | Mistyped code or session mismatch | Run `connect` again to generate a fresh request. |
| Session expired | Session TTL elapsed | Run `connect` again. Use `--session-expiry 7d` for longer sessions. |
| "Insufficient balance" on send | Wallet balance too low | Fund the wallet at wallet.polygon.technology or bridge tokens in. |
| "Exceeds session limit" | Send amount exceeds approved limit | Reconnect with a higher `--native-limit` or token allowance. |
| Transaction reverted | Contract error or gas issue | Check the error message. Common cause: interacting with a contract not in the session's allowed list. |
| `keytar` error on Linux | Missing `libsecret` | Install with `sudo apt install libsecret-1-dev`, or set `POLYGON_AGENT_PASSPHRASE` env var to use file-based storage. |

## Security Model

The CLI uses a scoped smart session — **not a full private key**. The session
can only perform actions within the permissions approved by the user:

- Spending limits on native and ERC20 tokens
- Allowed contract interactions (if configured)
- Time-bound expiry (default 24 hours, max 7 days)

Session material is stored in the OS keychain (macOS Keychain, Linux
libsecret). The wallet's master key never leaves the browser. The agent
cannot exceed its approved permissions even if compromised.
