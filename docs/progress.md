# PROGRESS LOG
- Live status and session handoff for `docs/implementation-plan.md`.
- Update this at the end of every milestone **and** before any context clear.

## Milestone Status
| Milestone | Status | Notes |
|---|---|---|
| M0 Feasibility spike | ✅ Done 2026-09-15 | **Gate: architecture B confirmed.** Evidence in `docs/spike-results.md` |
| M1 Scaffold | ⏳ Next | |
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

## Session Handoff
- **Last session (2026-09-14/15, M0):**
  - Test graphs: `~/logseq-test-graphs/gdsync-dev` (contains harmless spike leftovers: `EXTERNAL-G*` marker blocks in Alpha/Beta/Project___Notes, `logseq/.recycle/*`, empty `assets/gdsync-spike-tmp/`) and empty `gdsync-dev-2`. Pristine tarball + reset script kept at `~/logseq-test-graphs/` (outside the repo) after cleanup.
  - Spike plugin ran in two variants (`unpacked-noeffect`, `unpacked-effect`, identical results) plus the full Google/Drive suite. Results distilled into `docs/spike-results.md`; the raw JSON and `spikes/` were deleted at the end of M0.
  - `.env.local` holds a working **TV/limited-input** OAuth client for a GCP project with the Drive API enabled; consent screen status to be double-checked as "In production" before M9.
  - Host facts verified from source are folded into `docs/logseq-plugins_creation-reference.md` §11 and `docs/spike-results.md`.
  - No product code yet. Repo has no commits (initial commit proposed at the end of M0).
- **Next action:** M1 Scaffold (plan §5 M1): Vite 8 + React 19 + TS ~6 project refs + oxlint + Vitest, manifest with `effect: true`, `@logseq/libs` pinned to `0.0.17`, hello-world toolbar icon, `publish.yml`. Update `CLAUDE.md` with the real commands.
