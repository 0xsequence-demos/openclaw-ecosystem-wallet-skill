import { useState, useEffect } from 'react'
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

  // Single action: connect wallet + approve session + encrypt + post to relay
  async function handleConnect() {
    try {
      // dappClient.connect() handles both wallet connection AND session approval in the popup
      await wallet.connect(chainId, nativeLimit)
      setPhase('encrypting')

      // Extract session material and encrypt + post to relay in one step
      const session = await wallet.getSessionMaterial()
      await encryption.encrypt(rid, session, cliPk!)
      setPhase('code_display')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Connection failed')
      setPhase('error')
    }
  }

  return (
    <div style={{ maxWidth: '480px', margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <h1>Polygon Agent</h1>

      {phase === 'loading' && <p>Validating request...</p>}

      {phase === 'wallet_connect' && (
        <div>
          <h2>Connect Your Wallet</h2>
          <p>This will open your Polygon Ecosystem Wallet to approve an agent session.</p>
          {wallet.status === 'idle' && (
            <button onClick={handleConnect}>Connect Wallet</button>
          )}
          {wallet.status === 'connecting' && <p>Connecting... (check your wallet popup)</p>}
          {wallet.error && (
            <div>
              <p style={{ color: 'red' }}>{wallet.error}</p>
              {wallet.error.includes('already exists') && (
                <button onClick={async () => {
                  await wallet.disconnect()
                  setErrorMsg(null)
                }}>Disconnect Previous Session</button>
              )}
            </div>
          )}
        </div>
      )}

      {phase === 'encrypting' && <p>Securing session...</p>}

      {phase === 'code_display' && encryption.code && (
        <CodeDisplay code={encryption.code} />
      )}

      {phase === 'done' && (
        <div>
          <h2>Connected!</h2>
          <p>Your agent is now connected. You can close this tab.</p>
        </div>
      )}

      {phase === 'error' && (
        <div>
          <h2>Error</h2>
          <p style={{ color: 'red' }}>{errorMsg}</p>
          {errorMsg?.includes('already exists') ? (
            <button onClick={async () => {
              await wallet.disconnect()
              setErrorMsg(null)
              setPhase('wallet_connect')
            }}>Disconnect &amp; Retry</button>
          ) : (
            <button onClick={() => window.location.reload()}>Try Again</button>
          )}
        </div>
      )}
    </div>
  )
}
