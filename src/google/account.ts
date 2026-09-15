// Who is signed in. The `drive.file` scope carries no identity, and `userinfo` would need extra scopes,
// so the e-mail comes from Drive's `about.get` (works under `drive.file`; spike H3c). M4's Drive client
// reuses this endpoint for the panel's remote check.

import { HttpError } from './errors'
import type { FetchLike } from './http'

export const DRIVE_ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)'

export interface GoogleAccount {
  email: string
}

/** `authorizedFetch` is `GoogleAuth.fetch` (Bearer header + 401 refresh). */
export async function fetchAccount(authorizedFetch: FetchLike): Promise<GoogleAccount> {
  const res = await authorizedFetch(DRIVE_ABOUT_URL, { method: 'GET', headers: { Accept: 'application/json' } })
  if (!res.ok) throw await HttpError.fromResponse(res, DRIVE_ABOUT_URL)
  const json: unknown = await res.json()
  const user = json !== null && typeof json === 'object' ? (json as { user?: { emailAddress?: unknown } }).user : undefined
  const email = user?.emailAddress
  if (typeof email !== 'string' || email === '') throw new Error('Drive about.get returned no user e-mail address.')
  return { email }
}
