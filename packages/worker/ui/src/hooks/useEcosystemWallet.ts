import { useState, useMemo, useEffect, useRef } from 'react'
import { DappClient, TransportMode, WebStorage } from '@0xsequence/dapp-client'
import { Hex, Signature, Secp256k1, Address as OxAddress } from 'ox'
import type { SessionPayload } from '@polygon-agent/shared'
import { walletUrl, dappOrigin, projectAccessKey, relayerUrl, nodesUrl } from '../config.js'

interface UseEcosystemWalletResult {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  walletAddress: string | null
  connect: (chainId: number, nativeLimit?: string) => Promise<void>
  disconnect: () => Promise<void>
  getSessionMaterial: () => Promise<SessionPayload>
  error: string | null
}

export function useEcosystemWallet(): UseEcosystemWalletResult {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Session config stored after connect, needed for SessionPayload
  const sessionConfigRef = useRef<unknown>(null)
  const chainIdRef = useRef<number>(137)

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

  async function connect(chainId: number, nativeLimit?: string) {
    setStatus('connecting')
    setError(null)
    chainIdRef.current = chainId

    try {
      // Native token spend limit (default 2 POL)
      const valueLimit = nativeLimit
        ? BigInt(Math.floor(parseFloat(nativeLimit) * 1e18))
        : 2000000000000000000n

      const sessionConfig: Record<string, unknown> = {
        chainId,
        valueLimit,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24), // 24h
        permissions: [
          // ValueForwarder: used for native token sends
          { target: '0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca', rules: [] },
        ],
      }

      await dappClient.connect(chainId, sessionConfig as any, {
        includeImplicitSession: true,
      })

      const addr = await dappClient.getWalletAddress()
      if (!addr) throw new Error('Wallet address not available after connect')

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
    const addr = walletAddress
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
        implicitSession = {
          pk: implicit.pk,
          attestation: implicit.attestation,
          identity_signature: identitySignature,
          chain_id: implicit.chainId,
          guard: (implicit as any).guard,
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
      project_access_key: projectAccessKey,
      relayer_url: relayerUrl,
      session_config: JSON.stringify(config, bigintReplacer),
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

/** JSON replacer that converts BigInt to string for safe serialization */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
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
