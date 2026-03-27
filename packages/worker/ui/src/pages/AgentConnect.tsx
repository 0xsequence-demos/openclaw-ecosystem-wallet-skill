import { useState, useEffect, useCallback } from 'react'
import { CodeDisplay } from '../components/CodeDisplay.js'
import { useEcosystemWallet } from '../hooks/useEcosystemWallet.js'
import { useSessionEncryption } from '../hooks/useSessionEncryption.js'
import { fetchCliPublicKey } from '../lib/relay-api.js'

type Phase = 'loading' | 'wallet_connect' | 'encrypting' | 'code_display' | 'done' | 'error'

export function AgentConnect({ rid }: { rid: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [cliPk, setCliPk] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const params = new URLSearchParams(window.location.search)
  const chainId = parseInt(params.get('chain') || '137', 10)
  const nativeLimit = params.get('native_limit') || undefined
  const tokenLimits = params.get('token_limits') || undefined

  const wallet = useEcosystemWallet()
  const encryption = useSessionEncryption()

  useEffect(() => {
    fetchCliPublicKey(rid)
      .then(({ cli_pk }) => {
        setCliPk(cli_pk)
        setPhase('wallet_connect')
      })
      .catch((e) => {
        setErrorMsg(e instanceof Error ? e.message : 'Request not found or expired')
        setPhase('error')
      })
  }, [rid])

  async function handleConnect() {
    try {
      await wallet.connect(chainId, nativeLimit, tokenLimits)
      setPhase('encrypting')

      const session = await wallet.getSessionMaterial()
      await encryption.encrypt(rid, session, cliPk!)
      setPhase('code_display')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Connection failed')
      setPhase('error')
    }
  }

  const handleComplete = useCallback(() => {
    setPhase('done')
  }, [])

  async function handleDisconnect() {
    await wallet.disconnect()
    window.location.reload()
  }

  return (
    <div className="page">
      <div className="card">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">Polygon Agent</div>
            <div className="subtitle">Wallet Connection</div>
          </div>
        </div>

        {phase === 'loading' && (
          <div className="section">
            <p className="text"><span className="spinner" />Validating request...</p>
          </div>
        )}

        {phase === 'wallet_connect' && (
          <div className="section">
            <p className="text">
              Connect your Polygon Ecosystem Wallet to authorize an agent session.
              This will open a popup where you can review and approve permissions.
            </p>
            {wallet.status === 'idle' && (
              <button className="button" onClick={handleConnect}>Connect Wallet</button>
            )}
            {wallet.status === 'connecting' && (
              <button className="button" disabled>
                <span className="spinner" />Connecting...
              </button>
            )}
            {wallet.error && (
              <>
                <p className="error">{wallet.error}</p>
                {wallet.error.includes('already exists') && (
                  <button className="button secondary" onClick={async () => {
                    await wallet.disconnect()
                    setErrorMsg(null)
                  }}>Disconnect Previous Session</button>
                )}
              </>
            )}
          </div>
        )}

        {phase === 'encrypting' && (
          <div className="section">
            <p className="text"><span className="spinner" />Securing session...</p>
          </div>
        )}

        {phase === 'code_display' && encryption.code && wallet.walletAddress && (
          <div className="section">
            <CodeDisplay
              code={encryption.code}
              rid={rid}
              walletAddress={wallet.walletAddress}
              onComplete={handleComplete}
              onDisconnect={handleDisconnect}
            />
          </div>
        )}

        {phase === 'done' && wallet.walletAddress && (
          <div className="section">
            <p className="label">Connected</p>
            <div className="mono" style={{ marginBottom: 12 }}>{wallet.walletAddress}</div>
            <p className="text">Agent session is active. You can close this tab.</p>
            <button className="button secondary" onClick={handleDisconnect}>Disconnect</button>
          </div>
        )}

        {phase === 'error' && (
          <div className="section">
            <p className="error">{errorMsg}</p>
            {errorMsg?.includes('already exists') ? (
              <button className="button secondary" onClick={async () => {
                await wallet.disconnect()
                setErrorMsg(null)
                setPhase('wallet_connect')
              }}>Disconnect &amp; Retry</button>
            ) : (
              <button className="button secondary" onClick={() => window.location.reload()}>Try Again</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
