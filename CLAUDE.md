# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Logseq desktop plugin that does **manual, two-way sync** of a file-based Logseq graph with Google Drive. It also creates zip snapshots and restores onto a new device. The plan is approved; implementation follows milestones M0–M9. **M0 is done (2026-09-15): architecture B is confirmed. M1 scaffold is done (2026-09-15). M2 UI shell is done (2026-09-15): settings schema, 5-state toolbar button, palette commands, status panel, conflict dialog, sticky toasts, all driven by the mock in `src/mock/`. M3 Google auth is done (2026-09-15): device-code sign-in, token store, refresh, revoke, backoff transport in `src/google/`; lint, 105 tests, build green; the in-Logseq live check passed, including connected state surviving a restart. Next: M4 Drive layer.**

- **Start every session by reading `docs/progress.md`**: current milestone, handoff notes, next action.
- `docs/implementation-plan.md` is the approved plan. It holds decisions D1–D11 and C1–C2, the architecture, the sync algorithm, and each milestone's steps and DoD. Don't re-litigate approved decisions. Deviations need user sign-off and a log entry in `docs/progress.md`.
- `docs/logseq-plugins_creation-reference.md` is the Logseq plugin API reference (verified against Logseq 0.10.15 source). Read the relevant section before touching the Logseq API. It is cited as "Ref §N".
- `docs/spike-results.md` holds the **live-verified** M0 findings: exact bridge semantics, watcher behaviour, Google transport decision, and the design consequences for M3–M8. Read §4 before starting any of those milestones.
## Commands (npm, Node 22)

- `npm run build` — `tsc -b && vite build` → `dist/`. This is what Logseq loads; rebuild before every Reload.
- `npm run build:watch` — `vite build --watch` (no type-check); press Reload on the plugin card after each rebuild.
- `npm run lint` — oxlint (`.oxlintrc.json`: react + typescript + oxc plugins).
- `npm run typecheck` — `tsc -b` only (`tsconfig.app.json` covers `src/` **and** `tests/`).
- `npm test` — Vitest, every `tests/**/*.test.ts`, node environment.
- `npm run test:one -- tests/logseq/hostVersion.test.ts -t "parses"` — one file and/or one test name (verbose reporter).
- `npm run test:watch` — Vitest watch mode.
- `npm run dev` — plain Vite dev server. Logseq does not use it (no `devEntry`); it only helps to eyeball the React UI in a browser.
- **Dev loop in Logseq:** Settings → Advanced → Developer mode → `t p` → *Load unpacked plugin* → select the **repo root** (not `dist/`). After a rebuild, press Reload on the plugin card. To see plugin console output, launch Logseq as `/opt/logseq-desktop/Logseq --enable-logging 2>&1 | tee /tmp/logseq-console.log` and grep for `[gdsync]`.

## Working Rules For This Repo

- **One milestone per session.** At the end of a milestone, update `docs/progress.md` and this file. Then prompt the user to clear context before the next milestone.
- **Never touch the user's real Logseq graph** before M9. Use only `~/logseq-test-graphs/gdsync-dev` and `~/logseq-test-graphs/gdsync-dev-2` (device-2 simulation).
- Commit only when the user asks. `.env.local` holds the Google OAuth client (`VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_CLIENT_SECRET`; it must be a **"TVs and Limited Input devices"** client in a project with the Drive API enabled) and must never be committed.
- `~/logseq-test-graphs/` also keeps `gdsync-dev.tar.gz` + `reset-test-graph.sh` (pristine copy of the test graph; run with Logseq closed).

## Target Environment (hard constraints)

- Logseq desktop **0.10.15** (file-based graphs; installed on this machine as `logseq-desktop-bin`). The host ships `@logseq/libs` **0.0.17**, so pin the SDK to that version. The TypeDoc site and npm `@next` (0.3.x) document methods this host does not implement.
- DB-based graphs (Logseq 2.0 beta) are out of scope.

## Architecture (see plan §3 for detail)

- **B (confirmed by M0):** the plugin runs with `effect: true` and does file I/O through the host's Electron bridge, `window.top.apis.doAction([...])`. That bridge is undocumented and unofficial but fully works on 0.10.15 (see `docs/spike-results.md` §2). The M5-C local-helper fallback is not needed.
- HTTP: one transport, iframe `fetch`, for OAuth and every Drive endpoint. `logseq.Request` is not used.
- Layering is strict:
  - `src/sync/` is pure TypeScript with no `logseq`/Google imports, and is unit-tested with in-memory fakes.
  - `src/fs/` has the `GraphFs` interface with the `HostBridgeFs` or `HelperFs` implementation.
  - `src/google/` has device-code OAuth, the HTTP transport, and the Drive client. It is **host-agnostic** (no `logseq` import): `fetch`, `sleep`, the key-value storage and the credentials resolver are injected by `src/logseq/googleHost.ts`, and tests script `fetch` (`tests/google/helpers.ts`). `GoogleAuth.fetch` is the authorized fetch (Bearer header, one refresh + retry on 401, backoff underneath) that M4's Drive client builds on. Request bodies must be re-sendable (string/URLSearchParams/Blob/ArrayBuffer), because the transport retries.
  - `src/logseq/` and `src/ui/` hold host wiring and the React UI.
  - `src/mock/` (+ `src/ui/DemoControls.tsx`) is the **M2-only** fake engine behind the `SyncController` interface (`src/sync/controller.ts`). Since M3 its `connect`/`cancelConnect`/`signOut` delegate to the real `GoogleAuth` and it mirrors `auth.state` into `status.account`/`status.deviceFlow`; M7 replaces the fake sync flows with the real engine, keeps the auth wiring, and deletes `src/mock/`.
