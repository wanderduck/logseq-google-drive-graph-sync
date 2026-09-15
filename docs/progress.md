# PROGRESS LOG
- Live status and session handoff for `docs/implementation-plan.md`.
- Update this at the end of every milestone **and** before any context clear.

## Milestone Status
| Milestone | Status | Notes |
|---|---|---|
| M0 Feasibility spike | ✅ Done 2026-09-15 | **Gate: architecture B confirmed.** Evidence in `docs/spike-results.md` |
| M1 Scaffold | ✅ Done 2026-09-15 | lint, test, build green; unpacked plugin loaded in Logseq 0.10.15 (toolbar icon, panel, close paths confirmed by the user; console `[gdsync] … ready (host 0.10.15)`) |
| M2 UI shell | ✅ Done 2026-09-15 | lint, test (44), build green; all 8 in-Logseq demo checks passed (user-confirmed): 5 toolbar states, panel, conflict dialog, toasts, palette, settings, theme |
| M3 Google auth | ⬜ Not started | Transport decided: iframe `fetch` only (spike §3) |
| M4 Drive layer | ⬜ Not started | |
| M5 Local file layer | ⬜ Not started | M5-C is **not** needed |
| M6 Sync engine core | ⬜ Not started | |
| M7 Manual two-way sync E2E | ⬜ Not started | Must force-save the editor before scan/write (spike §4.2) |
| M8 Snapshots, profile, restore | ⬜ Not started | |
| M9 Personal release | ⬜ Not started | |

