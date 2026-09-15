// Plan M3 step 1 (D5, §3.2): the OAuth client compiled in from `.env.local`, overridable from settings.
// Pure. The host wiring (src/logseq/googleHost.ts) passes the `import.meta.env` values and the resolved
// settings in, so the rule is unit-testable and the rest of src/google/ never reads the environment.

export interface ClientCredentials {
  clientId: string
  clientSecret: string
}

/** `VITE_GOOGLE_CLIENT_ID` / `VITE_GOOGLE_CLIENT_SECRET`; both optional so a build without `.env.local` works. */
export interface BuiltInCredentials {
  clientId?: string
  clientSecret?: string
}

/** The two "Advanced" settings items. */
export interface CredentialOverrides {
  googleClientId: string
  googleClientSecret: string
}

export type CredentialsResolution =
  | { ok: true; credentials: ClientCredentials; source: 'settings' | 'built-in' }
  | { ok: false; reason: string }

/**
 * Settings win when either override is set, and then both must be set: mixing a settings client ID with
 * the built-in secret (or vice versa) can never match, and Google would only report `invalid_client`.
 */
export function resolveClientCredentials(builtIn: BuiltInCredentials, overrides: CredentialOverrides): CredentialsResolution {
  const overrideId = overrides.googleClientId.trim()
  const overrideSecret = overrides.googleClientSecret.trim()
  if (overrideId !== '' || overrideSecret !== '') {
    if (overrideId === '' || overrideSecret === '') {
      return {
        ok: false,
        reason:
          'Set both the Google OAuth client ID and the client secret overrides in the plugin settings (Advanced), ' +
          'or clear both to use the built-in client.',
      }
    }
    return { ok: true, credentials: { clientId: overrideId, clientSecret: overrideSecret }, source: 'settings' }
  }

  const clientId = (builtIn.clientId ?? '').trim()
  const clientSecret = (builtIn.clientSecret ?? '').trim()
  if (clientId === '' || clientSecret === '') {
    return {
      ok: false,
      reason:
        'This build has no Google OAuth client compiled in. Enter a client ID and secret under Settings → Advanced ' +
        '(a "TVs and Limited Input devices" client with the Drive API enabled).',
    }
  }
  return { ok: true, credentials: { clientId, clientSecret }, source: 'built-in' }
}
