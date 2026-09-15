import { describe, expect, it } from 'vitest'
import { mapLimit } from '../../src/fs/limit'

describe('mapLimit', () => {
  it('preserves order and never runs more than `limit` at once', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3, 6, 0], 3, async (n, i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, n))
      inFlight--
      return `${i}:${n}`
    })
    expect(out).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:6', '6:0'])
    expect(peak).toBe(3)
  })

  it('handles empty input and rejects a bad limit', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
    await expect(mapLimit([1], 0, async () => 1)).rejects.toThrow(RangeError)
  })

  it('stops starting new items after a failure, waits for in-flight ones, and rethrows the first error', async () => {
    const started: number[] = []
    const finished: number[] = []
    await expect(
      mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
        started.push(n)
        await new Promise((r) => setTimeout(r, n === 1 ? 5 : 1))
        finished.push(n)
        if (n === 2) throw new Error('two failed')
        if (n === 1) throw new Error('one failed later')
        return n
      }),
    ).rejects.toThrow('two failed')
    expect(started).toEqual([1, 2])
    expect(finished).toEqual([2, 1])
  })
})
