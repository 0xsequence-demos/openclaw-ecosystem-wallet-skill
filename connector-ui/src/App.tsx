import { useEffect, useMemo, useState } from 'react'
import './App.css'

import { DappClient, TransportMode, WebStorage, jsonReplacers, Utils, Permission } from '@0xsequence/dapp-client'
import { Hex, Signature } from 'ox'
import sealedbox from 'tweetnacl-sealedbox-js'

import { dappOrigin, projectAccessKey, walletUrl, relayerUrl, nodesUrl, polygonChainId } from './config'

const INDEXER_ACCESS_KEY = import.meta.env.VITE_POLYGON_INDEXER_ACCESS_KEY as string | undefined

function b64urlDecode(str: string): Uint8Array {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4))
  const bin = atob(norm + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function formatUnits(raw: string, decimals: number): string {
  if (!raw) return '0'
  const neg = raw.startsWith('-')
  const v = neg ? raw.slice(1) : raw
  const padded = v.padStart(decimals + 1, '0')
  const i = padded.slice(0, -decimals)
  const f = padded.slice(-decimals).replace(/0+$/, '')
  return `${neg ? '-' : ''}${i}${f ? '.' + f : ''}`
}

async function deleteIndexedDb(dbName: string): Promise<void> {
  await new Promise<void>(resolve => {
    const req = indexedDB.deleteDatabase(dbName)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

async function resetLocalSessionStateForNewRid(rid: string): Promise<boolean> {
  if (!rid) return false
  const key = 'moltbot.lastRid'
  const lastRid = window.localStorage.getItem(key)
  if (lastRid === rid) return false

  window.localStorage.setItem(key, rid)

  // dapp-client uses sessionStorage for pending redirect state
  try {
    sessionStorage.clear()
  } catch {}

  // and IndexedDB for sessions
  await deleteIndexedDb('SequenceDappStorage')

  // also clear local storage keys we might set (keep the rid marker)
  for (const k of Object.keys(localStorage)) {
    if (k === key) continue
    // keep vite keys etc? (none expected)
  }

  return true
}

type BalanceSummary = {
  nativeBalances?: Array<{ name: string; symbol: string; balance: string }>
  balances?: Array<{
    contractType: string
    contractAddress: string
    balance: string
    contractInfo?: { symbol?: string; name?: string; decimals?: number; logoURI?: string }
  }>
}

async function fetchBalances(walletAddress: string): Promise<BalanceSummary> {
  if (!INDEXER_ACCESS_KEY) throw new Error('Missing VITE_POLYGON_INDEXER_ACCESS_KEY')
  const res = await fetch('https://polygon-indexer.sequence.app/rpc/Indexer/GetTokenBalancesSummary', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': INDEXER_ACCESS_KEY
    },
    body: JSON.stringify({
      chainID: 'polygon',
      omitMetadata: false,
      filter: {
        contractStatus: 'VERIFIED',
        accountAddresses: [walletAddress]
      }
    })
  })
  if (!res.ok) throw new Error(`Indexer error: ${res.status}`)
  return res.json()
}

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const rid = params.get('rid') || ''
  const walletName = params.get('wallet') || ''
  const pub = params.get('pub') || ''
  const callbackUrl = params.get('callbackUrl') || ''

  const [error, setError] = useState<string>('')
  const [walletAddress, setWalletAddress] = useState<string>('')
  const [ciphertext, setCiphertext] = useState<string>('')
  const [callbackSent, setCallbackSent] = useState<boolean>(false)
  const [callbackFailed, setCallbackFailed] = useState<boolean>(false)
  const [balances, setBalances] = useState<BalanceSummary | null>(null)
  const [feeTokens, setFeeTokens] = useState<any | null>(null)

  // Reset local session state every time a new rid is opened.
  useEffect(() => {
    ;(async () => {
      const didReset = await resetLocalSessionStateForNewRid(rid)
      if (didReset) window.location.reload()
    })()
  }, [rid])

  const dappClient = useMemo(() => {
    return new DappClient(walletUrl, dappOrigin, projectAccessKey, {
      transportMode: TransportMode.POPUP,
      relayerUrl,
      nodesUrl,
      // default WebStorage (IndexedDB) is fine for browser
      sequenceStorage: new WebStorage()
    })
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        await dappClient.initialize()
        // Prefetch fee tokens so the actual Connect click can open the popup synchronously.
        try {
          setFeeTokens(await dappClient.getFeeTokens(polygonChainId))
        } catch {
          setFeeTokens(null)
        }
      } catch (e: any) {
        setError(e?.message || String(e))
      }
    })()
  }, [dappClient])

  const connect = async () => {
    // feeTokens are prefetched to keep UX snappy.
    void feeTokens
    setError('')
    setCiphertext('')
    setCallbackSent(false)
    setCallbackFailed(false)

    if (!rid || !walletName || !pub) {
      setError('Invalid link. Missing rid/wallet/pub.')
      return
    }

    try {
      const VALUE_FORWARDER = '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca'
      const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
      const USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'

      // Base explicit session permission: allow calling the Sequence ValueForwarder.
      // NOTE: This mirrors wallet-dapp-client-cli (it uses { target: VALUE_FORWARDER, rules: [] }).
      // We tried function-scoped permissions, but dapp-client signer selection rejected calls.
      const basePermissions: any[] = [{ target: VALUE_FORWARDER, rules: [] }]

      const params = new URLSearchParams(window.location.search)

      // Optional: one-off ERC20 permission scoped by link params (kept for backwards-compat).
      const erc20 = params.get('erc20')
      const erc20To = params.get('erc20To')
      const erc20Amount = params.get('erc20Amount')

      const oneOffErc20Permissions: any[] =
        erc20 && erc20To && erc20Amount
          ? (() => {
              const tokenAddr = erc20.toLowerCase() === 'usdc' ? USDC : erc20
              const decimals = erc20.toLowerCase() === 'usdc' ? 6 : 18

              const [i, fRaw = ''] = String(erc20Amount).split('.')
              const f = (fRaw + '0'.repeat(decimals)).slice(0, decimals)
              const valueLimit = BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt(f || '0')

              return [
                Utils.PermissionBuilder.for(tokenAddr as any)
                  .forFunction('function transfer(address to, uint256 value)')
                  .withUintNParam('value', valueLimit, 256, Permission.ParameterOperation.LESS_THAN_OR_EQUAL, true)
                  .withAddressParam('to', erc20To as any, Permission.ParameterOperation.EQUAL, false)
                  .build()
              ]
            })()
          : []

      // Open-ended per-token limits (no fixed recipient), so we can operate without per-target sessions.
      // Query params:
      // - usdcLimit (e.g. 50)
      // - usdtLimit (e.g. 50)
      // - polLimit  (e.g. 100)
      const usdcLimit = params.get('usdcLimit')
      const usdtLimit = params.get('usdtLimit')
      const polLimit = params.get('polLimit')

      const openTokenPermissions: any[] = []
      if (usdcLimit) {
        const valueLimit = BigInt(parseFloat(usdcLimit) * 1e6)
        openTokenPermissions.push(
          Utils.PermissionBuilder.for(USDC as any)
            .forFunction('function transfer(address to, uint256 value)')
            .withUintNParam('value', valueLimit, 256, Permission.ParameterOperation.LESS_THAN_OR_EQUAL, true)
            .build()
        )
      }
      if (usdtLimit) {
        const valueLimit = BigInt(parseFloat(usdtLimit) * 1e6)
        openTokenPermissions.push(
          Utils.PermissionBuilder.for(USDT as any)
            .forFunction('function transfer(address to, uint256 value)')
            .withUintNParam('value', valueLimit, 256, Permission.ParameterOperation.LESS_THAN_OR_EQUAL, true)
            .build()
        )
      }

      // const paymentAddress = (feeTokens as any)?.paymentAddress

      // Fee-option permissions (pre-approvals) so the session can pay fees with ERC20s if needed.
      // IMPORTANT: We do NOT add a blanket permission for paymentAddress itself.
      // Instead, we scope permissions to ERC20.transfer(to=paymentAddress, value<=limit) per fee token.
      const nativeFeePermission: any[] = []

      const feePermissions: any[] =
        (feeTokens as any)?.isFeeRequired && (feeTokens as any)?.paymentAddress && Array.isArray((feeTokens as any)?.tokens)
          ? ((feeTokens as any).tokens as any[])
              .filter((t) => !!t?.contractAddress)
              .map((token: any) => {
                const decimals = typeof token.decimals === 'number' ? token.decimals : 6
                const valueLimit =
                  decimals === 18
                    ? 100000000000000000n // 0.1 * 1e18
                    : 50n * 10n ** BigInt(decimals)

                return Utils.PermissionBuilder.for(token.contractAddress as any)
                  .forFunction('function transfer(address to, uint256 value)')
                  .withUintNParam('value', valueLimit, 256, Permission.ParameterOperation.LESS_THAN_OR_EQUAL, true)
                  .withAddressParam('to', (feeTokens as any).paymentAddress as any, Permission.ParameterOperation.EQUAL, false)
                  .build()
              })
          : []

      const polValueLimit = polLimit ? BigInt(Math.floor(parseFloat(polLimit) * 1e18)) : 2000000000000000000n

      const sessionConfig = {
        chainId: polygonChainId,
        // Native spend limit (POL)
        valueLimit: polValueLimit,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24),
        permissions: [...basePermissions, ...oneOffErc20Permissions, ...openTokenPermissions, ...nativeFeePermission, ...feePermissions]
      }

      // Connect will open the wallet UI (popup).
      await dappClient.connect(polygonChainId, sessionConfig as any, { includeImplicitSession: true })

      const addr = await dappClient.getWalletAddress()
      if (!addr) throw new Error('Wallet address not available after connect')
      setWalletAddress(addr)

      // Read explicit + implicit session material from dapp-client storage.
      const storage = (dappClient as any).sequenceStorage

      const sessions = await storage.getExplicitSessions()
      const explicit = (sessions || []).find(
        (s: any) => String(s.chainId) === String(polygonChainId) && String(s.walletAddress).toLowerCase() === addr.toLowerCase()
      )
      if (!explicit?.pk) throw new Error('Could not locate explicit session pk after connect')

      const implicit = await storage.getImplicitSession()
      if (!implicit?.pk || !implicit?.attestation || !implicit?.identitySignature) {
        throw new Error('Could not locate implicit session material after connect')
      }

      // identitySignature must be a serialized 65-byte signature hex string.
      // In some dapp-client/ox paths, this can be an object (e.g. { r, s, yParity }) or Uint8Array.
      const sigAny: any = implicit.identitySignature
      let identitySignature: string
      try {
        if (typeof sigAny === 'string') {
          identitySignature = sigAny
        } else if (sigAny instanceof Uint8Array) {
          identitySignature = Hex.from(sigAny)
        } else if (sigAny && typeof sigAny === 'object') {
          if (typeof sigAny.data === 'string') {
            // jsonReplacers may have wrapped a Uint8Array as { _isUint8Array: true, data: '0x..' }
            identitySignature = sigAny.data
          } else {
            identitySignature = Signature.toHex(sigAny)
          }
        } else {
          throw new Error('Unsupported identitySignature type')
        }
      } catch (e: any) {
        throw new Error(`Could not serialize identitySignature: ${e?.message || String(e)}`)
      }

      // Export material needed for headless v3 signing:
      // - explicit session pk
      // - explicit session config used during connect (permissions/valueLimit/deadline/chainId)
      // - derived sessionAddress
      // dapp-client storage only persists {pk,walletAddress,chainId,...}, not the permissions config.
      const { Secp256k1, Address: OxAddress, Hex: OxHex } = await import('ox')
      const sessionAddress = OxAddress.fromPublicKey(
        Secp256k1.getPublicKey({ privateKey: OxHex.toBytes(explicit.pk) })
      )

      const payload = {
        rid,
        walletName,
        walletAddress: addr,
        chainId: polygonChainId,
        explicitSession: {
          pk: explicit.pk,
          sessionAddress,
          config: sessionConfig
        },
        implicit: {
          pk: implicit.pk,
          attestation: implicit.attestation,
          identitySignature,
          chainId: implicit.chainId,
          // Immutable uses guard/keymachine; preserve metadata so headless can initialize correctly.
          guard: (implicit as any).guard,
          loginMethod: (implicit as any).loginMethod,
          userEmail: (implicit as any).userEmail
        }
      }

      const pubBytes = b64urlDecode(pub)
      const msg = new TextEncoder().encode(JSON.stringify(payload, jsonReplacers))
      const sealed = sealedbox.seal(msg, pubBytes)
      const ciphertextB64u = b64urlEncode(sealed)
      setCiphertext(ciphertextB64u)

      // Optional: auto-submit ciphertext to a one-shot callback URL (e.g. ngrok tunnel).
      // This is client->server (Bloom) direct; do not proxy through the Worker backend.
      if (
        callbackUrl &&
        typeof callbackUrl === 'string' &&
        callbackUrl.length < 2048 &&
        callbackUrl.startsWith('https://') &&
        callbackUrl.includes('/seq-eco/')
      ) {
        try {
          const res = await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rid, ciphertext: ciphertextB64u })
          })
          if (res.ok) {
            setCallbackSent(true)
          } else {
            setCallbackFailed(true)
          }
        } catch (e) {
          console.error('callback POST failed', e)
          setCallbackFailed(true)
        }
      }

      if (INDEXER_ACCESS_KEY) {
        setBalances(await fetchBalances(addr))
      }
    } catch (e: any) {
      console.error(e)
      setError(e?.message || String(e))
    }
  }

  const copyCiphertext = async () => {
    if (!ciphertext) return
    await navigator.clipboard.writeText(ciphertext)
  }

  const nativeRows = (balances?.nativeBalances || []).map(b => ({
    key: `native:${b.symbol}`,
    symbol: b.symbol || b.name || 'NATIVE',
    decimals: 18,
    balance: b.balance,
    logoURI: undefined as string | undefined
  }))

  const erc20Rows = (balances?.balances || []).map(b => ({
    key: `erc20:${b.contractAddress}`,
    symbol: b.contractInfo?.symbol || 'ERC20',
    decimals: b.contractInfo?.decimals ?? 0,
    balance: b.balance,
    logoURI: b.contractInfo?.logoURI
  }))

  const allRows = [...nativeRows, ...erc20Rows]

  return (
    <div className='page'>
      <div className='card'>
        <div className='brand'>
          <div className='dot' />
          <div>
            <div className='title'>Ecosystem Wallet Link</div>
            <div className='subtitle'>Polygon · create an explicit session and export to OpenClaw</div>
          </div>
        </div>

        <div className='section'>
          <div className='label'>Wallet</div>
          <div className='text'>{walletUrl}</div>
        </div>

        {!walletAddress && (
          <div className='section'>
            <div className='text'>Click connect, approve the session in the Ecosystem Wallet, then copy the encrypted blob back to the bot.</div>
            <button className='button' onClick={connect}>Connect wallet</button>
            {error && <div className='error'>{error}</div>}
          </div>
        )}

        {walletAddress && (
          <>
            <div className='section'>
              <div className='label'>Wallet address</div>
              <div className='mono'>{walletAddress}</div>

              {INDEXER_ACCESS_KEY && (
                <div className='balances'>
                  {allRows.map(row => (
                    <div className='balanceRow' key={row.key}>
                      <div className='balanceLabel'>
                        {row.logoURI ? (
                          <img src={row.logoURI} alt='' style={{ width: 16, height: 16, borderRadius: 999, marginRight: 8 }} />
                        ) : null}
                        <span>{row.symbol}</span>
                      </div>
                      <div className='balanceValue'>{formatUnits(row.balance, row.decimals)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className='section'>
              <div className='label'>Next step</div>

              {callbackUrl && callbackSent ? (
                <div className='text'>Encrypted session sent to Bloom. Switch back to the bot chat — Bloom will confirm once it has ingested the wallet.</div>
              ) : callbackUrl && callbackFailed ? (
                <div className='text'>Tried to auto-send the encrypted session to Bloom, but the callback failed. Please copy/paste the blob manually below.</div>
              ) : callbackUrl ? (
                <div className='text'>Sending encrypted session to Bloom…</div>
              ) : (
                <div className='text'>Copy the encrypted blob and paste it to the bot.</div>
              )}

              {ciphertext && (!callbackUrl || callbackFailed) && (
                <>
                  <textarea readOnly value={ciphertext} className='textarea' />
                  <button className='button secondary' onClick={copyCiphertext}>Copy encrypted blob</button>
                </>
              )}

              {!ciphertext && <div className='hint'>No ciphertext yet.</div>}

              {error && <div className='error'>{error}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default App
