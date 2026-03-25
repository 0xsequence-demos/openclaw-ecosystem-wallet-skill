# SKILL.md Hosting & Distribution Guide

## Hosting Strategy

### Primary: `wallet.polygon.technology/SKILL.md`

The canonical SKILL.md lives on the wallet domain. This is the URL that agents
fetch, users share, and documentation references.

**Implementation:** Add a route to the wallet.polygon.technology Cloudflare
Pages/Worker deployment that serves the SKILL.md as raw markdown:

```typescript
// In the wallet site's Cloudflare Worker or _routes.json

// Option A: Worker route (if wallet site uses a Worker)
if (url.pathname === '/SKILL.md') {
  const skill = await env.ASSETS.fetch(new Request('https://dummy/SKILL.md'))
  return new Response(skill.body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',  // 5 min cache
      'Access-Control-Allow-Origin': '*',       // agents fetch cross-origin
    }
  })
}

// Option B: Cloudflare Pages _headers file
// Place SKILL.md in the public/ directory and add to _headers:
//
// /SKILL.md
//   Content-Type: text/markdown; charset=utf-8
//   Access-Control-Allow-Origin: *
//   Cache-Control: public, max-age=300
```

**Critical requirements:**
- Must return raw markdown, not HTML-rendered markdown
- Must include `Access-Control-Allow-Origin: *` (agents fetch from various origins)
- Must be accessible without authentication
- Should have a short cache TTL (5 min) so updates propagate quickly
- The response must be the complete file — no truncation, no summarization

### Secondary: `wallet.polygon.technology/install.sh`

A standalone installer script for environments where npm is not available:

```bash
#!/bin/bash
set -euo pipefail

INSTALL_DIR="$HOME/.polygon-wallet/bin"
PACKAGE="@pglabs/agent-wallet-cli"

mkdir -p "$INSTALL_DIR"

# Download pre-built binary or use npx
if command -v npm &>/dev/null; then
  npm install -g "$PACKAGE"
  BINARY="$(npm bin -g)/polygon-wallet"
else
  # Fallback: download standalone binary from GitHub releases
  PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  URL="https://github.com/pglabs/agent-wallet-cli/releases/latest/download/polygon-wallet-${PLATFORM}-${ARCH}"
  curl -fsSL "$URL" -o "$INSTALL_DIR/polygon-wallet"
  chmod +x "$INSTALL_DIR/polygon-wallet"
  BINARY="$INSTALL_DIR/polygon-wallet"
fi

echo "Installed: $BINARY"
echo "Version: $("$BINARY" --version)"
```

### Distribution: GitHub + ClawHub

Publish the skill to the OpenClaw skills registry (ClawHub) for community
discovery. The GitHub repo structure:

```
github.com/pglabs/polygon-wallet-skill/
├── SKILL.md                    # Canonical copy (synced from wallet domain)
├── install.md                  # Points to wallet.polygon.technology/SKILL.md
├── README.md                   # Human-readable docs + badges
├── references/
│   ├── chains.md               # Detailed chain configuration
│   ├── smart-sessions.md       # How smart sessions work
│   └── security-model.md       # Security architecture
└── scripts/
    └── install.sh              # Standalone installer
```

The `install.md` for ClawHub / agent installation:

```markdown
Read https://wallet.polygon.technology/SKILL.md and follow the setup
instructions to install the Polygon Wallet CLI and connect your agent wallet.
```

This ensures agents always fetch the latest version from the canonical URL
rather than a potentially stale GitHub copy.

### Registration on ClawHub

```bash
# Publish to ClawHub (OpenClaw's skill registry)
cd polygon-wallet-skill
openclaw skill publish
```

The skill will appear at `https://clawhub.ai/pglabs/polygon-wallet`.

## Multi-Agent Support

The SKILL.md format is cross-platform. The same file works with:

| Agent Platform | How It's Loaded |
|---------------|----------------|
| **Claude Code** | `claude -p "Read https://wallet.polygon.technology/SKILL.md and connect my wallet"` or install to `~/.claude/skills/polygon-wallet/SKILL.md` |
| **OpenClaw** | Install via ClawHub: `openclaw skill install pglabs/polygon-wallet` or paste the GitHub URL in chat |
| **OpenAI Codex** | `codex exec "Read https://wallet.polygon.technology/SKILL.md and connect my wallet"` or install to `~/.codex/skills/polygon-wallet/SKILL.md` |
| **Cursor / Windsurf** | Add to project `.cursor/skills/polygon-wallet/SKILL.md` |
| **Gemini CLI** | `gemini -p "Read https://wallet.polygon.technology/SKILL.md and set up my wallet"` |
| **Direct curl** | `curl -fsSL https://wallet.polygon.technology/SKILL.md` |

The CTA on wallet.polygon.technology should include copy-paste commands for the
top 3 platforms:

```
Claude Code:  claude -p "Read https://wallet.polygon.technology/SKILL.md and connect my Polygon wallet"
OpenClaw:     Read https://wallet.polygon.technology/SKILL.md and connect my Polygon wallet
Codex:        codex exec "Read https://wallet.polygon.technology/SKILL.md and connect my Polygon wallet"
```

## Versioning

The SKILL.md should include a version comment (not in frontmatter, to avoid
breaking parsers that don't expect it):

```markdown
<!-- skill-version: 1.0.0 -->
```

When the CLI has breaking changes, bump the version and update the SKILL.md
simultaneously. The 5-minute cache TTL on the Cloudflare edge ensures agents
pick up changes quickly.

## Landing Page Integration

The wallet.polygon.technology landing page (Daniel's redesign) should feature
the SKILL.md prominently:

1. **Hero section**: "Your wallet, your agent" — primary CTA is the agent
   setup command
2. **Copy-to-clipboard buttons** for each agent platform
3. **Live status indicator** showing how many active agent sessions exist
   (anonymous aggregate from the relay)
4. **Below the fold**: traditional wallet UI for non-agent users

The page should detect if the user arrived from a `?rid=` parameter (agent
connection flow) vs. a direct visit, and show the appropriate UI.
