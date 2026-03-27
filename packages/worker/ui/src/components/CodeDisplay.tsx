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
    <div>
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
    </div>
  )
}
