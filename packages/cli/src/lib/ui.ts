import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import { Network } from '@0xsequence/wallet-primitives'

// Brand colors
const purple = chalk.hex('#8247e5')
const dim = chalk.dim
const bold = chalk.bold

export const ui = {
  // Labels & values
  label: (text: string) => dim(text),
  value: (text: string) => bold(text),
  address: (addr: string) => chalk.cyan(addr),
  shortAddress: (addr: string) => chalk.cyan(addr.slice(0, 6) + '…' + addr.slice(-4)),
  hash: (h: string) => chalk.cyan(h),
  token: (symbol: string) => chalk.yellow(symbol),
  amount: (val: string) => chalk.green(val),
  chain: (id: number) => purple(`chain ${id}`),
  error: (msg: string) => chalk.red(msg),
  success: (msg: string) => chalk.green('✓ ') + msg,
  warn: (msg: string) => chalk.yellow('⚠ ') + msg,
  info: (msg: string) => dim('ℹ ') + msg,

  // Header
  header: (text: string) => console.log('\n' + purple.bold(text)),

  // Key-value pairs
  kv: (key: string, value: string, indent = 2) => {
    console.log(' '.repeat(indent) + dim(key + ':') + ' ' + value)
  },

  // Divider
  divider: (width = 48) => console.log(dim('─'.repeat(width))),

  // Table for balances
  balanceTable: (rows: { symbol: string; amount: string; address: string }[]) => {
    if (rows.length === 0) {
      console.log(dim('  No balances found.'))
      return
    }

    const symWidth = Math.max(8, ...rows.map(r => r.symbol.length)) + 2
    const amtWidth = Math.max(12, ...rows.map(r => r.amount.length)) + 2

    // Header
    console.log(
      dim('  ' + 'Token'.padEnd(symWidth) + 'Balance'.padStart(amtWidth) + '  Address')
    )
    console.log(dim('  ' + '─'.repeat(symWidth + amtWidth + 44)))

    for (const r of rows) {
      const sym = chalk.yellow(r.symbol.padEnd(symWidth))
      const amt = chalk.green(r.amount.padStart(amtWidth))
      const addr = r.address === '(native)'
        ? dim('(native)')
        : chalk.cyan(r.address.slice(0, 6) + '…' + r.address.slice(-4))
      console.log('  ' + sym + amt + '  ' + addr)
    }
  },

  // Sessions table
  sessionRow: (name: string, addr: string, chainId: number, expiry: string, expired: boolean) => {
    const status = expired ? chalk.red(' [EXPIRED]') : chalk.green(' [ACTIVE]')
    console.log(
      '  ' + bold(name.padEnd(16)) +
      chalk.cyan(addr.slice(0, 6) + '…' + addr.slice(-4)) +
      '  ' + purple(`chain ${chainId}`) +
      dim(` — expires ${expiry}`) +
      status
    )
  },

  // Dry-run box
  dryRun: (fields: [string, string][]) => {
    console.log('\n' + chalk.yellow('⚡ Dry run') + dim(' (add --broadcast to send)'))
    ui.divider()
    for (const [k, v] of fields) {
      ui.kv(k, v, 2)
    }
    ui.divider()
  },

  // Block explorer link for a transaction
  explorerUrl: (chainId: number, txHash: string): string | null => {
    const network = Network.getNetworkFromChainId(chainId)
    if (!network?.blockExplorer?.url) return null
    const base = network.blockExplorer.url.replace(/\/$/, '')
    return `${base}/tx/${txHash}`
  },

  // Print transaction result with explorer link
  txResult: (txHash: string, chainId: number, fields: [string, string][]) => {
    console.log()
    ui.kv('Tx Hash', ui.hash(txHash))
    for (const [k, v] of fields) {
      ui.kv(k, v)
    }
    const url = ui.explorerUrl(chainId, txHash)
    if (url) {
      ui.kv('Explorer', chalk.underline(url))
    }
    console.log()
  },

  // Transaction progress spinner
  spinner: (text: string): Ora => {
    return ora({ text, color: 'magenta', spinner: 'dots' }).start()
  },
}
