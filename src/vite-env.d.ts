/// <reference types="vite/client" />

// Build-time Google OAuth client from `.env.local` (plan D5, §3.2). Both are optional so a build
// without `.env.local` still succeeds; the settings override and the auth layer handle the empty case.
interface ViteTypeOptions {
  strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string
  readonly VITE_GOOGLE_CLIENT_SECRET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
