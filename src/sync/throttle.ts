// Trailing-edge throttle for progress reporting (M7): the engine emits one event per scanned file and per
// operation, but the status store re-renders the panel and every toast update is a host round trip, so the
// UI sees at most one value per interval, always the latest. Pure TS; timers are injectable for tests.

export interface Throttled<T> {
  /** Delivers `value` now when the interval has passed, otherwise remembers it for the trailing call. */
  push(value: T): void
  /** Delivers the pending value now, if any. */
  flush(): void
  /** Drops the pending value; later `push` calls work again. */
  cancel(): void
}

export interface ThrottleTimers {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultTimers: ThrottleTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export function throttleLatest<T>(intervalMs: number, deliver: (value: T) => void, timers: ThrottleTimers = defaultTimers): Throttled<T> {
  let lastAt = -Infinity
  let pending: { value: T } | null = null
  let timer: unknown = null

  const fire = (value: T): void => {
    lastAt = timers.now()
    deliver(value)
  }

  const flush = (): void => {
    if (timer !== null) {
      timers.clearTimeout(timer)
      timer = null
    }
    if (pending === null) return
    const { value } = pending
    pending = null
    fire(value)
  }

  return {
    push(value) {
      const elapsed = timers.now() - lastAt
      if (pending === null && elapsed >= intervalMs) {
        fire(value)
        return
      }
      pending = { value }
      if (timer === null) {
        timer = timers.setTimeout(() => {
          timer = null
          flush()
        }, Math.max(0, intervalMs - elapsed))
      }
    },
    flush,
    cancel() {
      if (timer !== null) {
        timers.clearTimeout(timer)
        timer = null
      }
      pending = null
    },
  }
}
