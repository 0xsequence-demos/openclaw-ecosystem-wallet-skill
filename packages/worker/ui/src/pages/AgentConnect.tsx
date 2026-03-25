import { useState, useEffect } from 'react'
import { WalletConnect } from '../components/WalletConnect.js'
import { SessionApproval } from '../components/SessionApproval.js'
import { CodeDisplay } from '../components/CodeDisplay.js'
import { useEcosystemWallet } from '../hooks/useEcosystemWallet.js'
import { useSessionEncryption } from '../hooks/useSessionEncryption.js'
import { fetchCliPublicKey } from '../lib/relay-api.js'

type Phase = 'loading' | 'wallet_connect' | 'session_approval' | 'code_display' | 'done' | 'error'

export function AgentConnect({ rid }: { rid: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [cliPk, setCliPk] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

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
      await wallet.connect()
      setPhase('session_approval')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Connection failed')
      setPhase('error')
    }
  }

  async function handleApprove() {
    try {
      const session = await wallet.getSessionMaterial()
      await encryption.encrypt(rid, session, cliPk!)
      setPhase('code_display')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Session approval failed')
      setPhase('error')
    }
  }

  return (
    <div style={{ maxWidth: '480px', margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <h1>Polygon Agent</h1>

      {phase === 'loading' && <p>Validating request...</p>}

      {phase === 'wallet_connect' && (
        <WalletConnect
          onConnect={handleConnect}
          status={wallet.status}
          error={wallet.error}
        />
      )}

      {phase === 'session_approval' && wallet.walletAddress && (
        <SessionApproval
          walletAddress={wallet.walletAddress}
          onApprove={handleApprove}
          status={encryption.status === 'encrypting' ? 'approving' : 'idle'}
          error={encryption.error}
        />
      )}

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
          <button onClick={() => window.location.reload()}>Try Again</button>
        </div>
      )}
    </div>
  )
}
