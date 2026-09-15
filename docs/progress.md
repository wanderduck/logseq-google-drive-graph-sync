# PROGRESS LOG
- Live status and session handoff for `docs/implementation-plan.md`.
- Update this at the end of every milestone **and** before any context clear.

## Milestone Status
| Milestone | Status | Notes |
|---|---|---|
| M0 Feasibility spike | ✅ Done 2026-09-15 | **Gate: architecture B confirmed.** Evidence in `docs/spike-results.md` |
| M1 Scaffold | ✅ Done 2026-09-15 | lint, test, build green; unpacked plugin loaded in Logseq 0.10.15 (toolbar icon, panel, close paths confirmed by the user; console `[gdsync] … ready (host 0.10.15)`) |
| M2 UI shell | ⬜ Not started | |
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

## Session Handoff
- **Last session (2026-09-15, M1):**
  - Files added: `package.json` (+ lockfile), `tsconfig{,.app,.node}.json`, `vite.config.ts` (Vitest config inside), `.oxlintrc.json`, `index.html`, `icon.svg`, `LICENSE`, `.github/workflows/publish.yml`, `src/main.tsx`, `src/vite-env.d.ts` (types `VITE_GOOGLE_CLIENT_ID/SECRET`), `src/logseq/{toolbar,hostVersion}.ts`, `src/ui/{App.tsx,App.css,useMainUiVisible.ts}`, `tests/logseq/hostVersion.test.ts` (6 tests). Nothing committed yet for M1.
  - Local result: `npm run lint` clean, `npm test` 6/6, `npm run build` → `dist/index.html` + `dist/assets/index-*.{js,css}` with relative `./assets/` URLs (same shape as the working sibling plugin's `dist/`).
  - **In-Logseq load check passed (2026-09-15 01:03):** unpacked plugin loaded from the repo root; toolbar icon, panel (plugin id + `0.10.15`), and Escape / click-outside / × close confirmed by the user; console line `[gdsync] logseq-google-drive-graph-sync ready (host 0.10.15)` from `dist/assets/index-*.js`. The stale `spikes/bridge/` entry was removed from the plugin dashboard.
  - Logseq was running during this session as `/opt/logseq-desktop/Logseq --enable-logging` with output tee'd to `/tmp/logseq-console.log` (a per-launch convenience, not durable).
  - `README.md` rewritten to match D9 (manual sync, no "real-time"); the full README with GCP setup, plaintext-token warning, and install steps stays an M9 item.
  - LICENSE (MIT © 2026 Wanderduck) confirmed by the user.
  - SDK audit facts (verified 2026-09-15): `@logseq/libs` 0.0.17 ships a prebuilt `dist/lsplugin.user.js` with **no** `require` of `dompurify` or `lodash-es`; `dompurify` is only imported by `LSPlugin.core.d.ts` (the host-side module that Logseq itself ships); our built `dist/` contains neither `DOMPurify` nor lodash `template` code. The advisories therefore do not reach the shipped plugin. Decision on silencing them via `overrides` is with the user (see the recommendation in the M1 session summary).
  - Test graphs unchanged since M0: `~/logseq-test-graphs/gdsync-dev` (harmless spike leftovers) and empty `gdsync-dev-2`; pristine tarball + reset script in `~/logseq-test-graphs/`.
  - `.env.local` still holds the working TV/limited-input OAuth client; consent screen status to be double-checked as "In production" before M9.
- **Next action:** (1) commit M1 with user approval; (2) clear context; (3) M2 UI shell (plan §5 M2): settings schema, toolbar Sync-button states, command palette entries, status panel, conflict dialog + sticky toasts, all on mock data.
