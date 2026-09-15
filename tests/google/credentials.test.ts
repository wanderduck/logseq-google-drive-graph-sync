import { describe, expect, it } from 'vitest'
import { resolveClientCredentials } from '../../src/google/credentials'

const builtIn = { clientId: 'built-in-id.apps.googleusercontent.com', clientSecret: 'built-in-secret' }
const noOverride = { googleClientId: '', googleClientSecret: '' }

describe('resolveClientCredentials (plan M3 step 1, D5)', () => {
  it('uses the built-in client when no override is set', () => {
    expect(resolveClientCredentials(builtIn, noOverride)).toEqual({ ok: true, credentials: builtIn, source: 'built-in' })
  })

  it('prefers a complete settings override, trimmed', () => {
    const r = resolveClientCredentials(builtIn, { googleClientId: '  my-id ', googleClientSecret: ' my-secret ' })
    expect(r).toEqual({ ok: true, credentials: { clientId: 'my-id', clientSecret: 'my-secret' }, source: 'settings' })
  })

  it('rejects a partial override instead of mixing it with the built-in client', () => {
    const idOnly = resolveClientCredentials(builtIn, { googleClientId: 'my-id', googleClientSecret: '' })
    const secretOnly = resolveClientCredentials(builtIn, { googleClientId: '', googleClientSecret: 'my-secret' })
    expect(idOnly.ok).toBe(false)
    expect(secretOnly.ok).toBe(false)
    if (!idOnly.ok) expect(idOnly.reason).toMatch(/both/i)
  })

  it('fails with a settings hint when the build has no client and nothing is overridden', () => {
    const none = resolveClientCredentials({}, noOverride)
    const halfBuilt = resolveClientCredentials({ clientId: 'id-only' }, noOverride)
    expect(none.ok).toBe(false)
    expect(halfBuilt.ok).toBe(false)
    if (!none.ok) expect(none.reason).toMatch(/Settings → Advanced/)
  })
})
