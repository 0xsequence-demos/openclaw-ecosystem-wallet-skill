import { AgentConnect } from './pages/AgentConnect.js'

export function App() {
  const params = new URLSearchParams(window.location.search)
  const rid = params.get('rid')

  if (!rid) {
    return <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>Polygon Agent Wallet</h1>
      <p>Missing <code>rid</code> parameter. This page should be opened from the CLI.</p>
    </div>
  }

  return <AgentConnect rid={rid} />
}
