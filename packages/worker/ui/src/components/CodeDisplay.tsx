import { useState, useEffect, useRef } from 'react'
import { REQUEST_TTL_SECONDS } from '@polygon-agent/shared'
import { pollRelayStatus } from '../lib/relay-api.js'

interface Props {
  code: string
  rid: string
  walletAddress: string
  onComplete: () => void
  onDisconnect: () => void
}

export function CodeDisplay({ code, rid, walletAddress, onComplete, onDisconnect }: Props) {
  const [secondsLeft, setSecondsLeft] = useState(REQUEST_TTL_SECONDS)
  const [retrieved, setRetrieved] = useState(false)
  const pollingRef = useRef(true)

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval)
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // Poll relay status — when CLI retrieves, state is deleted → 404 → success
  useEffect(() => {
    pollingRef.current = true

    const poll = async () => {
      while (pollingRef.current) {
        await new Promise(r => setTimeout(r, 2000))
        if (!pollingRef.current) break
        const status = await pollRelayStatus(rid)
        if (status === 'gone') {
          // State deleted = CLI retrieved successfully (or TTL expired, but
          // if we're well within the window, it's a successful retrieval)
          setRetrieved(true)
          onComplete()
          break
        }
      }
    }

    poll()
    return () => { pollingRef.current = false }
  }, [rid, onComplete])

  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60
  const shortAddr = walletAddress.slice(0, 6) + '...' + walletAddress.slice(-4)

  if (retrieved) {
    return (
      <div>
        <p className="label">Connected</p>
        <div className="mono" style={{ marginBottom: 12 }}>{walletAddress}</div>
        <p className="text">Agent session is active. You can close this tab.</p>
        <button className="button secondary" onClick={onDisconnect}>Disconnect</button>
      </div>
    )
  }

  return (
    <div>
      <p className="label">Wallet</p>
      <div className="mono" style={{ marginBottom: 16 }}>{shortAddr}</div>

      <p className="label">Enter this code in your terminal</p>
      <div className="code-box">{code}</div>
      <p className="countdown">
        {secondsLeft > 0
          ? `Expires in ${minutes}:${seconds.toString().padStart(2, '0')}`
          : ''}
      </p>
      {secondsLeft === 0 && (
        <p className="error">Code expired. Run connect again to start a new session.</p>
      )}

      <div style={{ marginTop: 16 }}>
        <button className="button secondary" onClick={onDisconnect}>Disconnect</button>
      </div>
    </div>
  )
}
