import { useState, useEffect } from 'react'
import { REQUEST_TTL_SECONDS } from '@polygon-agent/shared'

interface Props {
  code: string
}

export function CodeDisplay({ code }: Props) {
  const [secondsLeft, setSecondsLeft] = useState(REQUEST_TTL_SECONDS)

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

  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60

  return (
    <div style={{ textAlign: 'center' }}>
      <h2>Session Approved</h2>
      <p>Enter this code in your terminal:</p>
      <div style={{
        fontSize: '3rem',
        fontFamily: 'monospace',
        letterSpacing: '0.5em',
        padding: '1rem',
        margin: '1rem 0',
        background: '#f0f0f0',
        borderRadius: '8px',
      }}>
        {code}
      </div>
      <p>Expires in {minutes}:{seconds.toString().padStart(2, '0')}</p>
      {secondsLeft === 0 && <p style={{ color: 'red' }}>Code expired. Please try again.</p>}
    </div>
  )
}
