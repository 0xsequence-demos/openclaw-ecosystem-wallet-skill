import { useState, useMemo, useEffect, useRef } from 'react'
import { DappClient, TransportMode, WebStorage, Utils, Permission, jsonReplacers } from '@0xsequence/dapp-client'
import { Hex, Signature, Secp256k1, Address as OxAddress } from 'ox'
import type { SessionPayload } from '@polygon-agent/shared'
import { walletUrl, dappOrigin, projectAccessKey, relayerUrl, nodesUrl } from '../config.js'
import { resolveErc20Symbol } from '../lib/token-directory.js'

interface UseEcosystemWalletResult {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  walletAddress: string | null
  connect: (chainId: number, nativeLimit?: string, tokenLimits?: string) => Promise<void>
  disconnect: () => Promise<void>
  getSessionMaterial: () => Promise<SessionPayload>
  error: string | null
}

export function useEcosystemWallet(): UseEcosystemWalletResult {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Refs for data that must be readable immediately after connect() returns,
  // without waiting for a React re-render (state updates are async).
  const sessionConfigRef = useRef<unknown>(null)
  const chainIdRef = useRef<number>(137)
  const walletAddressRef = useRef<string | null>(null)

  const dappClient = useMemo(() => {
    return new DappClient(walletUrl, dappOrigin, projectAccessKey, {
      transportMode: TransportMode.POPUP,
      relayerUrl,
      nodesUrl,
      sequenceStorage: new WebStorage(),
    })
  }, [])

  useEffect(() => {
    dappClient.initialize().catch((e: Error) => {
      setError(e.message || 'Failed to initialize wallet SDK')
    })
  }, [dappClient])

  async function connect(chainId: number, nativeLimit?: string, tokenLimits?: string) {
    setStatus('connecting')
    setError(null)
    chainIdRef.current = chainId

    try {
      // Native token spend limit (default 2 POL)
      const valueLimit = nativeLimit
        ? BigInt(Math.floor(parseFloat(nativeLimit) * 1e18))
        : 2000000000000000000n

      // Base permission: ValueForwarder for native token sends
      const permissions: any[] = [
        { target: '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca', rules: [] },
      ]

      // Add ERC20 token permissions from tokenLimits param (e.g., "USDC:50,USDT:50,WETH:0.1")
      if (tokenLimits) {
        const entries = tokenLimits.split(',').map(s => s.trim()).filter(Boolean)
        for (const entry of entries) {
          const [sym, amt] = entry.split(':').map(x => x.trim())
          if (!sym || !amt) throw new Error(`Invalid token limit: "${entry}". Use SYMBOL:AMOUNT format.`)
          const token = await resolveErc20Symbol(chainId, sym)
          if (!token) throw new Error(`Token "${sym}" not found for chain ${chainId}`)
          const tokenValueLimit = BigInt(Math.floor(parseFloat(amt) * 10 ** token.decimals))
          permissions.push(
            Utils.PermissionBuilder.for(token.address as `0x${string}`)
              .forFunction('function transfer(address to, uint256 value)')
              .withUintNParam('value', tokenValueLimit, 256, Permission.ParameterOperation.LESS_THAN_OR_EQUAL, true)
              .build()
          )
        }
      }

      const sessionConfig: Record<string, unknown> = {
        chainId,
        valueLimit,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24), // 24h
        permissions,
      }

      await dappClient.connect(chainId, sessionConfig as any, {
        includeImplicitSession: true,
      })

      const addr = await dappClient.getWalletAddress()
      if (!addr) throw new Error('Wallet address not available after connect')

      walletAddressRef.current = addr
      setWalletAddress(addr)
      sessionConfigRef.current = sessionConfig
      setStatus('connected')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connection failed'
      setError(msg)
      setStatus('error')
      throw e
    }
  }

  async function getSessionMaterial(): Promise<SessionPayload> {
    const addr = walletAddressRef.current
    const chainId = chainIdRef.current
    if (!addr) throw new Error('Wallet not connected')

    // Access internal storage (only way to get session material in current SDK)
    const storage = (dappClient as any).sequenceStorage
    if (!storage) throw new Error('DappClient storage not available')

    // Extract explicit session
    const sessions = await storage.getExplicitSessions()
    const explicit = (sessions || []).find(
      (s: any) =>
        String(s.chainId) === String(chainId) &&
        String(s.walletAddress).toLowerCase() === addr.toLowerCase(),
    )
    if (!explicit?.pk) {
      throw new Error('Could not locate explicit session private key after connect')
    }

    // Derive session address from explicit session private key
    const sessionAddress = OxAddress.fromPublicKey(
      Secp256k1.getPublicKey({ privateKey: Hex.toBytes(explicit.pk) }),
    )

    // Extract implicit session (optional — stored but not used in v1)
    let implicitSession: SessionPayload['implicit_session'] = undefined
    try {
      const implicit = await storage.getImplicitSession()
      if (implicit?.pk && implicit?.attestation && implicit?.identitySignature) {
        const identitySignature = normalizeSignature(implicit.identitySignature)
        // Pre-serialize complex objects with jsonReplacers to preserve
        // Uint8Arrays (attestation) and Sets (guard.moduleAddresses)
        implicitSession = {
          pk: implicit.pk,
          attestation: JSON.stringify(implicit.attestation, jsonReplacers),
          identity_signature: identitySignature,
          chain_id: implicit.chainId,
          guard: (implicit as any).guard ? JSON.stringify((implicit as any).guard, jsonReplacers) : undefined,
          login_method: (implicit as any).loginMethod,
          user_email: (implicit as any).userEmail,
        }
      }
    } catch {
      // Implicit session not available — that's OK
    }

    // Compute expiry from session config deadline
    const config = sessionConfigRef.current as any
    const expiry = config?.deadline
      ? Number(config.deadline)
      : Math.floor(Date.now() / 1000) + 60 * 60 * 24

    return {
      version: 1,
      wallet_address: addr,
      chain_id: chainId,
      session_private_key: explicit.pk,
      session_address: sessionAddress,
      permissions: {
        native_limit: config?.valueLimit ? String(config.valueLimit) : undefined,
      },
      expiry,
      ecosystem_wallet_url: walletUrl,
      dapp_origin: dappOrigin,
      project_access_key: projectAccessKey,
      relayer_url: relayerUrl,
      session_config: safeStringifyConfig(config),
      implicit_session: implicitSession,
    }
  }

  async function disconnect() {
    try {
      await dappClient.disconnect()
      setWalletAddress(null)
      setStatus('idle')
      setError(null)
      sessionConfigRef.current = null
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disconnect failed')
    }
  }

  return { status, walletAddress, connect, disconnect, getSessionMaterial, error }
}

/** Stringify session config preserving BigInt types for jsonRevivers on the CLI side.
 *  Uses dapp-client's jsonReplacers which wraps BigInts in a recoverable format. */
function safeStringifyConfig(config: unknown): string {
  try {
    return JSON.stringify(config, jsonReplacers)
  } catch {
    // Fallback: simple BigInt→string (CLI will get strings instead of BigInts)
    return JSON.stringify(config, (_k, v) => typeof v === 'bigint' ? v.toString() : v)
  }
}

/** Normalize identity signature to hex string.
 *  Handles: string, Uint8Array, {r,s,yParity}, {_isUint8Array,data} */
function normalizeSignature(sig: unknown): string {
  if (typeof sig === 'string') return sig
  if (sig instanceof Uint8Array) return Hex.fromBytes(sig)
  if (sig && typeof sig === 'object') {
    const obj = sig as Record<string, unknown>
    if (typeof obj.data === 'string') return obj.data
    return Signature.toHex(sig as any)
  }
  throw new Error('Unsupported identitySignature type')
}