## Decision / Deviation Log
- 2026-09-14 — Plan approved (decisions D1–D11, C1, C2 in plan §1).
- 2026-09-14 — Added a root `.gitignore` during M0 (M1 step 3 item, pulled forward so `.env.local` can never be committed).
- 2026-09-15 — **M0 gate: architecture B (host bridge) confirmed.** M5-C dropped.
- 2026-09-15 — M0 finding for plan §3.6 step 7 ("writes to the open page"): the host shows **no prompt**; an external write to the block being edited closes the editor and drops unsaved input. Executor policy: call `Editor.exitEditingMode()` (force-save) before the local scan and before any write, then wait for the flush. Not a deviation, it fills the placeholder the plan left for M0.
- 2026-09-15 — HTTP transport (plan M3 step 4): **iframe `fetch` for every Google endpoint**; `logseq.Request` unused (cannot send multipart/binary, hides status/headers, and needs `window.top` anyway).
- 2026-09-15 — Optional dot-root (`lsp://`) spike variant deferred to the public-release milestone (user decision).
- 2026-09-15 — **Approved plan amendment (§3.6 step 7):** copy the previous local file to `logseq/bak/gdsync/<ts>/` before every download-overwrite, not only before deletes, because Logseq's own `bak/` is only written when content is deleted (spike §4.3).
- 2026-09-15 — M0 cleanup done: `spikes/` deleted, spike FileStorage/settings removed, pristine test-graph tarball + reset script moved to `~/logseq-test-graphs/`. Initial commit on `master` approved by the user.
- 2026-09-15 — **M1 scaffold written** (plan M1 steps 1–5): Vite 8.3 / React 19.3 / TS 6.0.3 project refs / oxlint 1.83 / Vitest 5.0, `@logseq/libs` pinned exactly to `0.0.17`, manifest with top-level `main: dist/index.html`, `effect: true`, `logseq.id = logseq-google-drive-graph-sync`. Hello-world: toolbar cloud button (`src/logseq/toolbar.ts`) toggles a React main-UI panel (`src/ui/App.tsx`) with Escape + click-outside close; M2 step 4 replaces the panel contents.
- 2026-09-15 — M1 choices (no plan deviation): `tests/` is type-checked by `tsconfig.app.json` (`include: ["src","tests"]`, one program, no third tsconfig). `publish.yml` runs on Node 22 with `npm ci` and runs lint + test before the build. `LICENSE` = MIT © 2026 Wanderduck, copied from the sibling plugin because the release zip ships it; **user to confirm the license choice.**
- 2026-09-15 — M1 pulled the §3.1 "host-version check" forward: `src/logseq/hostVersion.ts` (pure, unit-tested) + a warning toast at startup when the host is not 0.10.x. It is the first real unit under test; the sync-time preflight (plan §3.6 step 1) will reuse it.
- 2026-09-15 — SDK facts found from source during M1 (recorded in Ref §5.2 and `CLAUDE.md`): `ui:visible:changed` is emitted **before** `isMainUIVisible` updates (hook reads the payload); the global `logseq` type lacks `.version`.
- 2026-09-15 — `npm audit`: dompurify (critical) + lodash-es (high), all transitive under the pinned SDK 0.0.17; unfixable without breaking D3. Accepted; mention in the README at M9.
- 2026-09-15 — **M2 UI shell written** (plan M2 steps 1–5), all on mock data:
  - Step 1 settings schema `src/logseq/settings.ts`: 10 items under 5 headings (root folder, device name, snapshot interval 24 h, retention 10/3, profile backup on, plugin-settings-in-profile on **with the C1 warning in the description**, sync-on-startup off, client ID/secret override). `resolveSettings()` is pure (defaults, type checks, clamps) and unit-tested; `installSettings()` feeds a `Store<GdsyncSettings>` from `logseq.settings` + `onSettingsChanged`.
  - Step 2 toolbar `src/logseq/toolbar.ts`: one template with `data-state` ∈ idle/syncing/conflict/error/signed-out + badge CSS via `provideStyle` (spinner for syncing). State changes **re-register the item with the same key**: verified in `frontend/handler/plugin.cljs` @0.10.15 (`register-plugin-ui-item` drops the existing entry with that key first). The Ref §5.2 note "don't re-register" was wrong and is corrected.
  - Step 3 `src/logseq/commands.ts`: palette entries "Google Drive Sync: Sync now / Backup now / Open sync panel" (label prefix added for palette discoverability; keys `gdsync-*`; no keybindings).
  - Step 4 `src/ui/StatusPanel.tsx`: account row, running/error/skipped-conflict banners, facts (graph, last sync + summary, last snapshot, profile backup, remote status with Refresh), actions (Sync now, Backup now, Settings → closes the overlay then `showSettingsUI()`), footer. Remote check runs once when the panel opens (D9).
  - Step 5 `src/ui/ConflictDialog.tsx` (per-file keep local / keep remote / keep both / apply to all / skip; Esc = skip the rest, decisions kept) and `src/logseq/toasts.ts` (one sticky progress toast updated in place + summary/error toasts). Verified in `logseq/sdk/ui.cljs` + `handler/notification.cljs` @0.10.15: `timeout: 0` = sticky, same `key` = replace in place, `closeMsg` = `notification/clear!`.
  - New pure layer `src/sync/{store,status,conflict,controller}.ts`: generic observable store, `SyncStatus` + `deriveSyncState()` (precedence signed-out > pending conflict > syncing > error > skipped-conflict > idle), conflict model + `conflictCopyName()` (`name.conflict-<device>-<YYYYMMDD-HHmm>.ext`, device name sanitized to `[A-Za-z0-9_-]`, ≤ 32), and the `SyncController` interface the real engine implements in M7.
  - **Temporary `src/mock/mockSyncController.ts` + `src/ui/DemoControls.tsx`** (not in plan §3.1; M2-only): fake sync/backup/remote-check/connect flows with timers and a "Demo controls" `<details>` in the panel (run clean / with conflicts / failing; force any of the 5 states). Delete both in M7 when the engine lands.
  - Small additions pulled forward: `src/logseq/theme.ts` (panel follows the host's light/dark mode via `getUserConfigs` + `onThemeModeChanged`), `src/logseq/graph.ts` (`status.graph` from `getCurrentGraph` + `onCurrentGraphChanged`), `logseq.beforeunload` → `controller.dispose()`.
- 2026-09-15 — Host facts recorded while wiring M2 (Ref §5.2 updated): a `registerUIItem` toolbar item is wrapped in `div#injected-ui-item-<key>-<pid>` (`components/plugins.cljs` `ui-item-renderer`, the `slot` for `setupInjectedUI`); once the user pins any toolbar item, unpinned items move into the "plugins" dropdown and are rendered with a `pl-` prefix on the key. `provideStyle({key})` is write-once per load (`register-plugin-resources`). The toolbar CSS is therefore static and scoped by our own `gdsync-tb*` classes, with state carried by `data-state` on the re-registered template.

## Session Handoff
- **Last session (2026-09-15, M2):**
  - M1 was committed as `64ec89c` before this session.
  - Files added: `src/sync/{store,status,conflict,controller}.ts`, `src/logseq/{settings,commands,toasts,theme,graph}.ts`, `src/mock/mockSyncController.ts`, `src/ui/{StatusPanel,ConflictDialog,DemoControls}.tsx`, `src/ui/{useStore,useNow,format}.ts`; rewritten: `src/main.tsx`, `src/logseq/toolbar.ts`, `src/ui/App.tsx`, `src/ui/App.css`. Tests: `tests/sync/{store,status,conflict}.test.ts`, `tests/logseq/{settings,toolbar}.test.ts`, `tests/ui/format.test.ts` → 43 tests. Nothing committed yet for M2.
  - Local result: `npm run lint` clean, `npm test` 43/43, `npm run build` green (`dist/assets/index-*.js` 335 kB).
  - **M2 DoD check passed in Logseq (user-confirmed, 2026-09-15):** (1) toolbar cloud shows a grey dot (signed-out) and opens the panel; (2) Connect Google → pill "Up to date", remote check runs; (3) Demo "Show state" buttons flip the toolbar badge (spinner / amber / red / grey); (4) "with conflicts" run opens the conflict dialog automatically, Esc/skip/apply-to-all behave, summary toast reports resolved/skipped; (5) "failing" run shows the error banner + red badge; (6) palette lists the three "Google Drive Sync:" commands; (7) settings gear renders the 5 headings and 10 items; (8) the panel follows Logseq's light/dark toggle.
  - User decision: **keep the "Google Drive Sync:" prefix** on the palette labels.
  - M3 inputs already in place: `settings.googleClientId/Secret` overrides (D5 resolution env → settings is M3 step 1), `controller.connect()/signOut()` are the seams the device-code flow replaces, `status.account` drives the signed-out state.
- **Previous session (2026-09-15, M1):**
  - Files added: `package.json` (+ lockfile), `tsconfig{,.app,.node}.json`, `vite.config.ts` (Vitest config inside), `.oxlintrc.json`, `index.html`, `icon.svg`, `LICENSE`, `.github/workflows/publish.yml`, `src/main.tsx`, `src/vite-env.d.ts` (types `VITE_GOOGLE_CLIENT_ID/SECRET`), `src/logseq/{toolbar,hostVersion}.ts`, `src/ui/{App.tsx,App.css,useMainUiVisible.ts}`, `tests/logseq/hostVersion.test.ts` (6 tests). Nothing committed yet for M1.
  - Local result: `npm run lint` clean, `npm test` 6/6, `npm run build` → `dist/index.html` + `dist/assets/index-*.{js,css}` with relative `./assets/` URLs (same shape as the working sibling plugin's `dist/`).
  - **In-Logseq load check passed (2026-09-15 01:03):** unpacked plugin loaded from the repo root; toolbar icon, panel (plugin id + `0.10.15`), and Escape / click-outside / × close confirmed by the user; console line `[gdsync] logseq-google-drive-graph-sync ready (host 0.10.15)` from `dist/assets/index-*.js`. The stale `spikes/bridge/` entry was removed from the plugin dashboard.
  - Logseq was running during this session as `/opt/logseq-desktop/Logseq --enable-logging` with output tee'd to `/tmp/logseq-console.log` (a per-launch convenience, not durable).
  - `README.md` rewritten to match D9 (manual sync, no "real-time"); the full README with GCP setup, plaintext-token warning, and install steps stays an M9 item.
  - LICENSE (MIT © 2026 Wanderduck) confirmed by the user.
  - SDK audit facts (verified 2026-09-15): `@logseq/libs` 0.0.17 ships a prebuilt `dist/lsplugin.user.js` with **no** `require` of `dompurify` or `lodash-es`; `dompurify` is only imported by `LSPlugin.core.d.ts` (the host-side module that Logseq itself ships); our built `dist/` contains neither `DOMPurify` nor lodash `template` code. The advisories therefore do not reach the shipped plugin. Decision on silencing them via `overrides` is with the user (see the recommendation in the M1 session summary).
  - Test graphs unchanged since M0: `~/logseq-test-graphs/gdsync-dev` (harmless spike leftovers) and empty `gdsync-dev-2`; pristine tarball + reset script in `~/logseq-test-graphs/`.
  - `.env.local` still holds the working TV/limited-input OAuth client; consent screen status to be double-checked as "In production" before M9.
- **Next action:** (1) clear context; (2) M3 Google auth (plan §5 M3; read `docs/spike-results.md` §3–4 first): credential resolution env → settings override, device-code UI replacing the mock `connect()` (show `user_code`, `App.openExternalLink`, poll at `interval`, handle `slow_down` / `access_denied` / `expired_token`), token store in FileStorage (JSON strings; `setItem` is awaitable, `removeItem` is not), refresh/revoke, all over iframe `fetch` with form-urlencoded bodies.
