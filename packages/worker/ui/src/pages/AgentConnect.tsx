export function AgentConnect({ rid }: { rid: string }) {
  return <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
    <h1>Connecting...</h1>
    <p>Request ID: <code>{rid}</code></p>
    <p>Wallet connection flow will be implemented here.</p>
  </div>
}
