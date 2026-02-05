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

  const [error, setError] = useState<string>('')
  const [walletAddress, setWalletAddress] = useState<string>('')
  const [ciphertext, setCiphertext] = useState<string>('')
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
    setError('')
    setCiphertext('')

    if (!rid || !walletName || !pub) {
      setError('Invalid link. Missing rid/wallet/pub.')
      return
    }

    try {
      const VALUE_FORWARDER = '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca'

      // Base explicit session permission: allow calling the Sequence ValueForwarder.
      // NOTE: This mirrors wallet-dapp-client-cli (it uses { target: VALUE_FORWARDER, rules: [] }).
      // We tried function-scoped permissions, but dapp-client signer selection rejected calls.
      const basePermissions: any[] = [{ target: VALUE_FORWARDER, rules: [] }]

      const paymentAddress = (feeTokens as any)?.paymentAddress
      const tokens = (feeTokens as any)?.tokens || []

      // If the relayer requires a fee, allow the wallet to pay the relayer paymentAddress directly in native POL.
      // Without this, dapp-client may try to route fee payment through ValueForwarder using a different selector,
      // which can revert during relayer simulation.
      const nativeFeePermission: any[] =
        (feeTokens as any)?.isFeeRequired && paymentAddress ? [{ target: paymentAddress, rules: [] }] : []

      const feePermissions: any[] =
        (feeTokens as any)?.isFeeRequired && paymentAddress && Array.isArray(tokens)
          ? tokens.map((token: any) => {
              const decimals = typeof token.decimals === 'number' ? token.decimals : 6
              const valueLimit = decimals === 18 ? 100000000000000000n : 50n * 10n ** BigInt(decimals)

              // ERC20 transfer(to,paymentAddress,value<=limit)
              return Utils.PermissionBuilder.for(token.contractAddress)
                .forFunction('function transfer(address to, uint256 value)')
                .withUintNParam('value', valueLimit, 256, Permission.ParameterOperation.LESS_THAN_OR_EQUAL, true)
                .withAddressParam('to', paymentAddress, Permission.ParameterOperation.EQUAL, false)
                .build()
            })
          : []

      const sessionConfig = {
        chainId: polygonChainId,
        // Demo default: allow up to 2 POL of native spend (can be tuned)
        valueLimit: 2000000000000000000n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24),
        permissions: [...basePermissions, ...nativeFeePermission, ...feePermissions]
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
      setCiphertext(b64urlEncode(sealed))

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
              <div className='text'>Copy the encrypted blob and paste it to the bot.</div>

              {ciphertext && (
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
