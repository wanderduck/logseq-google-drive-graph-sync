import { useEffect, useState } from 'react'

/** Current time, refreshed every `intervalMs`, so "5 min ago" labels stay honest while the panel is open. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