- UI state flows one way: engine → `Store<SyncStatus>` (`src/sync/store.ts`, `status.ts`) → toolbar (`registerToolbar` re-registers the item on state change), panel (`useStore`), toasts. `deriveSyncState()` is the single source of the five toolbar states. Auth has its own `Store<AuthState>` (`signed-out` | `connecting` | `signed-in`) that the controller mirrors; toasts for auth events live in the controller, never in `src/google/`.
- Google session: one JSON string in `logseq.FileStorage` at `auth/google-session.json` (plaintext). The e-mail comes from Drive `about.get` (`drive.file` carries no identity). `TokenStore.clear()` overwrites the file with `null` rather than deleting it.
- All file I/O goes through `GraphFs` so the bridge can be swapped out if a Logseq update breaks it.

## Non-Obvious Gotchas (verified; details in the reference doc)

- `logseq.Request` bypasses CORS but **JSON-stringifies every request body** on host 0.10.15. It cannot send binary, multipart, or form-urlencoded bodies, so Drive uploads must use iframe `fetch` (Ref §6.7). Plain `fetch` to Google works from the plugin iframe (CORS ok, resumable `Location` header exposed).
- Bridge (`doAction`) failures **resolve with a host-realm `Error` object** instead of rejecting; `Date`s in `stat` results are host-realm too. `instanceof` fails across realms, use `Object.prototype.toString.call(v)` / `getTime()`.
- Bridge `readFile` returns UTF-8 text only; read bytes with `fetch('file://' + encodeURI(path))`. `unlink` moves graph files into `logseq/.recycle/`; use `rename` for our own `logseq/bak/gdsync/` moves. There is no directory delete.
- An external write to the file of the block **being edited** closes the editor and silently drops unsaved input, with no host prompt. Force-save with `logseq.Editor.exitEditingMode()` before scanning or writing.
- `logseq.FileStorage.removeItem`/`clear` are fire-and-forget in the SDK; only `setItem`/`getItem`/`hasItem`/`allKeys` are true round-trips. **`getItem` of a missing key rejects** ("file not existed"); call `hasItem` first (Ref §6.6).
- Google OAuth answers use two error dialects (`{error, error_description}` for OAuth, `{error:{code,message,errors[{reason}]}}` for Drive); `parseGoogleError` in `src/google/errors.ts` reads both and `describeGoogleError` is the only place that turns them into user-facing text. A 403 is retried only for the Drive rate-limit reasons, so the OAuth 403s `slow_down`/`access_denied` reach the poll loop.
- `logseq.updateSettings()` does not update `logseq.settings` synchronously. Read fresh values in `onSettingsChanged` (Ref §5.1).
- Settings (`~/.logseq/settings/<id>.json`) and `logseq.FileStorage` are plaintext on disk, and FileStorage values are strings only (Ref §5.1, §6.6).
- `DB.datascriptQuery` errors can resolve with a `"#lspmsg#error#"` key instead of rejecting (Ref §6.2).
- The plugin main UI is a full overlay; Escape and click-outside closing must be implemented by the plugin (Ref §5.2).
- `showMainUI`/`hideMainUI` emit `ui:visible:changed` **before** they update the state behind `logseq.isMainUIVisible`, so the getter is stale inside the listener. `src/ui/useMainUiVisible.ts` reads `visible` from the event payload instead (Ref §5.2).
- The global `logseq` is typed as the `ILSPluginUser` interface, which lacks the `version` getter of the `LSPluginUser` class. `logseq.version` does not compile; the SDK version is the pinned 0.0.17 anyway.
- `npm audit` reports dompurify (critical) and lodash-es (high) advisories, all transitive under the pinned `@logseq/libs` 0.0.17. They cannot be fixed without breaking the pin (D3); accepted, revisit at M9.
- Settings schema `type: 'button'` does not exist on 0.10.15 (the item is silently not rendered).
- A toolbar item **can** be updated by calling `registerUIItem` again with the same `key` (host `register-plugin-ui-item` replaces the entry; verified in 0.10.15 source). Its wrapper is `div#injected-ui-item-<key>-<pid>`, and it moves into the toolbar "plugins" dropdown (key prefixed `pl-`) once the user has pinned items, so scope injected CSS by your own class names, never by the container.
- Toasts: `UI.showMsg(text, status, { key, timeout: 0 })` is sticky, a second call with the same `key` replaces the toast in place, and `UI.closeMsg(key)` removes it (verified in `logseq/sdk/ui.cljs` + `handler/notification.cljs`). Re-showing with a non-zero timeout schedules an extra auto-clear each time.
- `provideStyle({ key, style })` registers a style only if that key is not already registered (`register-plugin-resources`), so a keyed style cannot be replaced; encode state in the DOM (`data-state`) instead.
- Google OAuth: device-code flow with scope `drive.file` (non-sensitive). The GCP consent screen must be **"In production"**; in "Testing" status, refresh tokens expire after 7 days.

## Stack Convention

Match `../logseq-gemini-predictive-text-plugin`: Vite 8, `@vitejs/plugin-react`, React 19, TypeScript ~6 (project refs), npm, oxlint, `base: './'`, and a tag-triggered `publish.yml` release zip. The one addition is **Vitest**.
