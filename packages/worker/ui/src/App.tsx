import { AgentConnect } from './pages/AgentConnect.js'

export function App() {
  const params = new URLSearchParams(window.location.search)
  const rid = params.get('rid')

  if (!rid) {
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
          <div className="section">
            <p className="text">
              Missing <code className="mono">rid</code> parameter. This page should be opened from the CLI.
            </p>
            <p className="hint">
              Run: <code>polygon-agent connect</code>
            </p>
          </div>
        </div>
      </div>
    )
  }

  return <AgentConnect rid={rid} />
}
