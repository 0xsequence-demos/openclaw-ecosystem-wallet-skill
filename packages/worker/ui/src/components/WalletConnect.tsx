interface Props {
  onConnect: () => void
  status: 'idle' | 'connecting' | 'connected' | 'error'
  error: string | null
}

export function WalletConnect({ onConnect, status, error }: Props) {
  return (
    <div>
      <h2>Connect Your Wallet</h2>
      {status === 'idle' && (
        <button onClick={onConnect}>Connect Polygon Wallet</button>
      )}
      {status === 'connecting' && <p>Connecting...</p>}
      {status === 'connected' && <p>Wallet connected!</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  )
}
