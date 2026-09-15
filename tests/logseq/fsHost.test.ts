import { describe, expect, it } from 'vitest'
import { BridgeUnavailableError, getDotDirRoot, resolveBridge } from '../../src/logseq/fsHost'

describe('resolveBridge / getDotDirRoot (host wiring)', () => {
  it('finds apis.doAction on the host window and calls it with the apis receiver', async () => {
    const seen: unknown[] = []
    const apis = {
      secret: 'kept',
      doAction(this: { secret: string }, args: unknown[]) {
        seen.push(this.secret, args)
        return Promise.resolve('/home/u/.logseq')
      },
    }
    const bridge = resolveBridge({ apis })
    expect(await bridge(['getLogseqDotDirRoot'])).toBe('/home/u/.logseq')
    expect(seen).toEqual(['kept', ['getLogseqDotDirRoot']])
    expect(await getDotDirRoot(bridge)).toBe('/home/u/.logseq')
  })

  it('reports a missing bridge with one actionable error', async () => {
    for (const w of [null, undefined, {}, { apis: null }, { apis: {} }, { apis: { doAction: 'nope' } }]) {
      expect(() => resolveBridge(w)).toThrow(BridgeUnavailableError)
      expect(() => resolveBridge(w)).toThrow(/effect: true/)
    }
    await expect(getDotDirRoot(async () => null)).rejects.toThrow(BridgeUnavailableError)
    await expect(getDotDirRoot(async () => '')).rejects.toThrow(/getLogseqDotDirRoot returned/)
  })
})
