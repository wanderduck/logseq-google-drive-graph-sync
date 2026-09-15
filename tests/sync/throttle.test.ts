import { describe, expect, it } from 'vitest'
import { throttleLatest, type ThrottleTimers } from '../../src/sync/throttle'

function fakeTimers() {
  let now = 0
  const timeouts: Array<{ at: number; fn: () => void; id: number }> = []
  let ids = 0
  const timers: ThrottleTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++ids
      timeouts.push({ at: now + ms, fn, id })
      return id
    },
    clearTimeout: (handle) => {
      const i = timeouts.findIndex((t) => t.id === handle)
      if (i !== -1) timeouts.splice(i, 1)
    },
  }
  const advance = (ms: number): void => {
    now += ms
    for (const t of [...timeouts].sort((a, b) => a.at - b.at)) {
      if (t.at > now) break
      timeouts.splice(timeouts.indexOf(t), 1)
      t.fn()
    }
  }
  return { timers, advance, pending: () => timeouts.length }
}

describe('throttleLatest', () => {
  it('delivers the first value at once, coalesces the rest into one trailing call with the latest', () => {
    const t = fakeTimers()
    const seen: number[] = []
    const th = throttleLatest<number>(100, (v) => seen.push(v), t.timers)
    th.push(1)
    th.push(2)
    th.push(3)
    expect(seen).toEqual([1])
    expect(t.pending()).toBe(1)
    t.advance(99)
    expect(seen).toEqual([1])
    t.advance(1)
    expect(seen).toEqual([1, 3])
    expect(t.pending()).toBe(0)
    t.advance(100)
    th.push(4)
    expect(seen).toEqual([1, 3, 4])
  })

  it('flush delivers a pending value now and cancel drops it', () => {
    const t = fakeTimers()
    const seen: string[] = []
    const th = throttleLatest<string>(50, (v) => seen.push(v), t.timers)
    th.push('a')
    th.push('b')
    th.flush()
    expect(seen).toEqual(['a', 'b'])
    expect(t.pending()).toBe(0)
    th.flush() // nothing pending: no-op
    expect(seen).toEqual(['a', 'b'])
    th.push('c')
    th.push('d')
    th.cancel()
    t.advance(100)
    expect(seen).toEqual(['a', 'b'])
    expect(t.pending()).toBe(0)
    th.push('e')
    expect(seen).toEqual(['a', 'b', 'e'])
  })
})
