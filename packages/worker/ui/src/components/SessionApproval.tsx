interface Props {
  walletAddress: string
  onApprove: () => void
  status: 'idle' | 'approving' | 'approved' | 'error'
  error: string | null
}

export function SessionApproval({ walletAddress, onApprove, status, error }: Props) {
  return (
    <div>
      <h2>Approve Agent Session</h2>
      <p>Wallet: <code>{walletAddress}</code></p>
      <p>This will create a scoped session for your agent with limited permissions.</p>
      {status === 'idle' && (
        <button onClick={onApprove}>Approve Session</button>
      )}
      {status === 'approving' && <p>Waiting for approval...</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  )
}
