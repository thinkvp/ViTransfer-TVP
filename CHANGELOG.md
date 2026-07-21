# Changelog

All notable changes to ViTransfer-TVP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.7] - 2026-07-21

### Added

- **Create a client inline from the Create quote / Create invoice pages** — the Client field on both sales creation pages now has a **+** button at the right end of the input that opens the "Add New Client" form (the same fields as `/admin/clients/new`, including Client Contacts) in a modal. Creating the client closes the modal, adds it to the client list (alphabetically), and selects it in the Client field — no more leaving a half-drafted quote/invoice to add a client first. The standalone new-client page and the modal now share one extracted form component (`ClientCreateForm`), so the two can't drift. Touches `src/components/admin/clients/ClientCreateForm.tsx` (new), `src/components/admin/clients/ClientCreateModal.tsx` (new), `src/app/admin/clients/new/page.tsx`, `src/app/admin/sales/quotes/new/page.tsx`, `src/app/admin/sales/invoices/new/page.tsx`. No schema migration.

### Changed

- **Share page: approval / next-version banners and the empty comment state polished** — the "Video Approved", "Project Approved", and "Next version requested / available" banners in the comment panel now carry a bottom border (`border-b border-border`) matching the top edge, so each banner is framed consistently instead of dissolving into the content below. The empty comment state on an unapproved video now reads "Leave feedback here — comments are time-stamped to the video." (was "Have some feedback? Leave it here."), signalling to first-time clients that feedback is anchored to the current playhead. Touches `src/components/CommentSection.tsx`. No schema migration.

- **Project page video rows reflow on mobile** — on narrow screens the per-version row in the project page's video list now wraps the action-icon cluster (approve / mark-reviewed / upload / delete) onto its own second line while the version label and expand chevron stay on the first, instead of crowding everything onto one line; `sm+` layouts are unchanged (single line). Touches `src/components/VideoList.tsx`. No schema migration.

### Fixed

- **Share page: "Reviewed" state changes now appear live without a refresh** — an admin toggling "Mark as Reviewed" on the project page (or a client requesting the next version in another session) published the SSE event and the share page refetched project data, but the refetched `revisionRequestedAt` never reached the comment panel: `fetchTokensForVideos` returned the cached tokenized video copy wholesale, and that cache is only invalidated when a video's `approved` flag flips — which a Reviewed toggle doesn't touch. The "Next version requested" banner (and the sidebar's Reviewed tick under the loadTokens re-cache race) therefore stayed stale until a manual refresh. Cached/in-flight tokenized copies now get the fresh `revisionRequestedAt` overlaid (same pattern the `allVideosByName` rebuild already used), and the `sidebarVideosByName` approval-field overlay carries `revisionRequestedAt` too. Also, the client "Request Next Version" route now publishes a `comment` event alongside `approval` so *other* open share pages refetch comments and see the just-applied comment locks (the lock was already enforced server-side — this was display-only staleness). Verified live: client share session open, server-side Reviewed toggle + SSE publish → banner and sidebar regrouping appeared/cleared in both directions without reload. Touches `src/app/share/[token]/page.tsx`, `src/app/api/projects/[id]/request-next-version/route.ts`. No schema migration.

## [2.3.6] - 2026-07-20

### Changed

- **Share-page welcome prompt registers typed names as project recipients; comment box drops its Name row** — the "Welcome — who are you?" first-visit prompt previously stored a typed name only in the browser session, unlike the comment box's "Choose your name" dialog which creates a real name-only `ProjectRecipient`. The welcome prompt now uses the same `/api/share/[token]/recipients` endpoint: a typed name is added to the project (visible to admins and listed for other clients), a typed name matching an existing recipient (case-insensitive) reuses that recipient instead of erroring, and on API failure the client still enters the page with a name-only identity (attribution falls back as before). The prompt's input now matches the endpoint's 30-character limit and guards against double-submits. Since every share visitor is therefore guaranteed an identity up front, the "Name:" label + picker row above the comment box no longer renders — freeing vertical space — except as a fallback when no name is set (e.g. cleared sessionStorage), where the picker reappears so the user isn't dead-ended. Touches `src/app/share/[token]/page.tsx`, `src/components/CommentInput.tsx`. No schema migration.

### Fixed

- **AI Assistant Expense mode: model could reject the correct account over its taxCode, leaving receipts unmapped** — small models read the `taxCode` column in the `<chart_of_accounts>` prompt listing as a matching constraint (e.g. a BP fuel docket with GST printed: the model found the fuel account, decided its listed taxCode conflicted with its GST reasoning, went hunting for a "matching" GST_FREE account, and returned `accountId: null`). Two-part fix: (1) the expense system prompt now states the account taxCode column is only that account's default GST setting, never a selection constraint — accounts are chosen purely by what was purchased; (2) a **deterministic fallback** in the worker: whenever the model declines to pick an account, the extracted supplier + description text is scored against recent categorisation history (past expenses + matched bank transactions) using the same token scorer as the Bank Accounts suggest-account endpoint (`suggestAccountFromHistory`/`loadAccountHistory` in `src/lib/accounting/description-match.ts`), and the top-scoring active EXPENSE/COGS account is pre-filled with a "suggested from your purchase history — double-check" note. Fills gaps only — a model-picked account is never overridden. Touches `src/lib/ai/prompts.ts`, `src/lib/accounting/description-match.ts`, `src/worker/ai-assistant-processor.ts`. No schema migration.

## [2.3.5] - 2026-07-17

### Added

- **Clients can "Request Next Version" on the share page** — until now a client's only terminal action on a video was Approve; there was no way to say "my feedback is complete — please cut the next version". A new **Request Next Version** button sits next to Approve Video in the comment panel (client share pages only; appears once the client has left at least one comment on that version, with a "All feedback submitted?" hint line beneath the button row). Confirming: (1) **locks the feedback on that version** — every client-visible comment on it gets `Comment.lockedAt`; locked comments can no longer be deleted or edited from share sessions even with "clients can delete comments" enabled (enforced server-side in `/api/comments/[id]`, hidden delete control + small lock icon in the UI) — while *new* comments remain allowed (and deletable) so follow-up questions still flow; (2) moves the video into a new share-page **"Reviewed"** state (one-shot per version; unrelated to the Reviewed *project* status) with its own sidebar section, Files-browser section/badges ("REVIEWED" instead of "LATEST"), and an in-panel banner ("Next version requested — …"), all updating live over the existing project SSE channel; (3) **notifies assigned internal users** through the existing Video Approval toggles/permissions (notification bell + web push always; admin email when SMTP is configured, via a new "Next Version Requested" template also included in `preview:emails`) — no new settings; (4) records a "*name* requested the next version of *video*" event in Project Activity (all audiences, guests see generic names). Uploading the next version naturally returns the group to "For Review" (new version = new row), the old version keeps the request as history, and approving a Reviewed version still works and wins. Admins can manually set/clear the Reviewed state per video from the project page's video list (new file-clock toggle + "Reviewed" pill; requires Projects Full Control; does not lock comments). API: `POST /api/projects/[id]/request-next-version` (dual share/admin auth, guests rejected, idempotent). Touches `prisma/schema.prisma` (+migration `20260719000000_request_next_version`: `Video.revisionRequested*` attribution columns, `Comment.lockedAt`), `src/app/api/projects/[id]/request-next-version/route.ts` (new), `src/app/api/comments/[id]/route.ts`, `src/app/api/videos/[id]/route.ts`, `src/app/api/share/[token]/downloadable-files/route.ts`, `src/lib/comment-sanitization.ts`, `src/lib/notifications.ts`, `src/lib/email.ts`, `src/lib/project-activity.ts`, `src/lib/downloadable-files.ts`, `src/components/CommentSection.tsx`, `src/components/MessageBubble.tsx`, `src/components/VideoSidebar.tsx`, `src/components/ShareFilesBrowser.tsx`, `src/components/ProjectActivityPanel.tsx`, `src/components/VideoList.tsx`, `src/app/share/[token]/page.tsx`, `src/types/video.ts`, `scripts/render-email-previews.ts`.

- **Sales & accounting dashboards can compare against the previous financial year** — the "how am I doing vs last year" question had no answer on either dashboard: every chart could show *either* this FY or last FY, never both, and the KPI tiles had no reference point. Now: (1) the sales dashboard's **Sales FY** tile and the accounting dashboard's **Income** and **Net Profit** tiles show a ▲/▼ delta against the *same elapsed point* of the previous FY (1 Jul → this date last year, so mid-year deltas compare like-for-like; percentage when the prior figure is positive, absolute movement otherwise — e.g. against a prior-year net loss; hidden when there's no prior-FY data); (2) the **Sales Overview** chart gains a "vs last FY" checkbox that overlays the prior year as a dashed grey line aligned by fiscal month (Jul '25 over Jul '24), with the prior-period total and % change in the header — the comparison window follows whatever period is selected, so "Last 3 months" compares against the same 3 months a year earlier; (3) the accounting **Profitability Trend** chart gains the same checkbox, ghosting each visible series (Income/Total Costs/COGS/Net Profit) as a faded dashed line of the same colour for the prior year, following the existing per-series legend toggles. Both KPI deltas and overlays respect the configured Cash/Accrual reporting basis and fiscal-year start month (prior-year data flows through the same rollup/P&L endpoints as the current year). Touches `src/app/admin/sales/page.tsx`, `src/components/sales/SalesDashboardCharts.tsx`, `src/app/admin/accounting/page.tsx`, `src/components/admin/accounting/AccountingDashboardCharts.tsx`. No schema migration.

- **Manual "Delete Video Previews" action on closed projects** — the global "Auto-delete video previews when project is closed" setting was all-or-nothing: with it disabled there was no way to free preview storage for an individual project. The project page's action buttons now include **Delete Video Previews** (directly under Reprocess Previews), shown only when the project is Closed and the user can change project statuses (mirroring the API gate). It sheds exactly what the auto-delete-on-close path sheds — HLS bundles, legacy MP4 previews, and video-asset playback MP4s — while keeping originals, thumbnails, timeline previews, and still images, then refreshes the project's precomputed storage totals. A confirm dialog explains the scope; the success toast reports what was deleted and that reopening regenerates playback (verified live: closed project with 9 HLS bundles → all bundles deleted, `hlsReady` cleared, reopen re-queued 8 video + 1 asset regeneration jobs which the worker processed). API: `POST /api/projects/[id]/delete-previews` accepts `{ scope: 'all' }` alongside the existing `{ resolutions }` body, returning 409 unless the project is CLOSED. Touches `src/components/ProjectActions.tsx`, `src/app/api/projects/[id]/delete-previews/route.ts`, `src/lib/delete-project-previews.ts` (new shared helper). No schema migration.

### Fixed

- **Closing a project manually now sheds previews identically to the auto-close worker** — the two close paths had drifted. The manual-close path (`PATCH /api/projects/[id]` → CLOSED with the auto-delete setting on) never cleared `hlsReady` on videos/assets whose HLS bundle it deleted, so reopening the project skipped the HLS rebuild (broken playback until the daily reconcile sweep); it also dropped `StoredFile` rows even when the physical delete failed (orphaning files with no retry), and only deleted HLS directories that had registry rows instead of using the deterministic path builders. The worker's correct implementation is now extracted into a shared `deleteProjectPreviews()` helper (`src/lib/delete-project-previews.ts`) used by the manual close path, the auto-close worker, and the new manual delete action, so the semantics can't drift again. Touches `src/app/api/projects/[id]/route.ts`, `src/worker/auto-close-projects.ts`. No schema migration.

### Changed

- **Timeline range comments highlight on avatar hover; comment list tracks the playhead** — two interactivity additions to the video review view (client share pages + admin share preview). (1) Hovering a comment's avatar dot on the timeline now emphasises that comment's range span (taller, brighter) while muting the other range spans to 25% opacity, so overlapping ranges are easy to tell apart; leaving the avatar restores them. (2) Comments in the comment panel now highlight with a primary-coloured ring while the video playhead sits inside their range (or within ±0.5s of a point comment's timecode), driven by the player's existing throttled `videoTimeUpdated` events — so during playback the comment under discussion lights up as the video reaches it, and overlapping ranges highlight together. Touches `src/components/VideoPlayer.tsx`, `src/components/CommentSection.tsx`, `src/components/MessageBubble.tsx`. No schema migration.

- **Share-page comment panel polish** — the empty-comments state ("Have some feedback? Leave it here.") showed a blank grey circle above the text; it now holds a comment-bubble icon, matching the lock-icon treatment the panel already uses when comments are closed. The comment sort dropdown (Timecode / Newest) is replaced by a compact icon-only toggle button — one click flips between timecode order (clock icon) and newest-first (history icon), with a tooltip/accessible label stating the current mode and what a click switches to. Applies wherever the shared comment panel renders (client share pages and the admin share preview). Touches `src/components/CommentSection.tsx` only. No schema migration.

## [2.3.4] - 2026-07-16

### Added

- **Subtitle editor shows who last edited the captions; edits appear in Project Activity** — saving in the "Edit subtitles" panel now records the editor (admin user, or the client recipient picked in the share page's name picker — same identity slot comments/approvals use) on new `Video.subtitlesEdited*` columns. The panel header then drops "(auto-generated)" and shows "Last edited by *name* *date/time*" (timezone-aware `formatDateTime` formatting); regenerating from audio — or replacing the captions wholesale via SRT upload / copy-from-version — clears the attribution and restores the "(auto-generated)" label. The latest edit per video also surfaces as a `SUBTITLES_EDITED` event ("*name* edited subtitles on *video*", captions icon) in the Project Activity feed on the share page and admin dashboards, following the feed's audience rules (guests see generic Admin/Client, never names) and refreshing live via the existing project SSE channel. Verified end-to-end against a dev server (client save → header attribution + activity event; unvalidated recipient ids are not stored). Touches `prisma/schema.prisma` (+migration `20260716000000_subtitle_edit_attribution`), `src/lib/subtitle-store.ts`, `src/app/api/videos/[id]/subtitles/route.ts`, `src/lib/project-activity.ts`, `src/components/ProjectActivityPanel.tsx`, `src/components/subtitle-editor/SubtitleEditPanel.tsx`, `src/hooks/useSubtitleEditor.ts`, `src/worker/transcription-processor.ts`, both share pages.

- **Guest video links warn when the linked video is not the latest version** — a guest-video link pins a specific version, so a guest could unknowingly watch (and share around) an outdated cut after a newer version was uploaded. The `/gv/` viewer now shows an amber banner under the title/expiry header — "Note: This is not the most recent version of this video." — styled like the share page's folder banners but on the warning colour. The resolve endpoint compares the linked video's version against READY videos of the same name in the project and returns `isLatestVersion`; versions still processing don't count as newer until they finish. Touches `src/app/api/guest-video-links/[token]/route.ts`, `src/app/gv/[token]/GuestVideoViewer.tsx`. No schema migration.

### Fixed

- **Auto-generated subtitles no longer strand a single word as its own cue** — two causes, both fixed at generation time in `src/lib/subtitles.ts`: (1) the caption re-flow (max chars/line × max lines) split overflowing cues into fixed-size groups, so the remainder could be one lone word flashing as its own subtitle — that word now folds back into the previous cue, letting that line exceed the max-chars limit as the lesser evil (a two-word remainder still gets its own cue); (2) Whisper itself sometimes segments a lone word into its own cue — a new `mergeOrphanWordCues` pass joins it to the previous cue when the gap is small (≤1.2s), while a lone word spoken after a real pause keeps its own cue. Applies to newly generated subtitles only; manual edits in the subtitle editor are untouched, as before. Covered by new checks in `scripts/transcription-dry-run.ts`. Touches `src/lib/subtitles.ts`, `src/worker/transcription-processor.ts`. No schema migration.

- **`formatDate`/`formatDateTime` crashed server-side when the `TZ` env variable is unset** — both helpers in `src/lib/utils.ts` read `process.env.TZ!` on the server and then called `timezone.startsWith(...)`, so any server-rendered email containing a date (sales invoice overdue reminder, quote expiry reminder) threw `Cannot read properties of undefined` on hosts without `TZ` set — which is also why `npm run preview:emails` died partway through on local dev (Docker deployments set `TZ`, so production was unaffected). Both helpers now fall back to the system timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone` when `TZ` is unset. `npm run preview:emails` now renders all 19 previews. Touches `src/lib/utils.ts` only. No schema migration.

- **Video card poster now updates live when a custom playback thumbnail is set or removed** — the SSE plumbing already fired on both actions (`set-thumbnail` publishes a `video` project event; the un-set path re-queues a thumbnail-only reprocess whose worker completion publishes the same event) and the admin project page already refetched on it, but the card poster never changed: `AdminVideoManager` caches minted poster-token URLs per video ID, and the refetched payload gave it nothing to detect the swap with (`thumbnailPath` is just a has-thumbnail boolean). The project payload now includes `thumbnailUpdatedAt` (the THUMBNAIL StoredFile row's `updatedAt`) per video, and the poster cache keys on it — when it changes, the token is re-minted and the new poster appears without a reload, both for the acting admin and any other staffer with the page open. Verified live against a dev server: a `video` SSE event with a bumped `thumbnailUpdatedAt` triggers exactly one re-mint for that video; the same event with unchanged timestamps triggers none. Touches `src/app/api/projects/[id]/route.ts`, `src/components/AdminVideoManager.tsx`. No schema migration.

### Changed

- **Share Video modal makes an already-expired link unmissable** — opening the modal for a video whose guest link had lapsed looked identical to a healthy one: the same muted "Expires: …" caption was the only clue. When the loaded (or displayed) link's expiry is in the past, the link card now turns red-tinted, a destructive alert banner ("This link has expired — viewers can no longer open it…") appears above the buttons, the caption flips to a bold red "Expired: …", and the "Refresh Expiry" button is promoted from outline to primary. Refreshing the expiry immediately restores the normal styling. Applies to the shared modal used by the admin share-preview and client share pages. Touches `src/components/CommentSection.tsx` only. No schema migration.

- **Project page videos are always sorted unapproved-first, then alphabetically** — the Videos section on the admin project page had an Alphabetical/Status toggle button (defaulting to purely alphabetical). The toggle is gone: video groups with no approved version now always come first (alphabetically), followed by groups with an approved version (alphabetically) — so work still in review sits at the top. Touches `src/components/AdminVideoManager.tsx` (removed the `sortMode` prop), `src/app/admin/projects/[id]/page.tsx` (removed the toggle button and state). No schema migration.

- **Comment summary emails now quote the original comment above each reply** — in the periodic summary emails, a reply was hard to interpret: the client summary showed only a small grey "Replying to …" line truncated at 60 characters (usually cutting the parent mid-sentence), and the internal multi-project digest showed no reply context at all — even though the notification queue has always stored the parent comment's author, content, and timecode alongside every queued reply. Both templates now render a quoted block above the reply body: a light-grey panel with a left border containing "In reply to *Author* • timecode" and the parent comment's text (capped at 280 characters on a word boundary so a long original can't dominate the digest; parent timecode respects the project's full/short timecode setting and is omitted for non-timestamped comments; deleted parents render no quote, as before). Template-only change, so it applies everywhere these emails are generated: scheduled client summaries, the manual "Comment Summary" send, and the scheduled internal digest. `npm run preview:emails` now includes reply examples in both summary previews. Touches `src/lib/email-templates.ts`, `scripts/render-email-previews.ts`. No schema migration.

### Removed

- **Leftover QuickBooks `QBO_*` environment variables dropped from the compose files** — the pull-only QuickBooks integration was removed in 2.0.3, but `docker-compose.yml` and `docker-compose.build.yml` still declared and passed seven inert `QBO_*` variables to both containers. Nothing in the codebase reads them, so they're gone; existing `.env` files that still define them are simply ignored. Also refreshed README/INSTALLATION docs (feature list brought up to 2.3.x: accounting, AI Assistant, Whisper subtitles, live SSE updates, kanban, Gantt, share-page uploads; PostgreSQL 18/Prisma 7 corrections; S3 + worker-tuning env vars documented; clone-directory fix). No schema migration.

## [2.3.3] - 2026-07-15

### Added

- **"Replying to …" header now shows the parent comment's time pill** — when replying to a comment on the share page (client or admin view), the indicator above the input box shows the parent comment's timecode/time — including ranges (`0:30 – 0:45`) — in the same amber pill style as the comment bubbles, to the right of the author's name. Respects the shared Duration/Timecode display-mode toggle (frames shown in timecode mode). On narrow layouts the pill wraps below the name instead of truncating it. Touches `src/components/CommentInput.tsx` only (both share pages use this component). No schema migration.

### Fixed

- **Comment attachment tiles: long filenames no longer overflow the tile** — attachment download buttons in comment bubbles were centered `inline-flex` buttons with the name and size run together as one line of text, so a long unbroken filename (e.g. `13Feb26_MobileAdjustingClarityBoost_289_RGB.jpg`) got clipped at the tile edge and the wrapped text sat centered. Tiles are now left-aligned with the download icon pinned to the first line, the filename free to wrap (`break-all`, always fully visible), and the file size on its own muted line underneath. Applies to both top-level comment and reply attachments on the share pages. Touches `src/components/FileDisplay.tsx` (`CommentFileDisplay`) only. No schema migration.

- **Comment attachments now appear live on other open share pages / admin dashboards (no refresh needed)** — posting a comment publishes the `comment` SSE event immediately, but attachments upload *after* the comment is created (`POST /api/comments/[id]/files` locally, or the S3 presign→complete flow), and neither upload-completion endpoint published an event. So every other open page refetched on the comment event, got the comment *without* its files, and never heard about the attachment — it only showed up after a manual refresh (the submitting page was unaffected because it refetches locally after its uploads finish). Both attachment-completion endpoints (and the bulk attachment-delete) now publish a `comment` project event once the file is registered; the share page's existing 200ms per-type debounce coalesces multi-file uploads into a single refetch. Verified end-to-end against a live dev server: an SSE subscriber receives a second `comment` event after the upload completes and the refetched list includes the file. Touches `src/app/api/comments/[id]/files/route.ts`, `src/app/api/comments/[id]/files/s3/complete/route.ts`. No schema migration.

## [2.3.2] - 2026-07-14

### Fixed

- **Internal (studio-only) comments no longer sent to client share sessions** — the four comment-list responses a share session can reach (`GET /api/share/[token]/comments`, `GET /api/comments`, and the full-list responses of `POST /api/comments` / `PATCH /api/comments/[id]`) returned `isInternal` comments sanitized-but-present, relying on the share UI to hide them — so a client could read internal studio notes in the browser's network tab. Found by the e2e harness on 2026-07-04 (its "internal admin comments are NOT returned to clients" check has failed since); now fixed server-side via a shared `filterInternalComments` helper in `src/lib/comment-sanitization.ts` that, for non-admin viewers, drops internal top-level comments (with their whole thread) and internal replies under client-visible comments before sanitization. Admin responses are unchanged. Verified end-to-end: a seeded internal canary comment is absent from both client-reachable endpoints while present in the DB, and the full e2e suite passes 21/21. Touches `src/lib/comment-sanitization.ts`, `src/app/api/share/[token]/comments/route.ts`, `src/app/api/comments/route.ts`, `src/app/api/comments/[id]/route.ts`. No schema migration.

- **E2E harness: password-share checks failed with a false 403 unless `ENCRYPTION_KEY` was exported in the shell** — `scripts/smoke-e2e.ts` statically imported `@/lib/encryption`, which captures `ENCRYPTION_KEY` from `process.env` at module-init — *before* the script's `loadEnvVar()` `.env` fallback ran. Relying on the fallback therefore seeded the password project encrypted with the `DEV_ONLY` default key, which the server (holding the real key) could not decrypt: the "correct share password issues a share token" check 403'd and its follow-on token check 401'd, wrongly implicating the production password flow (which was never broken). The encryption module is now dynamically imported after `loadEnvVar('ENCRYPTION_KEY')` populates the environment. Touches `scripts/smoke-e2e.ts` only. No schema migration.

- **Share-page video tokens are now minted in one batched request, so large projects can't rate-limit legitimate viewers** — a fresh share-page load tokenized every version of every video at 4–6 single `GET /api/share/[token]/video-token` requests each (~100+ requests on a 20-version project), so the per-IP `share-video-token` limit effectively measured *project size × concurrent fresh sessions* rather than abuse. Seen in production 2026-07-14 (after the 2.3.1 fixes were already in place and working): three share-password logins from one office IP inside a minute — each new tab is a fresh login because the share session lives in per-tab `sessionStorage` — cost ~3 full tokenization passes and tripped the 240/min limit at request 241. The share page now coalesces all token fetches (stream qualities, HLS, thumbnails, timeline VTT/sprites, subtitles) through a batching queue — the same pattern as the existing upload-access batch — into a new `POST /api/share/[token]/video-token/batch` endpoint (mirrors the admin batch route; identical authorization semantics via a shared `canIssueShareVideoToken` helper, chunked at 100 items client-side / 300 max server-side, rate-limited at 60 batches/min as `share-video-token-batch`). A full tokenization pass for each video's qualities now also fires concurrently instead of in sequential waves, so an entire pass — any project size — costs 1–2 requests instead of ~100+. The single GET stays for one-off flows (click-time original-download minting) with its 240/min limit now serving as pure abuse headroom. The 429 backoff, non-caching of rate-limited passes, and session-expiry handling from 2.3.1 carry over unchanged into the batch path. Touches `src/app/share/[token]/page.tsx`, new `src/app/api/share/[token]/video-token/batch/route.ts` + `src/lib/share-video-token.ts`, `src/app/api/share/[token]/video-token/route.ts` (extracted shared helper). No schema migration.

## [2.3.1] - 2026-07-10

### Fixed

- **Cash-basis P&L / dashboard reported expenses by invoice date instead of payment date** — the BAS engine already handled cash basis correctly for Expense records (only RECONCILED expenses, dated by the bank transaction that paid them — the 2026-07-03 audit fix), but the P&L report, the Accounting Dashboard's FY summary, and the monthly trend chart all filtered expenses by `expense.date` with status APPROVED|RECONCILED regardless of basis. So on cash basis an expense invoiced in June but paid in July (a) appeared in the wrong financial year, and (b) unpaid APPROVED bills counted as if paid. The balance sheet's GST-credits leg had the same flaw (claimed credits by expense date even on cash basis, disagreeing with BAS for the same period). Expense-record legs are now basis-aware via a shared helper mirroring the BAS engine's semantics (`src/lib/accounting/expense-reporting.ts`): on CASH only RECONCILED expenses count, dated/bucketed by the paying bank transaction's date; ACCRUAL unchanged. Accounts Payable on the balance sheet is intentionally untouched (it correctly reconstructs unpaid-as-at-date). Posted bank transactions, split lines, and journals were already at the cash date by nature and are unchanged. Touches `src/lib/accounting/reports.ts` (P&L expense/COGS lines + balance-sheet GST credits), `src/app/api/admin/accounting/reports/profit-loss-monthly/route.ts`. No schema migration.

- **AI Assistant Expense mode: account picks emitted as codes were discarded** — models sometimes copy the account *code* (e.g. `6-9220`) into `accountId` instead of the id, which the post-parse guard rejected, clearing an otherwise-correct pick and forcing a manual selection. The guard now resolves a code to its account id before giving up, and the `<historical_mappings>` prompt block leads each line with the account id so models copy the right value in the first place. Touches `src/lib/ai/expense-schemas.ts`, `src/lib/ai/prompts.ts`. No schema migration.

- **Mobile share page: Project Activity no longer hogs the screen** — on phones, the files/album view crammed everything into a single viewport: the activity panel claimed a fixed 420px, crushing the files browser to a ~100px sliver with three nested scroll areas. The layout now follows the video view's existing mobile pattern: the content column takes its natural height (`max-lg:flex-none`), the files browser/album viewer gets a proper `70dvh` working area, and the page scrolls naturally down to the activity panel below the fold (which keeps its internal scroll so the feed's infinite loading still works). Desktop side-by-side layout unchanged. Applies to both the client share page and the admin share view. Touches `src/app/share/[token]/page.tsx`, `src/app/admin/projects/[id]/share/page.tsx`. No schema migration.

- **A client approving a video could rate-limit themselves out of the share page** — seen in production 2026-07-10: a client approved a video and within a minute tripped the `share-video-token` lockout twice, breaking playback/thumbnails on their page for ~2 minutes and spamming the security feed with `RATE_LIMIT_HIT` events. Three compounding causes, all fixed: (1) every project refetch blanket-cleared the video-token caches, so approval re-minted tokens for *every* video version (4–6 requests each) — and the SSE echo of the client's own approval repeated the full pass ~0.5s later; `fetchProjectData` now invalidates only videos whose approval state actually changed (an unchanged-project refetch now costs **zero** token requests, verified in-browser), and the SSE handler skips project-refetch echoes of an action the page itself performed within the last 2.5s. (2) On a 429 the token fetchers silently returned empty strings which were then *cached* as a valid tokenization, breaking playback; the `<video>` error handler responded with an unthrottled forced full re-mint → more 429s → a self-sustaining flood that outlasted the first lockout and triggered a second. The fetchers now honour `Retry-After` with a shared client-side backoff (no token requests until the window resets), rate-limited passes are never cached, and error-driven forced refreshes are throttled to one per 15s. (3) The per-IP limit was raised 120→240/min as headroom for shared-IP audiences (two office viewers behind one NAT on a large project could legitimately brush 120 on initial load alone). Touches `src/app/share/[token]/page.tsx`, `src/app/api/share/[token]/video-token/route.ts`. No schema migration.

## [2.3.0] - 2026-07-10

### Added

- **AI Assistant "Expense" mode — drop in receipts and get reviewable draft expenses** — a new **Expense** pill on `/admin/assistant`, exclusive of the other pills (selecting it deselects Project/Quote/Invoice/Response and vice versa; it's separated by a divider and hidden without accounting menu access — the API enforces the same). Attach receipt photos (`.jpg`/`.png`/`.webp` — HEIC unsupported, export as JPEG) or PDF invoices (≥1 required; images are receipt-mode-only attachments), optionally add a note, and the worker sends them to the configured AI provider as **native multimodal input**: images are downscaled via the existing `processImageBuffer` sharp pipeline then sent as vision parts; PDFs go as native document parts on OpenAI/Anthropic and fall back to `unpdf` text extraction on Ollama (scanned PDFs there are skipped with a loud note; image receipts on a non-vision Ollama model get a warning). The model returns one entry per receipt — date, supplier, description, GST-inclusive amount, whether GST is shown, tax code, and a chart-of-accounts pick constrained to active EXPENSE/COGS accounts — informed by a `<historical_mappings>` context block built from how past expenses and matched bank transactions were categorised (same token heuristics as the bank-account suggest-account scorer, now shared in `src/lib/accounting/description-match.ts`). Code guards re-validate everything post-parse (unknown account ids nulled, malformed dates replaced + flagged, non-positive amounts dropped) and each proposal is checked against existing expenses for an exact date+amount **possible-duplicate warning**. Results render in an editable review card (per-row date/supplier/description/amount/account/tax-code, confidence + source-file chips) — **nothing is created until you confirm**: "Create expense" posts through the existing expenses API (DRAFT status, server-side GST split) and attaches the original receipt file from browser memory via the existing attachments route, so created expenses flow straight into bank-reconciliation quick-match. Refine turns work like the other modes ("change the second one to Office Supplies"). Drivers gained optional multimodal user content (`AiUserContentPart[]`) — existing text-only call sites are unchanged. Touches `src/lib/ai/{attachments,types,openai,anthropic,ollama,prompts}.ts`, new `src/lib/ai/expense-schemas.ts` + `src/lib/accounting/description-match.ts`, `src/worker/ai-assistant-processor.ts`, `src/app/api/admin/assistant/requests/route.ts`, `src/app/admin/assistant/page.tsx`, new `src/components/admin/assistant/ExpenseProposalCard.tsx`.

- **"Accounting Knowledge & Rules" setting** — a freeform rulebook on **Accounting → Settings** (e.g. "Bunnings is usually Set Construction; bank fees are GST-free") injected into expense-mode prompts as authoritative categorisation/GST guidance. Deliberately separate from the AI Assistant's "Studio knowledge & house style" doc, which never applies to accounting. Stored on the `AccountingSettings` singleton. Touches `prisma/schema.prisma` (**schema migration**: `20260710000000_accounting_instructions` adds `AccountingSettings.accountingInstructions`), `src/lib/accounting/{types,settings}.ts`, `src/app/api/admin/accounting/settings/route.ts`, `src/app/admin/accounting/settings/page.tsx`.

- **AI Assistant PWA shortcut** — the installed admin app's long-press/right-click shortcut menu now includes "AI Assistant" alongside Add Trip and New Expense. Touches `public/admin/manifest.webmanifest`.

### Changed

- **Assistant composer: paperclip → plus button, with a mobile receipt menu** — the attach button is now a plus icon; in Expense mode on mobile it opens a small menu of **Add Files** and **Take Photo**, the latter reusing the accounting Take Photo camera modal (extracted as a controlled `CameraCaptureDialog`; the existing `CameraCaptureButton` call sites in `ExpenseFormModal`/`AttachmentsPanel` are unchanged). Captured photos ride the same attachment path as picked files. On mobile the intent pills now wrap as two rows — Project/Quote/Invoice, then Response | Expense. Touches `src/app/admin/assistant/page.tsx`, `src/components/admin/accounting/CameraCaptureButton.tsx`, `src/components/admin/assistant/helpers.ts`.

### Fixed

- **Live-update (SSE) hardening after a code review of the 2.2.3 realtime system** — fixes several defects in the share-page/admin live-update plumbing. (1) *Stale token on reconnect:* all three pages captured the bearer token as a string at mount and reused it for every reconnect; admin access tokens rotate every ~15 min, so any reconnect after that (deploy, network blip, laptop sleep) sent an expired credential and live updates silently died until a full page reload. The stream client now accepts a token **getter**, re-read on every (re)connect attempt, and admin pages refresh the token on a 401 via `attemptRefresh()`. (2) *Listener leak:* a client disconnecting while the server's Redis subscribe was still in flight left the fan-out listener — and the project's Redis channel subscription — permanently leaked; the route now releases the listener when it lands after cleanup, and a failed SUBSCRIBE rolls back its registry entry so later subscribers don't silently skip the Redis subscribe. (3) *Activity feed burst loss:* an SSE-triggered refresh arriving while a fetch was in flight was dropped outright, so the tail of an event burst (e.g. a multi-file upload) stayed invisible until the 2-minute poll; a coalesced trailing refresh now runs after the in-flight fetch. (4) *Reconnect hammering:* the client reset its backoff on connection-accept rather than first byte, so an accept-then-die server (mid-deploy) was retried on a ~2s loop; the reset now waits for data. Plus hardening: heartbeat starts before the Redis subscribe (a stalled subscribe no longer leaves a silent connection for proxies to kill), a failed frame write now tears the connection down instead of relying solely on the abort signal, guest sessions no longer receive comment-event timing, the subscriber message handler re-binds if the Redis client is ever recreated, and the event type list is shared between server and client via `src/lib/project-event-types.ts` instead of being duplicated. Touches `src/lib/project-events.ts`, `src/lib/project-event-stream.ts`, new `src/lib/project-event-types.ts`, `src/app/api/share/[token]/events/stream/route.ts`, `src/components/ProjectActivityPanel.tsx`, `src/app/share/[token]/page.tsx`, `src/app/admin/projects/[id]/page.tsx`, `src/app/admin/projects/[id]/share/page.tsx`. No schema migration.

## [2.2.4] - 2026-07-09

### Changed

- **Video version badge (e.g. "v1"/"v2") enlarged in the share page's main Files browser** — the version-label badge on each video version thumbnail was hard to notice at 11px; increased to 16px. Only this badge changed; duration, APPROVED, and FOR REVIEW badges on the same thumbnail are unchanged. Touches `src/components/ShareFilesBrowser.tsx`. No schema migration.

- **"Uploads" renamed to "Additional Files" on the share page** — clients found "Uploads" confusing since everything on the share page is technically an upload; the label (sidebar section, main Files browser section/folder headers, and breadcrumb) is now "Additional Files" for both the client and admin share views. The internal group-name protocol (`'UPLOADS'` prefix used to match/route folder paths, DB models, and API routes) is unchanged — this is a display-only rename, with the breadcrumb doing a display-time substitution so the underlying folder-path matching logic keeps working unmodified. Touches `src/components/ShareFilesBrowser.tsx`, `src/components/VideoSidebar.tsx`, `src/app/share/[token]/page.tsx`, `src/app/admin/projects/[id]/share/page.tsx`. No schema migration.

- **Share page file browser: two-line names, no orphan project title, Videos split by review status** — folder and file names in the client/admin share page's main Files browser (`ShareFilesBrowser`) were single-line truncated with no way to see the full name short of opening the item; names now wrap up to two lines before truncating, and every card (root folders and files inside a folder) reserves a fixed two-line height regardless of whether its name actually needs one line or two, so grid rows stay evenly sized. A hover tooltip (native `title`) now shows the full name on any truncated folder card (file cards already had one). The redundant "PROJECT"/project-title heading previously shown above the grid is removed (the project name is already shown elsewhere on the page). The root **Videos** section is now split into **Videos — For Review** and **Videos — Approved** (mirroring the sidebar's own grouping), and Videos/Albums/Uploads each get their own labeled section whenever present — previously a project with only videos (no albums) or only albums (no videos) got no section header at all. Touches `src/components/ShareFilesBrowser.tsx`, `src/app/share/[token]/page.tsx`, `src/app/admin/projects/[id]/share/page.tsx` (dropped the now-unused `rootFolderLabel` prop). No schema migration.

## [2.2.3] - 2026-07-09

### Added

- **Share pages and the admin project dashboard now update live, without a manual refresh** — when two people were viewing the same project (an admin and a client on a share page, or two staff on the admin dashboard), one person's activity didn't appear for the other until they reloaded, because everything was fetched only on load / navigation / your own action. There is now a per-project Server-Sent Events channel (`GET /api/share/[token]/events/stream`) carrying a typed signal — `comment`, `internal`, `approval`, `status`, `video`, `upload`, or `album` — published over Redis pub/sub (`publishProjectEvent` in `src/lib/project-events.ts`). Every open page holds a single authenticated stream and, on each event, refetches the relevant slice through the existing sanitized endpoints (the stream carries no entity content). What goes live: client/admin **comments** (create/edit/delete/resolve), **video approval / unapproval** and **project-status** changes (badges + status flip for everyone on the share page), project **internal team comments** on the admin dashboard, and **new/updated video versions** once the worker finishes processing (the worker publishes `video` on job completion). The stream authenticates with the standard `Authorization` bearer via a `fetch`-based reader (not native `EventSource`, so the share/admin token never lands in the URL/logs), reconnects with capped backoff, and heartbeats every 25s to survive proxy idle timeouts. The **Project Activity feed** (on both the client share page and the admin share view) also updates live — each page's stream dispatches a `projectActivityRefresh` the panel listens for — and the admin share view additionally refreshes its comments, project data (approval badge / version state), and downloadable-files list on the relevant events (previously poll-only). **Uploads** are live too — adding, deleting, or renaming a file/folder in the Uploads area (`upload` event) refreshes the Files browser and Activity feed on other open share pages without a manual refresh. So are admin actions on the **Project page**: deleting/renaming a video version, toggling approval, adding/removing a **downloadable asset**, setting a **playback thumbnail** or **subtitles** (all `video`), and creating/deleting/renaming an **album** or adding/removing **photos** (`album`) — asset/photo/video *additions* publish when the upload+processing finishes (the worker's `video`/asset-completion path), so they only surface once actually viewable. Access is respected: `internal` events go only to admins, and `comment` events are withheld from non-admins on `hideFeedback` projects. A single shared Redis subscriber with in-process fan-out keeps Redis connection count flat regardless of how many viewers are open. Touches `src/lib/redis.ts` (new `getRedisSubscriber`), `src/lib/project-events.ts`, `src/lib/project-event-stream.ts`, `src/app/api/share/[token]/events/stream/route.ts`, the mutation routes (`src/app/api/comments/route.ts`, `src/app/api/comments/[id]/route.ts`, `src/app/api/admin/feedback/resolve/route.ts`, `src/app/api/projects/[id]/approve/route.ts`, `.../unapprove/route.ts`, `.../route.ts` status change, `.../internal-comments/route.ts` + `.../[commentId]/route.ts`), the video worker (`src/worker/index.ts`), and the consumers (`src/app/share/[token]/page.tsx`, `src/app/admin/projects/[id]/page.tsx`, `src/app/admin/projects/[id]/share/page.tsx`, `src/components/ProjectInternalComments.tsx`, `src/components/ProjectActivityPanel.tsx`). No schema migration.

### Fixed

- **A client approving a video from the player's Approve button showed as a generic "Client" in Project Activity instead of their name** — the share page has two approve entry points: the files-browser/download-modal button (`handleApproveVideo`) already forwarded the client's chosen identity, but the Approve button rendered next to the video/comments (`handleApproveSelected` in `src/components/CommentSection.tsx`) posted only `{ selectedVideoId }`. With no `recipientId`/`authorName`, the approve route fell back to storing `approvedByName: 'Client'`, so the activity feed couldn't attribute the approval by name even though the same client's comments showed it. The CommentSection approve now threads `management.recipientId` / `management.authorName` (the same identity used to post comments) for non-admin sessions, so approvals attribute to the client by name; admin approvals are still attributed from the authenticated admin user. Touches `src/components/CommentSection.tsx`. No schema migration.

- **The video sidebar's For-Review/Approved grouping didn't update live when a video was (un)approved elsewhere** — on a live approval/unapproval event the share page refetched project data, so the main files browser (which reads `project.videosByName` directly) moved the video between sections, but the sidebar reads the *tokenized* `allVideosByName` copies. A re-tokenization race — the `loadTokens` effect re-caching the still-stale currently-viewed video before the preload rebuild — left that version's `approved` flag stale in the sidebar until a manual refresh. `sidebarVideosByName` now overlays the authoritative `approved`/`approvedAt`/`unapprovedAt` flags from the freshly-refetched `project.videosByName` onto the tokenized copies (keeping their thumbnail/stream URLs), so the grouping is always correct regardless of tokenization timing. The share page's live-event handler also now refreshes downloadable files on approval (original-quality download availability changes). Touches `src/app/share/[token]/page.tsx`, `src/app/admin/projects/[id]/share/page.tsx`. No schema migration.

### Changed

- **Renamed the share page's "Video Assets" section to "Additional Assets"** — the label was easily confused with the video version itself; the downloadable extras (subtitles, watermark-free copies, etc.) attached to an approved version are now labelled "Additional Assets" throughout (section heading, empty state, and download-availability banner). Touches `src/components/ShareFilesBrowser.tsx`. No schema migration.

## [2.2.2] - 2026-07-08

### Added

- **Generate or regenerate subtitles for a video version after upload, without re-uploading** — previously, skipping the "auto-generate subtitles" checkbox at upload time left no way to add captions later short of re-uploading the whole video: the only regenerate path lived inside the subtitle editor's CC menu, which never renders when no captions exist yet. Each READY video version's action row now has a captions icon that reflects state (blue = generate, amber spin = generating, green = ready — click to regenerate behind a confirm, red = failed/skipped — click to retry) and drives the existing `enqueueVideoSubtitles`/regenerate machinery. The Project page's existing processing-video poll now also covers `transcriptionStatus: PENDING`/`PROCESSING` so the icon flips to green on its own once the worker finishes. Touches `src/components/VideoList.tsx`, `src/components/AdminVideoManager.tsx`, `src/app/admin/projects/[id]/page.tsx`, `src/app/api/projects/[id]/video-statuses/route.ts`. No schema migration.

- **Feedback list flags comments with attachments** — the Project Dashboard's Feedback panel showed comment text only, with no indication a comment had a file attached, so admins had no reason to think they needed to open the share page to see more. Comments with uploaded files now show a small paperclip icon after the text (tooltip: "Has attachment(s) — download from the share page"); the dashboard doesn't serve the files itself, it's purely a signal. Touches `src/app/api/admin/feedback/route.ts`, `src/components/ProjectFeedbackList.tsx`. No schema migration.

### Fixed

- **The S3→local backup now always runs on the worker, so a manual run can't fill the app host's disk** — the scheduled nightly backup runs on the worker (which owns the local mirror's bulk storage), but the admin **"Run backup now"** (and "Dry run") executed `runS3LocalBackup()` *inline in the web request* — i.e. on the app host. In the split VPS+NAS topology the app host is the small (59 GB) VPS, so a manual run mirrored the whole R2 bucket onto it until the disk hit 100%, OOM-killing the app and crash-looping Postgres (`could not write lock file "postmaster.pid": No space left on device`). Both the real run and the dry-run are now **enqueued** to the worker's `notification-processing` queue (`enqueueS3LocalBackup` in `src/lib/queue.ts`); the API route only takes the `s3LocalBackupRunning` lock and returns, and the Settings UI reflects live progress through the existing status poll (the manual worker run now reports per-category progress). The worker's `s3-local-backup` processor handles a `manual`/`dryRun` payload — a manual run overrides the enabled-toggle guard and uses the admin-supplied category list; a dry run never stamps `lastRunAt`. Touches `src/lib/queue.ts`, `src/app/api/settings/s3-local-backup/run/route.ts`, `src/worker/index.ts`, `src/components/settings/StorageOverviewSection.tsx`. No schema migration.

- **A full disk now aborts the backup immediately instead of failing every remaining file** — when a download hit `ENOSPC`, the per-file `catch` in `runS3LocalBackup()` tallied it as a failure and moved on, so a full disk made the run grind through tens of thousands of keys, each burning a wasted S3 `HeadObject`. `ENOSPC` is now treated as the whole-run fatal condition it is: the run aborts at once with a clear "no space left on device — free space and re-run" message (including how many files had been copied). Touches `src/lib/s3-local-backup.ts`. No schema migration.

- **S3→local backup skipped subtitle/waveform/transcription-audio artifacts** — the backup's `videoPreviewsBytes` category used its own StoredFile-role whitelist, independent of the one already used for project storage totals, and it predated the Whisper subtitles feature — `SUBTITLES_VTT`, `WAVEFORM_PEAKS`, and `TRANSCRIPTION_AUDIO` were never added to it, so those files were silently excluded from every backup even though they were already correctly counted in storage totals. Touches `src/lib/s3-local-backup.ts`. No schema migration.

- **Video version Views/Downloads counts always showed 0** — a StoredFile refactor rewrote the video-mapping block in `GET /api/projects/[id]` from a plain `.map()` to an async `Promise.all(...)` for StoredFile lookups, and in doing so dropped the two lines that attached the already-computed `viewCount`/`downloadCount` (from `VideoAnalytics`) onto each video object — the counts were still being queried, just never read back out. Every video version's admin card reported 0 views and 0 downloads regardless of real activity, in both S3 and local mode; the separate Project Analytics page was unaffected because it computes its own counts independently. Touches `src/app/api/projects/[id]/route.ts`. No schema migration.

- **CPU Configuration's worker "last update" timestamp always showed US date format** — the settings page's worker-report timestamp used the browser's default `Date.toLocaleString()` instead of the app's own timezone-aware formatter, so an Australian-timezone deployment still saw `07/08/2026`. Now uses the shared `formatDateTime` helper, which infers day-first vs month-first vs ISO format from the browser/server timezone. Touches `src/components/settings/CpuConfigurationSection.tsx`. No schema migration.

- **Deleting a video's active subtitles asset left the old captions playing** — the generic asset-delete route only removed the uploaded `.srt` `VideoAsset` row; it never touched the derived playback WebVTT (`SUBTITLES_VTT` StoredFile) or the video's `transcriptionStatus`, so the video kept reporting subtitles as available and captions kept rendering from the now-orphaned VTT file after their source was gone. Deleting the active subtitles asset now also clears the VTT StoredFile and resets `transcriptionStatus`/`transcriptionError`, so the video correctly reports no subtitles and the generate/regenerate button (see Added) reverts to its "not generated" state. Touches `src/app/api/videos/[id]/assets/[assetId]/route.ts`. No schema migration.

## [2.2.1] - 2026-07-08

### Security

- **API keys and SMTP password are now write-only — the server never sends stored secrets back to the browser** — previously `GET /api/settings` decrypted the SMTP password and the Anthropic/OpenAI/Whisper API keys and returned the **plaintext** to the admin UI (so the Settings "reveal" eye showed the real secret, and any session/XSS/devtools access could lift it). The settings API now returns only a `…Configured` boolean per secret and never the value. The Settings fields show a "Saved" state with a placeholder, keep the saved secret when left blank, replace it when a new value is entered, and offer an explicit "Remove saved key". Editing a saved SMTP password is no longer required to send a test email — the server falls back to the stored password. Touches `src/app/api/settings/route.ts`, `src/app/api/settings/test-email/route.ts`, the three settings sections, and the new `src/components/settings/SecretField.tsx`. No schema migration.

### Fixed

- **Daily S3→local backup can no longer hang forever with the UI stuck on "Backing up…"** — the backup's per-file download (`downloadKey` in `src/lib/s3-local-backup.ts`) awaited `client.send(GetObject)` and `pipeline(body → file)` with **no timeout or abort**, and the shared S3 client (`src/lib/s3-storage.ts`) was built with the SDK's default HTTP handler, whose `connectionTimeout`/`requestTimeout` are both unset (infinite). A single half-open TCP socket to R2 mid-download — plausible over the worker's cross-network path — therefore stalled that one `await` forever, so `runS3LocalBackup()` never returned, the `s3LocalBackupRunning` lock flag never reset, the Settings UI span indefinitely with its buttons disabled, and (worse) every subsequent nightly run was silently skipped by the "already in progress" guard. Three fixes: (1) the S3 client now uses a `NodeHttpHandler` with a 10s connection timeout and a 120s socket-idle `requestTimeout` (env-overridable via `S3_CONNECTION_TIMEOUT_MS`/`S3_REQUEST_TIMEOUT_MS`) — an idle timeout, so slow-but-progressing large transfers aren't killed, and the abort is retryable under the existing `maxAttempts: 5`; (2) each download additionally runs a bytes-written watchdog that aborts a transfer stalled for `S3_BACKUP_DOWNLOAD_IDLE_TIMEOUT_MS` (default 120s), so one wedged object fails and is tallied rather than hanging the whole run; (3) the lock now records `s3LocalBackupStartedAt` and self-heals — a flag held past `S3_BACKUP_STALE_LOCK_MS` (default 6h) is cleared automatically on the next status poll or run attempt, so a lock orphaned by a killed process can never block backups permanently. New `s3LocalBackupStartedAt` column (migration `20260711000000_s3_backup_started_at`). Touches `src/lib/s3-storage.ts`, `src/lib/s3-local-backup.ts`, `src/worker/index.ts`, `src/app/api/settings/s3-local-backup/run/route.ts`.

- **Transcription language accepts British-English locales again, and captions now use British spelling** — setting the transcription language to a regional English locale like `en-GB` or `en-AU` failed the whole job with Whisper's `Invalid language 'en-gb'. Language parameter must be specified in ISO-639-1 format.` The Whisper request now strips any BCP-47 region subtag before sending, so `en-GB`/`en_AU`/`en-US` all normalise to the bare `en` code Whisper requires (`src/lib/whisper.ts`). Separately, Whisper always transcribes English with US spelling regardless of the language hint, so when the configured locale is British English (`en-GB`, `en-AU`, `en-NZ`, `en-IE`, `en-ZA`) both auto-generated subtitles and AI-assistant dictation now run a US→British spelling pass over the text (colour/centre/organise/…). Only unambiguous mappings are converted — words whose US form is a valid different British word (program, meter, tire, check, practice, licence) are deliberately left untouched. New `src/lib/american-to-british.ts`; applied in `src/worker/transcription-processor.ts`. No schema migration.

- **"Cancelled N pending job(s)" count on reprocess/close no longer inflates with phantom album jobs** — `cancelProjectJobs()` cancels album-photo-zip and album-photo-thumbnail jobs by calling `queue.remove(jobId)` on deterministic IDs inside a `try`, then incrementing the counter. But BullMQ's `remove()` resolves with the number of keys removed and does **not** throw when the job is absent, so the `catch` never fired and the counter was bumped unconditionally — once per album per zip variant (full/social) plus once per album for thumbnails. A project with one album therefore always logged `Cancelled 3 pending job(s)` on every reprocess even when nothing was queued. Both sections now only count when `remove()` actually removed something (`> 0`). Touches `src/lib/cancel-project-jobs.ts`. No schema migration.

- **Calendar key-dates ICS feed no longer crashes for roles carrying a retired project status** — the `20260709000000_remove_project_status_share_only` migration dropped `SHARE_ONLY` from the `ProjectStatus` enum, but roles whose saved `permissions.projectVisibility.statuses` still listed `SHARE_ONLY` leaked that dead value straight into `prisma.projectKeyDate.findMany`'s `project.status.in` filter, which Prisma rejected for the whole query (`PrismaClientValidationError`) — silently breaking the subscribed calendar feed for affected users. `normalizeRolePermissions` now validates each saved status against the live `ProjectStatus` set and drops any that no longer exist, so a removed enum value can never reach a query again. Touches `src/lib/rbac.ts`. No schema migration; existing role blobs are cleaned on read (optional one-off SQL available to scrub the stored JSON).

## [2.2.0] - 2026-07-07

### Changed

- **Project Activity entries now lead with the person's avatar, and comment previews stand out** — each entry attributed to a named person now shows their identity avatar (uploaded photo for admin users, otherwise colour-tinted initials from their display colour) in place of the old muted event-type icon, with a small event-type badge tucked into the corner so the action (commented / approved / added) stays scannable. Generic *Admin*/*Client* and unattributed rows keep the plain icon; guests never receive a `userId`, so an admin's avatar image can't be used to identify them. The comment-preview box, which previously used `bg-muted/50` on the panel's `bg-muted/70` surface and effectively vanished, is now a raised bubble (`bg-accent` + hairline border + subtle shadow) and wraps to three lines before clamping instead of truncating to one. `buildProjectActivity` now emits `actor.userId`/`actor.named`; the panel reuses the shared `InitialsAvatar`. Touches `src/lib/project-activity.ts`, `src/components/ProjectActivityPanel.tsx`. No schema migration.

- **Project Activity uploads entries are now click-to-open** — clicking an *uploaded files* or *created folder* entry in the share-page Project Activity feed now navigates the Files browser to that UPLOADS folder and highlights it in the sidebar, matching the existing click-to-open behaviour for videos and albums (entries with an undefined folder path open the UPLOADS root). The panel emits an `uploads` open-target for `UPLOADS_ADDED`/`UPLOAD_FOLDER_ADDED` events, routed to each page's existing `handleUploadsSelect` helper. Touches `src/components/ProjectActivityPanel.tsx`, `src/app/share/[token]/page.tsx`, `src/app/admin/projects/[id]/share/page.tsx`. No schema migration.

- **Uploads folder cards stand out in the share-page sidebar** — the per-folder cards in the sidebar's UPLOADS section previously used a grey gradient tile with a small muted folder icon that blended into the surrounding dark surface. The tile now uses a soft primary-blue fill with a matching hairline border and a larger primary-coloured folder icon, so folders read clearly against the background and echo the blue UPLOADS header. Touches `src/components/VideoSidebar.tsx` (shared `renderUploadFolderButton` helper, so desktop and mobile both update). No schema migration.

- **Admin Client Activity panel restructured so the project name always leads** — rows previously showed the video/album/asset name as the bold header line and only fell back to the project title when nothing more specific was available, so the same client's activity read inconsistently row to row and the project itself wasn't always identifiable at a glance. The project title is now always the header line; a secondary line under it shows the specific video/album/asset being viewed (with its version pill), and is omitted entirely when there's nothing more specific than "viewing the share page." Session identity (email/access method) moved to its own line, no longer sharing space with the project title. If the video/folder name happens to match the project's own title, it's dropped from the secondary line so it isn't echoed twice. Touches `src/components/ClientActivityEye.tsx`. No schema migration.

### Fixed

- **Subtitle editor: clicking a cue that starts exactly where the previous cue ends could show both captions at once** — `selectCue`'s seek landed exactly on the clicked cue's `startMs`, but when a preceding cue's `endMs` equalled or slightly overlapped that timestamp, both cues were simultaneously "active" at that exact frame and the player rendered two captions. The seek now detects that overlap and lands the playhead a small fixed offset (20ms) past it — enough to clear seek imprecision — clamped to stay inside the clicked cue; non-overlapping cues still seek to their exact start. Touches `src/hooks/useSubtitleEditor.ts`.

- **Client Activity "Streaming video" state works again with HLS/S3 previews** — since the 2.1.0 direct-to-HLS migration, client video playback runs entirely through `/api/hls` (playlists) and, in S3 mode, direct browser⇄R2 for segments — bypassing `/api/content`, which was the *only* place `STREAMING_VIDEO` client activity was recorded. As a result the live Client Activity eye showed everyone as "Viewing share page" even while actively watching. Two signals restore it: (1) the HLS variant-playlist route now records a throttled, fire-and-forget "started streaming" marker (asset playback previews stay exempt, matching `/api/content`); (2) a new `POST /api/track/video-heartbeat` endpoint (mirroring `/api/track/video-view`) that the player pings on play and every 45s while playing (stopping on pause/end/close), keeping the presence fresh within the 120s activity TTL and supplying the video name/version for display. Touches `src/app/api/hls/[token]/[[...path]]/route.ts`, `src/components/VideoPlayer.tsx`; new `src/app/api/track/video-heartbeat/route.ts`. No schema migration.

### Added

- **"Multiple Items" notification — email clients about a hand-picked set of videos and/or albums** — the project **Send Notification** modal gains a *Multiple Items (Pick Videos & Albums)* type that sits between "Entire Project" (everything) and the single "Specific Video"/"Specific Album" options. Admins tick any combination of ready videos and albums plus optional notes, and each selected recipient gets one email listing exactly those items (videos grouped by name with version + Approved pills; albums with photo counts), styled to match the existing "Project Ready for Review" email. New email template `renderNewItemsReadyEmail`/`sendNewItemsReadyEmail` (`src/lib/email.ts`, preview `06b-new-items-ready.html`); the notify route (`src/app/api/projects/[id]/notify/route.ts`) accepts `videoIds`/`albumIds`, validates them against the project's ready videos/albums, and logs a new `SELECTED_ITEMS_READY` tracking/event type (surfaced as "Selected Items Ready" in analytics — `src/app/api/analytics/[id]/route.ts`). Touches `src/components/ProjectActions.tsx`. No schema migration.

## [2.1.9] - 2026-07-07

### Added

- **Admin-managed Uploads folders (mirrors Videos/Albums)** — when the Uploads project type is enabled, the project detail page now has an **Uploads** section with **Add Folder**, matching the Videos/Albums sections. Admins create named top-level folders, upload files into them, and rename/delete them; clients can still upload into those folders and add subfolders on the Share page (governed by the existing *"Allow clients to upload files"* setting, whose copy now reads "Uploads directories"). On the Share page the single generic **UPLOADS** sidebar entry is replaced by an **Uploads** section that lists each folder as its own card (empty folders included); opening a card drills into it in the files browser, and its **Back** button returns to the project root instead of an uploads-root view that no longer exists. New admin routes `GET/POST /api/projects/[id]/upload-folders`, `PATCH/DELETE /api/projects/[id]/upload-folders/[folderId]`, `POST/DELETE .../[folderId]/files`; the folder rename (zero-copy repath) + recursive delete + folder-materialise logic is now shared in `src/lib/share-upload-folder-storage.ts` between the share and admin routes. Admin uploads are exempt from the client upload quota. New component `src/components/AdminUploadManager.tsx`; touches `src/app/admin/projects/[id]/page.tsx`, `src/components/VideoSidebar.tsx`, `src/app/share/[token]/page.tsx`, `src/components/ShareFilesBrowser.tsx`, `src/app/admin/projects/[id]/settings/page.tsx`. No schema migration.

### Changed

- **Share-page background contrast (Comment Display, Project Activity, Files browser, subtitle editor, video sidebar)** — introduces a second, lighter surface tone (`bg-muted/70`) alongside the base background so scrollable record/item areas read as a distinct layer instead of blending into their header/toolbar chrome, matching the tone already used behind comments. Applied to: the Project Activity record list (header stays base, now height-matched to the Files browser toolbar); the Files browser's scrollable body (toolbar stays base); the desktop video sidebar's For Review / Approved / Albums / Uploads sections (only the section-label bands stay base; the items and any trailing empty space share the lighter surface edge-to-edge); the Comment Display message list; and the subtitle editor's cue-list background (cue cards stay solid so they still stand out against it). Touches `src/components/{ProjectActivityPanel,ShareFilesBrowser,VideoSidebar,CommentSection,subtitle-editor/SubtitleEditPanel}.tsx`.

- **Per-version subtitle control + manual SRT (upload & copy)** — handles the "polished captions, then a new version for a small change" case without re-running Whisper from scratch. (1) A per-version **Auto-generate subtitles** tickbox on the new-video/new-version upload form (shown when Whisper is enabled globally; new `Video.autoGenerateSubtitles`, migration `20260709000000_video_auto_generate_subtitles`). When off, the version skips the Whisper run — the waveform still generates and a forced **Regenerate** still overrides. The global Settings toggle stays the master switch (its description was reworded to reflect the per-version default). (2) **Set SRT** — upload an `.srt` like any other video asset, then an icon-only **Set** button on that asset row (mirroring "Set as thumbnail") promotes it to the version's active playback captions (new `POST /api/videos/[id]/assets/[assetId]/set-subtitles`; parses the asset's SRT → promotes it to the canonical `subtitles` asset and demotes any previous one → regenerates the playback VTT → marks READY). The active captions row shows a green Captions indicator. (3) **Copy to Version** now works for subtitles — copying the `subtitles` asset to another version regenerates its VTT and marks it READY, so the captions actually play (previously it cloned the SRT but not the VTT). All three funnel through `writeCuesForVideo`, extended to **create the subtitles asset when a version has none**. Touches `prisma/schema.prisma`, `src/lib/subtitle-store.ts`, `src/lib/queue.ts`, `src/worker/transcription-processor.ts`, `src/app/api/videos/route.ts` + `[id]/route.ts` + `[id]/assets/set-subtitles/route.ts` + `[id]/assets/copy-to-version/route.ts`, `src/components/{VideoUpload,MultiVideoUploadModal,AdminVideoManager,VideoAssetList,settings/TranscriptionSettingsSection}.tsx`, `src/app/admin/projects/[id]/page.tsx`.

- **Project Activity feed on the share pages** — in file-browser/album mode the right-hand panel (previously empty until a video played) now shows a live, newest-first **Project Activity** feed: videos, new versions, comments, albums, photos, uploads, and approvals/unapprovals, each with who + when. It's derived live from existing tables (so deletions disappear) with bulk photo/upload additions grouped into one entry. Entries have bold names, version-label pills, a one-line comment preview, click-to-open (video/album), infinite scroll, and refresh on approval; the panel is resizable and shares its width with the Comment Display. Attribution is captured at write time (new creator/approver columns on `Video`/`Album`/share-uploads; old rows fall back to sensible defaults), and clients pick their name via a per-project "who are you?" prompt that stays correct across project switches. Uploads entries are hidden from clients who can't see the UPLOADS area. New admin (`/api/projects/[id]/activity`) + share (`/api/share/[token]/activity-feed`) endpoints; migration `20260710000000_project_activity_attribution`.

- **Higher-contrast subtitle timeline strip** — the waveform is dimmed to a neutral slate and the cue blocks strengthened (heavier fill, brighter border/active/handle states, white text) so captions read as clear segments; larger cue text at the 10s zoom.

- **Subtitle editor polish** — switching videos/albums/uploads in the sidebar while editing now prompts on unsaved subtitle edits (those clicks previously bypassed the guard); the waveform position indicator is an interactive scrollbar; cue blocks show full wrapped text (3-line clamp); "Subtitles off" works while editing; clicking anywhere on the strip seeks; and wheel-panning the strip no longer also scrolls the page. **CC → Edit** now toggles: re-opening the CC menu and clicking Edit while the editor is open closes it (running the unsaved-changes prompt first); the menu item relabels to "Close editor" while editing. The timeline **Follow** button is now a real on/off toggle (previously it could only be re-engaged, never switched off). The editor's close **X** is now a red button with a white X so it's obvious how to exit.

- **Cached transcription audio — regenerating subtitles no longer re-downloads the full video** — the transcode job caches a mono 16 kHz mp3 in the previews tree (new `TRANSCRIPTION_AUDIO` FileRole, migration `20260708000000_transcription_audio_cache`) that transcription, **Regenerate**, and waveform peaks reuse, falling back to the original only when the cache is missing. For **OpenAI**, a compact one-off **AAC-LC** copy (mono 16 kHz 48 kbps ≈ 21 MB at 60 min) is sent to stay under the 25 MB upload cap — transparent for speech; local Whisper gets the full-quality cache. Videos **over 60 minutes are skipped on the OpenAI provider** (they can't fit the cap) with a `SKIPPED` status + explanatory message; local Whisper has no length limit and is not gated. Counted in the byte rollups and cleaned up with the preview tree.

- **Subtitle/waveform generation now shows in Running Jobs** — a per-project **"Subtitles"** entry while active, with failures surfaced in Recently Finished (previously invisible and silent).

- **More compact video-player controls + mobile subtitle-editor scroll fix** — a segmented frame-step/speed button block, a cog-icon quality selector, and on mobile a YouTube-style drill-down settings menu (Quality / Playback speed / Subtitles). Also fixed the edit-subtitles cue list not scrolling on mobile / narrow desktop.

- **Suppress Whisper end-of-audio hallucination loops in subtitles** — a deterministic pass merges runs of adjacent identical cues over trailing silence (small-gap only, so genuine repeats are preserved). Applies to new/regenerated subtitles; manual edits untouched.

- **Subtitle editor v2 refinements** — live caption preview (edits show immediately, no Save); fixed stacked/duplicate captions by keeping one imperatively-populated caption track; bordered, auto-growing edit fields; smoother higher-resolution waveform; reprocessing heals a missing waveform without clobbering manual edits; VTT + waveform peaks counted in the S3 `previewBytes` figure.

- **Subtitle editor v2 — in-page panel + zoomed waveform timeline (modal retired)** — **CC → Edit** now opens an in-page subtitle panel instead of a modal: searchable cue list synced to playback, inline text/timestamp editing, per-cue split/merge/delete, insert-at-playhead, 50-step undo, and `.txt`/SRT exports. A desktop timeline strip over the video's audio waveform lets you drag/resize/split cue blocks (clamped to neighbours, bounds, and a 200ms min). Waveform peaks are a new worker artifact (`WAVEFORM_PEAKS` FileRole, migration `20260707000000_waveform_peaks`); existing videos get one on regenerate. Clients can edit too; unsaved edits are guarded on close/exit/version-switch.

- **OpenAI provider for the AI Assistant and Transcription + caption formatting** — OpenAI (GPT) joins Ollama/Anthropic for the Assistant, and a Local ⇄ OpenAI Whisper toggle is added for transcription (pinned to `whisper-1`, the only model returning word timings), each with its own encrypted API key. Caption formatting adds max chars-per-line + lines-per-caption; the player's subtitle button is now a boxed **CC** badge. Migration `20260706120000_openai_and_caption_formatting`.

- **Auto-generated subtitles & transcripts (Whisper) + Whisper-backed Dictate** — video versions are transcribed after processing by a self-hosted, OpenAI-compatible Whisper server (Settings → Subtitles & Transcription; worker-only, with a test-connection button). The SRT is stored as an approval-gated per-video VideoAsset and a WebVTT derivative (`SUBTITLES_VTT` FileRole) is served for playback. A player **CC** button toggles/edits subtitles; the Assistant's Dictate uses Whisper when configured (Web Speech API fallback). Migration `20260706000000_transcription`.

- **AI Assistant — revise existing quotes and invoices** — an "Update existing" mode: pick a quote/invoice, describe the change in plain English, review the revised document, and commit back via the version-locked PATCH (concurrent edits surfaced as "reload and re-apply"). Reuses the same refine + guard machinery. *Updating existing **projects** is still to come.*

- **AI Assistant — enquiry reply drafts, a customisation area, and refine-after-generation** — optional copy/paste **reply drafts** in the studio's voice that can safely cite portfolio pieces (the model picks by id; real titles/URLs are substituted in code, hallucinated refs dropped). A **customisation area** (Settings → AI Assistant) adds a Portfolio Library, reply sign-off, a reply-drafting toggle, and a free-form house-style **Studio instructions** box injected into every prompt. **Refine** re-runs the model against the current proposal to apply just a described change in place. Migration `20260705020000_ai_assistant_customisation`.

- **AI Assistant (v1) — draft projects and quotes/invoices from a brief, email, or attached documents** — a new admin **Assistant** page turns a pasted brief and/or attachments (up to 5 × 10 MB of `.eml`/`.pdf`/`.docx`/`.txt`) into an editable proposal — project setup (client match-or-create, recipients, key dates, optional Gantt) and/or a draft quote/invoice — with review-before-commit throughout (the LLM only returns structured JSON; creation goes through the existing endpoints). Pluggable **Ollama** or **Anthropic** backend (worker-run, encrypted key) via a new `ai-assistant` queue + `AiAssistantRequest` table. Anti-hallucination guards are enforced in code (client ids from a list, ISO dates, integer cents, Line-Item-Library pricing, recipient emails must appear in the source), each surfaced in an "assumptions" list. Includes voice dictation, first-class attachment extraction (emails → External Communication, docs → Project Files), and a new `assistant` menu permission. Migration `20260705000000_add_ai_assistant`; new deps `@anthropic-ai/sdk`, `unpdf`, `mammoth`.

### Removed

- **Removed the "Share Only" project status** — `SHARE_ONLY` (and the `isShareOnly` flag) is gone; it was never used and its behaviour overlapped the existing per-project **Hide Feedback Section** setting, which remains. `ProjectStatus` now has 7 values; feedback-hidden gating keys solely off `hideFeedback`. Migration `20260709000000_remove_project_status_share_only` recreates the enum without the value (safe: no rows referenced it).

### Changed

- **AI Assistant chat refinements** — composer truly pinned to the viewport bottom (JS-measured height); revisions append to the transcript instead of repopulating (only changed sections re-render); shorter revision placeholder; stronger wrong-client protection — the model must report the source org name and a guard rejects any unrelated existing-client match (falls back to a new client, still overridable); and the clunky **Portfolio library was removed** from Settings — drafted replies still acknowledge the enquiry with the sign-off, they just no longer cite example videos (the worker ignores any saved list; inert `aiPortfolioJson` column retained, no migration).

- **AI Assistant redesigned as a chat interface** — a Gemini/Claude-style conversation with the proposal rendered inline and any follow-up refining it in place (the separate "Refine" box is gone). Composer has a round mic + paperclip + send; four type pills (**Project · Quote · Invoice · Response**) replace the docType dropdown, and "Response" (reply drafting) is now a per-request opt-in rather than a Settings toggle (the sign-off field stays in Settings).

- **PostgreSQL 17 → 18 in the Docker Compose stacks** — now `postgres:18-alpine`. **Existing installations cannot switch images in place** — Postgres 18 moves the volume mount to `/var/lib/postgresql` (not `/var/lib/postgresql/data`) and a major upgrade needs a dump/restore (`pg_dump -Fc` on 17 → fresh volume with the new mount path → `pg_restore` into 18; keep the old volume until verified). The app itself is version-agnostic (Prisma 7 supports 18).

### Fixed

- **BullMQ rejects `:` in custom job IDs — subtitle and share/asset preview generation were silently failing to enqueue** — since the 2.1.7 BullMQ bump, a colon in a custom `jobId` throws, and the error was swallowed by a `.catch`, so jobs were stamped pending in the DB but never queued (subtitle generation and share-upload / video-asset previews). Switched those IDs to `-` delimiters.

## [2.1.8] - 2026-07-05

### Fixed

- **CI restored after the 2.1.7 dependency sweep (two independent breakages)** — the `rbac-lint-tsc` job on `main` failed at `npm ci`: npm 10 (bundled with the workflow's Node 22) has a validation bug with nested overrides (`tinyglobby → picomatch@4.0.4`) and rejects the lock file that npm 11 generates and accepts — verified against a freshly regenerated lock, so npm ≥ 11 is a hard requirement, not a stale-lock symptom. CI now runs Node 24 (matching the Dockerfile's `node:24` + `npm@latest` and local dev). The next failure in line was TypeScript 6 promoting the deprecated tsconfig `baseUrl` to a hard error (TS5101) — removed, since `paths` already resolve relative to `tsconfig.json` under `moduleResolution: "bundler"`. Also bumped `actions/checkout` v4 → v5 (clears the Node 20 deprecation annotation).

### Changed

- **`engines` guard (`node >=24`, `npm >=11`)** — anyone installing with older tooling now gets a clear `EBADENGINE` warning naming the requirement instead of a cryptic lock-sync error. The lock file was also resynced, picking up the missed 2.1.6 → 2.1.7 root version bump and npm 11's bundled-dep metadata for `@tailwindcss/oxide-wasm32-wasi`.

## [2.1.7] - 2026-07-04

### Changed

- **Dependency upgrade sweep — every major bumped except Stripe, plus a full in-range refresh (0 vulnerabilities)** — a coordinated pass bringing the stack to current majors. Everything below was verified together: `npm run lint`, `npm run build`, `npm run test:smoke` (25/25), a browser walkthrough (login, invoice editor, security/accounting pages, share-page VideoPlayer), a full worker startup, and `prisma migrate status` (55 migrations, in sync). `npm audit` is clean.
  - **Prisma 6 → 7** — the connection URL moved out of `prisma/schema.prisma` (v7 no longer supports `datasource { url }`) into a new root **`prisma.config.ts`** (imports `dotenv/config`, since the v7 CLI no longer auto-loads `.env`; harmless in Docker where env comes from compose). The runtime client now requires an explicit **driver adapter**: `new PrismaClient({ adapter: new PrismaPg(DATABASE_URL) })` — applied in `src/lib/db.ts`, `scripts/seed-demo-data.ts`, and `scripts/smoke-e2e.ts`. `pg` and `dotenv` are promoted to production dependencies (the driver adapter and CLI config need them at runtime), and `@prisma/adapter-pg` is added. The client now generates directly into `node_modules/@prisma/client` (no `.prisma` shim dir), so `scripts/ensure-prisma-client.mjs` is now a no-op. **Docker**: `docker-entrypoint.sh`'s Postgres readiness probe uses `pg` directly (a bare `PrismaClient` can no longer be constructed without an adapter), and the `Dockerfile` copies `prisma.config.ts` into the deps-full, deps-app, and app stages. An override pins `@hono/node-server >= 1.19.13` to close a moderate advisory bundled inside the Prisma 7 CLI's `@prisma/dev` — without it, the Dockerfile's `npm audit` gate would fail the image build.
  - **Tailwind CSS 3 → 4** — migrated via the official `@tailwindcss/upgrade` codemod (renamed utility classes across 95 template files). PostCSS now uses `@tailwindcss/postcss` (`postcss.config.mjs`). The JS config is retained through the supported `@config` compatibility layer (theme colours/shadows/radius stay as HSL CSS-variable mappings); a full CSS-first `@theme` migration is left as optional future work. The v3 `safelist` (dynamic message-bubble border colours built at runtime) became `@source inline(...)` directives in `globals.css`. `tailwind-merge` 2 → 3; `tailwindcss-animate` verified working under the compat layer. Removed an unused `glass` utility (no call sites; it used the removed `bg-opacity-*` syntax and blocked the codemod).
  - **Zod 3 → 4** — the removed `ZodError.errors` accessor was replaced with `.issues` across 39 API routes (`parsed.error.errors[0]` → `parsed.error.issues[0]`); all other usage was already v4-compatible.
  - **Library majors** — **archiver 7 → 8** (the default export was removed; `archiver('zip', opts)` → `new ZipArchive(opts)` in the album-ZIP worker and two download-ZIP routes), **file-type 21 → 22** (the `./core` subpath export was removed; five worker processors now import from the package root), **bcryptjs 2 → 3** (verified it still validates existing v2 hashes via a live login), **html-to-text 9 → 10**, **sharp 0.33 → 0.35**, **lucide-react 0.553 → 1.x** (no icon-rename fallout), and **TypeScript 5 → 6** (`darkMode: ["class"]` → `"class"` for the stricter v4 Tailwind config type).
  - **Types & in-range refresh** — `@types/node` → 24 (tracks the Docker runtime, not `latest`/26), `@types/archiver` → 8, `@types/nodemailer` → 8, and the obsolete `@types/bcryptjs` removed (bcryptjs 3 bundles its own types). A `npm update` also pulled every in-range dependency current, notably **next 16.2.6 → 16.2.10**, **react/react-dom 19.2.4 → 19.2.7**, **isomorphic-dompurify 3.1.0 → 3.18.0** (comment sanitization), nodemailer 9.0.3, bullmq, ioredis, the AWS SDK, Radix, tus, recharts, and postcss. The `mailparser` override for `nodemailer` was changed from a hard pin to `"$nodemailer"` so it tracks the direct dependency and stays deduped.
  - **Deliberate holds** — **Stripe stays at 14** (the 8-major catch-up to 22 is scoped as its own project). **ESLint stays at 9**: `eslint-plugin-react` (pulled in transitively by `eslint-config-next`) has no ESLint 10-compatible release yet and crashes under 10; the rest of the lint chain is ready, so this bumps automatically once that plugin ships support.

### Fixed

- **React Hooks lint compliance under `eslint-plugin-react-hooks` 7.1 (29 pre-existing violations, all real correctness issues)** — the `eslint-config-next` bump pulled the React Hooks plugin's newer `refs`, `purity`, and `preserve-manual-memoization` rules, which surfaced 29 latent bugs. **Refs read during render** (19): the drag-reorder row highlight on the four Sales invoice/quote editors and `SalesLineItemPresetsModal` read `dragIndexRef.current` in JSX (now mirrored to a `dragIndex` state); `CameraCaptureButton`'s Capture button read `streamRef.current` (now a `hasStream` state); `VideoPlayer`'s poster, dialog portal container, comment-range preview anchor, and scrub-bar tooltip position no longer read refs mid-render (state mirrors + a `ResizeObserver`-tracked width; the poster mirror clears on `onPlay`, preserving the no-flash guarantee); latest-ref writes in `useContentImageRefresh` and `VideoPlayer` moved into effects; and the entirely-unused `useDebounce.ts` hook was deleted. **Impure render** (7): `Date.now()` calls in component bodies were anchored to fetch/tick-time state (`SecurityEventsClient` lockout expiry, `CommentInput` delete-window — which also fixes a real bug where the 60s "delete recipient" button never expired without an unrelated re-render) or moved to module scope (`ProjectFileUpload`); two async server-component `Date.now()` calls got justified `eslint-disable` lines. **Broken memoization** (3): forward references and optional-chained `useCallback` deps (`[x?.y]`) were hoisted to plain values in the bank-accounts page, `VideoPlayer` (`stepVideoFrame`), and `ProjectInternalComments`. Touches `src/hooks/useContentImageRefresh.ts` (and removes `src/hooks/useDebounce.ts`), `src/components/{VideoPlayer,VoiceNotePlayer,CommentInput,ProjectFileUpload,AvatarUploadCrop,AdminVideoManager,ProjectInternalComments}.tsx`, `src/components/admin/accounting/CameraCaptureButton.tsx`, `src/components/admin/sales/SalesLineItemPresetsModal.tsx`, `src/app/admin/security/SecurityEventsClient.tsx`, `src/app/admin/accounting/bank-accounts/page.tsx`, the four `src/app/admin/sales/{invoices,quotes}/{new,[id]}/page.tsx` editors, and `src/app/sales/view/[token]/page.tsx`.

## [2.1.6] - 2026-07-04

### Fixed

- **StoredFile/storage audit: orphan-cleanup grace window, upsert field clobbering, large-upload multipart, atomic upload registration, guarded deletes, app/worker config drift alarm** — fixes from a correctness audit of the StoredFile registry and storage layer, focused on the S3 (R2) + split app/worker topology. (1) **Orphan cleanup can no longer delete freshly-uploaded live files**: the scan snapshots DB references *before* listing storage, so a file landing in R2 mid-scan (a browser presigned upload completing, the NAS worker pushing transcode output) looked unreferenced and — in a non-dry-run — was deleted; all three scanners (main storage, local walk, accounting) now skip files younger than **1 hour** (uploads register within seconds; the window covers in-flight work plus cross-network delay), reported as `recentFilesSkipped` in the scan result. (2) **Partial re-registration no longer wipes known metadata**: `registerStoredFile`'s upsert update branch set `fileSize`/`fileName`/`status`/`generatedAt` to null whenever the caller omitted them, so a status-only re-register erased a known size (undercounting storage totals and forcing per-object S3 HEAD fallbacks); omitted fields now leave the existing value unchanged (explicit null still clears). (3) **Large server-side uploads no longer hit R2's ~5 GiB single-PUT cap**: `s3UploadFile` was a plain PutObject despite its doc-comment claiming multipart, and stream bodies couldn't be retried after a transient R2 error (one 500 mid-upload from the NAS killed the job); a new `s3UploadLocalFile` uses server-side multipart with per-part retry above 256 MiB and a replayable single PUT below, wired into TUS-relay (`moveUploadedFile`), album ZIP/thumbnail/social uploads, and share-upload previews via a new `uploadFileFromPath` helper. (4) **Upload completion and DB registration now commit atomically**: all five browser-direct S3 complete routes (share uploads, project/comment/client/user files) previously created the entity row and registered the StoredFile in separate writes — a failure in between left an entity without a registration, a state invisible to all three reconciliation legs; entity create + `registerStoredFile` (which now accepts a transaction client) run in one transaction, and a post-upload registration failure logs the stranded R2 key loudly. (5) **`deleteStoredFile` storage deletion is now safe by construction**: it refuses to single-object-delete directory roles (`TIMELINE_SPRITES`/`HLS_SEGMENTS` — now deleted as a whole prefix), skips deletion when another row still references the same path (shared custom-thumbnail paths), and failed deletes are logged instead of silently swallowed (previously an invisible way to leak paid R2 storage). (6) **App/worker storage-config drift is now detected**: each process publishes a fingerprint of its storage config (provider/bucket/endpoint) to Redis at startup and compares against the other's — a worker accidentally booting in local mode while the app is on R2 (or pointed at the wrong bucket) previously registered unreachable paths silently; both sides now log a loud mismatch error naming the offending host. Also: the daily dangling-row prune logs the bytes it strands for the orphan scan to pick up (was silent), `batchResolveFileSizes` persists sizes resolved via S3 HEAD back onto the row so null-size rows self-heal instead of paying a HEAD per render forever, `resolveEntityProjectId` gained a compile-time exhaustiveness guard so new entity types can't silently register as non-project-scoped, and the `StoredFile.fileSize` schema comment now matches the actual null-means-unknown convention. Touches `src/lib/{stored-file,s3-storage,storage,storage-config-guard,project-storage-orphan-cleanup}.ts`, `src/lib/accounting/file-storage.ts`, `src/worker/{index,album-photo-zip-processor,album-photo-thumbnail-processor,album-photo-social-processor,share-upload-preview-processor}.ts`, `src/instrumentation.ts`, the five `**/s3/complete/route.ts` routes, and `prisma/schema.prisma` (comment only).

- **Sales audit: tax-free invoice status, Stripe balance charging, void-invoice edit lockout, one paid-amount source, webhook retries, reminder/notification noise** — fixes from a correctness audit of the Sales section. (1) **Tax-disabled invoices can now reach PAID**: the stored-status recompute read the invoice's `taxEnabled` flag without ever selecting it from the DB, so it always assumed tax was on and inflated the expected total — a fully-paid tax-free invoice was stored as PARTIALLY_PAID (and could then be chased as overdue). (2) **Stripe checkout now charges the outstanding balance, not the full total**: a client paying online against a partially-paid invoice (e.g. after a deposit) was charged 100% again plus the gross-up fee on the full amount; the pay route now subtracts recorded payments, labels the Stripe line "Invoice N (balance)", and refuses when nothing is owed. It also refuses to charge when the Stripe gateway currency doesn't match the Sales currency (previously it would charge the same number in the wrong currency) and rejects VOID snapshots outright. (3) **Voided invoices can no longer be edited back to life**: PATCH on a VOID invoice now returns 409 ("un-void it first") — previously any edit re-activated the revoked public share (the share upsert clears `revokedAt`), and because the public page's status whitelist didn't know VOID, the resurrected page rendered with no status badge and a live "Pay" button; the public page now also recognises VOID defensively (badge shown, payment blocked). (4) **One source of truth for "how much has been paid"**: invoice status recompute, the public share page, overdue reminders, the sales calendar, and the paid-at/expiry helpers all read Stripe money from `SalesInvoiceStripePayment` while the dashboard rollup read the `SalesPayment` source=STRIPE mirror rows — so deleting a test payment made the dashboard show an open balance while the stored status, public page, and reminders still considered it paid. All consumers now aggregate the same way (manual payments counted toward the balance **plus** Stripe mirror rows), so deleting a Stripe mirror consistently reopens the invoice everywhere. *Note: any pre-mirror Stripe payment (before mirrors were introduced) without a `SalesPayment` source=STRIPE row will now read as unpaid — same as the dashboard already did.* (5) **Stripe webhook failures now retry instead of losing payments**: a DB hiccup while recording a checkout payment previously returned 200 (Stripe never retries) and the payment vanished from the books; persistence failures now return 500 so Stripe retries, the insert stays idempotent, the mirror-payment creation is retry-safe via an existence check, and the status recompute runs on replays too so a partial failure self-heals. Notifications/emails remain best-effort and never trigger retries. (6) **Line items are now validated and tax-rate-stamped at save time**: quote/invoice create+edit previously accepted `items` completely unvalidated (any shape, NaN-producing quantities/prices, unbounded strings — flowing verbatim into public share snapshots, PDFs, and Stripe metadata); a shared schema (`src/lib/sales/line-items.ts`) now enforces sane bounds (extra fields like labels still pass through), and items saved without an explicit per-line tax rate get the current default rate stamped in — freezing each document's totals so a future change to the default Sales tax rate can no longer retroactively change historical invoice totals, flip PAID invoices back to open, or alter what a client is asked to pay. (7) **Quote-expiry reminders skip never-sent drafts**: a draft quote (status OPEN, never emailed) no longer triggers a client-facing "quote expiring soon" email; a quote counts as sent when emailed from the app or manually marked SENT. (Overdue invoice reminders intentionally keep working for invoices sent outside the app.) (8) **"Invoice/Quote Viewed" notifications are deduped**: email-client prefetchers and link scanners hitting a share link 2–3 times in quick succession fired a push notification per hit; views are still all recorded, but only one notification per IP per 15 minutes is sent. Also removed dead code (`findLowestAvailableNumber` in sales numbering). Touches `src/lib/sales/{server-invoice-status,invoice-paid,line-items,numbering}.ts`, `src/app/api/sales/view/[token]/pay/route.ts`, `src/app/api/stripe/webhook/route.ts`, `src/app/api/admin/sales/{invoices,quotes}/**`, `src/app/api/admin/sales/{send-email,calendar}/route.ts`, `src/worker/sales-reminders.ts`, and `src/app/sales/view/[token]/page.tsx`.

- **Running Jobs audit: visibility leak, forever-failures, unbounded queue reads, smarter polling, silent queues, safer clears** — six fixes from a review of the Running Jobs bell. (1) **Project-visibility leak closed**: the album-thumbnail and folder-rename builders in `GET /api/running-jobs` were the only two with no visibility filter, so restricted-role users saw album/project/client names from the whole instance; both now apply the same rules as every other builder (thumbnails scoped by the job's project; PROJECT renames scoped to visible projects, CLIENT/other renames system-admin-only — mirroring the clear endpoint's existing authorization). (2) **Failed rename/thumbnail rows no longer haunt every device forever**: dismissal is per-browser localStorage, so a FAILED row previously reappeared on every other browser indefinitely; failed rows are now time-bound to 24 h (details remain in worker logs). (3) **Queue reads are bounded and the response is cached**: every `getJobs()` call now passes a range cap (1,000, newest-first — the share-upload-preview completed set alone could hold hundreds of full payloads re-deserialized every poll), and the assembled response is cached in Redis for 4 s per user so concurrent tabs share one build instead of each re-reading ~13 queue sets (measured 86 ms → 17 ms on the cached path); clearing a job invalidates the requester's cache so the row disappears on the next poll. (4) **Polling pauses when it can't be useful**: hidden tabs stop polling entirely (an immediate catch-up poll fires on refocus) and a 401/403 stops the every-10s hammering of a dead session until the tab regains visibility. (5) **Failures in the six previously-invisible queues now surface**: asset/client-file/user-file/project-file processing, project-email ingest, and password-email delivery had no Running Jobs presence at all, so e.g. a failed password email vanished silently; their failed jobs (last 24 h) now appear as error entries in the bell's Maintenance bucket for system admins, with the failure reason. (6) **Clearing a never-processed QUEUED video no longer marks it READY**: the clear action assumed QUEUED meant "previews already exist from an earlier run", but a fresh upload cleared before its first transcode was presented as a good video with nothing playable; the video now lands READY only when previews actually exist, otherwise ERROR with a reprocess hint. Touches `src/app/api/running-jobs/route.ts`, `src/components/UploadManagerProvider.tsx`, and `src/components/RunningJobsBell.tsx`.

- **BAS engine accuracy fixes (accounting audit)** — five fixes to `calculateBas` from a correctness audit of the accounting section. (1) **Non-invoice income now reaches the BAS**: MANUAL bank transactions, journal entries, and split lines posted to INCOME accounts were counted as income on the P&L but never fed G1/1A — GST-coded income posted from the bank feed silently skipped the BAS. They now contribute to G1/1A (GST), G3 (GST-free pool), and G4 (input-taxed — previously always $0 because nothing ever set it), and appear in the period's sales records list; BAS-excluded income postings stay out of scope. (2) **Cash-basis GST credits are now claimed when paid, not when approved**: the expense query ignored the reporting basis, so an APPROVED-but-unpaid expense (the app's own Accounts Payable definition) claimed its 1B credit early — a timing breach across quarter boundaries. On cash basis only RECONCILED expenses count, dated by the bank transaction that paid them (falling back to the expense date), and a new warning lists approved-unpaid expenses excluded from the period. (3) **BAS-excluded amounts no longer inflate G11**: all four expense-source loops added non-GST-coded amounts (including wages/super/loan repayments marked BAS Excluded) to non-capital purchases; "BAS excluded" now means excluded from G10/G11 entirely (net GST was never affected — 1B only ever summed GST-coded credits). GST-free/input-taxed **capital** purchases also now land in G10 rather than G11. (4) **Payments not linked to an invoice now raise a warning**: an orphaned payment (e.g. after its invoice was deleted) was silently treated as GST-free while its gross stayed in G1 — an invisible 1A understatement on cash basis. Relatedly, **deleting an invoice with payments is now blocked** (409, mirroring the void guard) so payments can't be orphaned in the first place. (5) **Accrual BAS now includes OPEN invoices**, matching the accrual P&L (previously an issued-but-unsent invoice appeared as income on one report but not the other; cash basis was unaffected). The four duplicated expense loops were also collapsed into one classification pass, and GST rounding is now sign-aware everywhere (a 1-cent asymmetry on refunds/credits). Lodged BAS snapshots are untouched; DRAFT/REVIEWED periods pick up the corrected figures on their next recalculation. Touches `src/lib/accounting/gst.ts`, `src/lib/accounting/types.ts`, and `src/app/api/admin/sales/invoices/[id]/route.ts`.

- **Journal entries on credit-normal accounts no longer flip sign between reports** — the journal dialog stores accounting convention (Debit +, Credit −), and the range P&L and balance sheet honour it, but three other consumers added journal amounts raw: the **monthly P&L** (dashboard trend chart), the **account-ledger period total / sort / CSV export**, and the **chart-of-accounts balances** list. On an INCOME (or liability/equity) account a credit journal — the normal way to increase income — therefore *reduced* the monthly chart's income and the ledger total while *increasing* range-P&L income, so the same entry moved different reports in opposite directions. All three now negate journal amounts for credit-normal accounts (INCOME/LIABILITY/EQUITY), matching the dialog's labels, the invoice rows in the same ledger, and the range P&L. Touches `src/app/api/admin/accounting/reports/profit-loss-monthly/route.ts`, `src/app/api/admin/accounting/accounts/[id]/entries/route.ts`, `src/app/api/admin/accounting/accounts/balances/route.ts`, and `src/app/admin/accounting/chart-of-accounts/[id]/page.tsx`.

- **Backdated balance sheets now show AR/AP as they stood on the report date** — Accounts Receivable used invoices' *current* status and counted manual payments with no date filter, and Accounts Payable was "expenses *currently* APPROVED", so a balance sheet run for a past date reflected today's statuses (an invoice paid last week vanished from last month's AR; an expense reconciled yesterday vanished from last quarter's AP). AR now considers every non-VOID invoice issued on or before the report date with payments date-filtered to that date (fully-paid-as-of rows drop out naturally); AP additionally includes since-reconciled expenses whose paying bank transaction is dated after the report date. The aged-receivables report gets the same treatment. Current-dated reports are numerically unchanged. Touches `src/lib/accounting/reports.ts`.

### Removed

- **Accounting → Settings "Tax Rates" manager (a decoy) removed** — the accounting settings page had a fully functional CRUD for a `TaxRate` table that **no calculation ever read**: every GST figure (BAS, P&L, balance sheet, ledgers) derives from the default sales tax rate in Sales Settings (`SalesSettings.taxRatePercent`). Editing a rate there changed nothing — worse than a missing feature, since it invited the false belief a rate change had taken effect. The section is replaced by a read-only display of the live GST rate linking to Sales Settings (with a note that changing it recalculates history and un-lodged BAS periods), the inert `/api/admin/accounting/tax-rates` routes are deleted, and the bank-reconciliation page (the endpoint's only other consumer, for dropdown labels) now uses the static tax-code labels it already fell back to. The `TaxRate` table itself is retained (no migration). Touches `src/app/admin/accounting/settings/page.tsx`, `src/app/admin/accounting/bank-accounts/page.tsx`, and removes `src/app/api/admin/accounting/tax-rates/`.

- **Timeline-sprite jobs now count against the FFmpeg CPU budget** — sprite generation for share uploads and video assets runs on its own queues, and those jobs were invisible to the dynamic thread allocator: each concurrent sprite job received a *full* pool's worth of FFmpeg threads on top of what the active video transcodes were already using, so a bulk "reprocess previews" (which fans out video + upload-preview + timeline + album jobs simultaneously) could oversubscribe the worker host well past the configured allocation — starving the worker's event loop and surfacing as Prisma `P2024` connection-pool timeouts mid-job. The sprite-generation loop now increments the same active-jobs counter as video processing, so the configured thread pool is divided across *all* sustained FFmpeg work (one-shot thumbnail frame-grabs stay uncounted). Touches `src/worker/asset-upload-timeline-processor.ts` and `src/lib/cpu-config.ts`.

- **CPU Configuration now reports (and validates against) the *worker's* CPU in split app/worker deployments** — the settings page detected CPUs via `os.cpus()` in the web-app process, so with the app on a small VPS and the worker on a beefier machine it showed the VPS's cores ("Detected Threads: 2") and, worse, the save validation rejected any allocation exceeding the *app host's* capacity — making legitimate worker configs impossible to save. The worker now publishes a CPU snapshot (hostname, detected/effective threads, reserved/budget, current allocation, the concurrency it's actually running with) to Redis (`cpu:workerInfo`) at startup and on each 5-min override refresh; `GET/PATCH /api/settings/cpu` prefer this snapshot over local detection, and the UI shows which worker host reported, when, the live concurrency (useful since concurrency changes need a worker restart), a stale-report warning when the last snapshot is >15 min old, and a fallback notice when no worker has reported yet (e.g. worker not yet upgraded). Touches `src/lib/cpu-config.ts`, `src/worker/index.ts`, `src/app/api/settings/cpu/route.ts`, `src/components/settings/CpuConfigurationSection.tsx`, and `src/app/admin/settings/page.tsx`.

## [2.1.5] - 2026-07-02

### Added

- **Per-project Gantt chart (production schedule) with branded PDF export** — a new **"View Gantt"** button on the project page (above "View Analytics Page") opens `/admin/projects/[id]/gantt`, an internal/admin-only production timeline in the style of the hand-built client schedules: colour-coded phase sections, duration **bars** vs milestone **diamonds**, solid bars = our action vs **diagonal-striped** = client action, deadline markers at bar ends, weekday-only day columns grouped under "N Jul week" headers (with a per-schedule **"Show weekends"** toggle for weekend shoots), a branded title band (background/text taken from the admin **Email header colour** / **Email header text** settings so it matches the company's emails and won't clash with the logo) with the date range, and a phase/owner legend (OWNER swatches are neutral grey since they denote shape/fill, not colour). A schedule is seeded from a built-in **standard video-production template** (confirmation → script sign-off → site visit → storyboard → filming day → V1/V2/V3 edit + client-review cycles → delivery → presentation) anchored to a chosen start date with offsets in business days (template lives in `src/lib/gantt/template.ts`), or started blank; phases and tasks are then fully editable via dialogs (name, description, phase, bar/milestone, owner, dates, deadline marker, reorder, delete). On screen the chart **fills the available width** (scaling up for readability) with **zoom in/out controls** (50–300%, click the percentage to reset) in a scrollable viewport; the shared `InputDialog` now closes itself after a successful confirm and gained an `allowEmpty` option so the schedule title can be cleared back to its default. **Export PDF** draws the chart client-side with pdf-lib on landscape A4 — same branded pipeline as sales PDFs (company logo fetched from `/api/branding/logo`, WinAnsi-safe text) — scaling to a single page when close, otherwise paginating with the header/axis repeated per page; the footer carries the "Generated …" stamp on the left (moved out of the header so it can't clash with the logo) and page numbers on the right, and the day columns stretch so the chart always fills the full page width; the on-screen SVG and the PDF share one pure layout engine (`src/lib/gantt/layout.ts`) so they match exactly. Data model: new `ProjectSchedule` (one per project) → `ProjectSchedulePhase` (custom names/colours) → `ProjectScheduleTask` tables (migration `20260703000000_add_project_schedule`; dates stored as `YYYY-MM-DD` strings like key dates). API: new RBAC-gated routes under `/api/admin/projects/[id]/schedule` (+ `/phases`, `/tasks`) — viewing requires the `projects` menu, all mutations additionally require `changeProjectSettings`, and every route enforces project assignment/status visibility like the key-dates endpoints. Touches `prisma/schema.prisma` + the new migration, `src/lib/gantt/{types,dates,template,access,layout,paginate,pdf}.ts` (new), `src/app/api/admin/projects/[id]/schedule/**` (new), `src/components/admin/gantt/{ProjectGanttClient,GanttChart,TaskEditorDialog,PhaseEditorDialog}.tsx` (new), `src/app/admin/projects/[id]/gantt/page.tsx` (new), `src/components/ProjectActions.tsx`, `src/components/ui/input-dialog.tsx`, and `src/app/api/branding/info/route.ts` (now also returns the email header colour/text-mode for the schedule header).

### Changed

- **Performance (batch 2): analytics aggregation in SQL, windowed security-event stats, parallel dashboard fetches** — (1) **`GET /api/analytics` no longer loads every event row into memory**: it previously `include`d every `SharePageAccess` row and every counted download event for all visible projects and counted/deduped them in JS, so cost grew with total event history; visits, per-method counts, unique sessions and download totals are now computed by `in`-scoped `groupBy` aggregates (unique sessions via a `[projectId, sessionId]` group — one row per unique visitor instead of one per visit). Verified equivalent against the old implementation on seeded data covering SWITCH_AWAY exclusion, duplicate sessions, unknown access methods, and non-counted download event types. The projects dashboard also fetches `/api/projects` and `/api/analytics` **in parallel** instead of sequentially. (2) **Security-events summary stats are now windowed to the last 30 days** — the per-type `groupBy` previously scanned the entire ever-growing `SecurityEvent` table on every dashboard load; it now uses the `[type, createdAt]` index over a 30-day window (the events list itself remains unwindowed), runs inside the existing parallel query batch, and the "Types" card is labelled "(30d)". The **type filter dropdown no longer shrinks to recently-seen types**: it now lists the full static event-type catalog (merged with any unknown DB types), with 30-day counts appended where available — so old events stay filterable by type. (3) `GET /api/admin/sales/invoices` was investigated for pagination but left unchanged deliberately: it has **no UI callers** (all pages load invoices via the already-batched `/api/admin/sales/rollup`), and the invoices page intentionally searches/sorts/paginates client-side over the full set. Touches `src/app/api/analytics/route.ts`, `src/app/admin/projects/page.tsx`, `src/app/api/security/events/route.ts`, and `src/app/admin/security/SecurityEventsClient.tsx`.

- **Performance: parallel HLS/sprite uploads, leaner share endpoint, cheaper reconcile sweep and worker timers** — four hot-path efficiency fixes from a performance review. (1) **HLS segment + timeline-sprite uploads now run 8-at-a-time** instead of strictly serially: a rendition produces 100–300 small files, and with the worker on the NAS pushing to R2, per-PUT latency made upload wall-clock dominate — a 10-minute video spent minutes just waiting on sequential PUTs across its 3 renditions. A failure still fails the job and the existing completeness gate (`verifyStoredHlsBundle`) still refuses partial bundles. (2) **`GET /api/share/[token]` no longer queries the project twice** — it's the hottest client-facing endpoint (every share-page load, video-switch revalidation, and 5-min transfer keepalive) and previously fetched the project once for the auth gate and again (with all videos) for the payload; recipients now also load in parallel with settings instead of after them. Response JSON verified byte-identical against the previous build. (3) The 15-min **HLS reconcile sweep** batches its per-candidate video/asset lookups into single `findMany` calls (was up to 400 sequential queries/sweep), rotates its reclaim scan window via a Redis cursor so >200 stuck candidates can't starve reclaimable ones, and **skips re-verifying bundles that failed verification within the last 4 h** (each verify is an R2 LIST + playlist GETs; a broken bundle can't heal between sweeps, and a skip only delays reclaim — deletion still always requires a fresh successful verify). (4) Worker maintenance timers widened: stale-download cleanup 60 s → 10 min (downloads only count as stale after 5 min without progress, so per-minute cross-site Redis scans were ~1,440 near-no-ops/day; stuck downloads now show "in progress" for up to ~10 min before being marked failed) and the CPU-config override poll 60 s → 5 min (admin CPU tweaks now take up to 5 min to reach the worker). Touches `src/worker/video-processor-helpers.ts`, `src/worker/asset-upload-timeline-processor.ts`, `src/worker/hls-reconcile.ts`, `src/worker/index.ts`, `src/app/api/share/[token]/route.ts`, and `src/lib/project-access.ts`.

- **Admin Projects "Feedback" list polish** — the open-comment count badges (the section-header total and the per-project/video/version counts) now render on the **primary colour** with **primary-foreground** text, replacing the amber pill, so the number auto-adapts to a light or dark label depending on the configured primary colour. The list also **collapses done branches on load**: alongside fully-resolved projects (existing behaviour), any **video** and any **version** whose feedback is all done now starts collapsed, so the list opens focused on outstanding work while anything with open comments stays expanded (all still manually toggleable). Touches `src/components/ProjectFeedbackList.tsx`.

## [2.1.4] - 2026-07-02

### Fixed

- **Clients can once again play in-review (unapproved) videos on the share page** — a regression surfacing after the direct-to-HLS migration (2.1.0/2.1.1): both the client share page and the share `video-token` endpoint still gated playback on the legacy MP4 preview roles (`PREVIEW_480/720/1080`), which no longer exist for videos encoded straight to HLS (or older videos whose MP4 previews were reclaimed). For an **unapproved** such video the client only requested a stream token when an MP4 preview path existed — so it requested none, never obtained an `hlsUrl`, and the player got no source (and the quality selector was stripped to nothing); even had it asked, `canIssueShareVideoToken` would have 404'd the streaming qualities. **Approved** videos were unaffected because they unconditionally fetch the `original` token, whose response also carries the HLS master URL — which is why "approved works, in-review doesn't." Two coordinated fixes: the server now allows the streaming qualities (480p/720p/1080p) whenever an `HLS_PLAYLIST` bundle exists (HLS segments *are* the preview; `original`/`download` stay approval-gated), and the client now fetches one streaming token for a direct-to-HLS video that has no MP4 previews so it obtains the HLS URL. Touches `src/app/api/share/[token]/video-token/route.ts` and `src/app/share/[token]/page.tsx`.

- **Cleared "Client Email Footer Notice" now actually removes the notice** — the setting had a hard-coded default ("We proudly self-host…") that `renderEmailFooterNotice` fell back to whenever the stored value was `null`/empty, and the resolve step coerced an empty string to `null` — so `null` (fresh install) and `null` (admin cleared it) were indistinguishable and both re-showed the default. The admin's setting is now authoritative: only text actually entered is rendered; `null`/empty/whitespace shows no footer. (Takes effect once deployed to the app **and** worker; email settings are cached ~30s per process.) Touches `src/lib/email.ts`.

### Added

- **Arrow-key seek on the video players** — on the client share, admin share-preview, and guest players, **←/→** now seek −/+10s (with the same on-screen indicator and repeat-to-accumulate behaviour as the existing double-click-to-seek gesture). Reuses the Space-shortcut focus guard, so it never fires while typing in the comment box or a focused control/dialog. Listed in the keyboard-shortcuts dialog. On mobile this is a no-op (soft keyboards have no arrow keys); the double-tap gesture still covers touch. Touches `src/components/VideoPlayer.tsx`.

### Changed

- **Refined the admin Projects "Feedback" list** (from 2.1.3): the section now **stays visible once everything is done** (fully-resolved projects/videos remain, with an "All done" summary; only projects with no comments at all are hidden); repeated **"N open / N done" text is replaced by compact colour-coded badges** (amber count = open, green check = done, an eye toggle to reveal done comments) to cut the visual noise; groups sort **open-first alphabetically, then done alphabetically** at both project and video level; each project row shows its **client name**, and each version row gains **Play** (opens that version on the share page) and **Export** (SRT) actions; comments are ordered by **video timecode** with **ranges shown** (`0:10 – 0:25`); and **done videos** are visually de-emphasised (muted name, green left rail). Touches `src/components/ProjectFeedbackList.tsx` and `src/app/api/admin/feedback/route.ts`.

## [2.1.3] - 2026-07-02

### Added

- **Feedback task list on the Projects dashboard + one-click "mark done" on the admin share page** — video feedback previously lived only inside each project's review page, with no consolidated view of what's still outstanding. A new **Feedback** section on `/admin/projects` (between the projects list and the kanban board) now surfaces all comments as a task list grouped **Project → Video → Version**, each level collapsible. Every comment — and every threaded reply — carries its own **done** state: tick an individual comment, **mark a whole video done** (all its versions), or **mark the whole project done**, all reversible. Done items are **hidden by default** behind a per-version "N done" toggle, and comments are ordered by **video timecode** (chronological position), replies kept under their parent. The list only shows **open** (non-`CLOSED`, status-visible) projects the signed-in user is **assigned to** that actually have comments (system admins see all); it also shows the client name per project and per-version **Play** (opens that version on the share page) and **Export** (downloads the version's comments as SRT — same as the share page's Export Comments) actions. On the **admin** share page only (never the client-facing one), each comment gains a small green circular **mark-done tick** in its lower-left corner, using the solid success green. Backed by two new `resolvedAt` / `resolvedById` columns on `Comment` (migration `20260702000000_add_comment_resolution`, with a `[projectId, resolvedAt]` index and history-safe `User` relation) and two RBAC-gated endpoints — `GET /api/admin/feedback` (grouped list, `projects` menu) and `POST /api/admin/feedback/resolve` (comment / video / project scope + unmark, gated by `manageSharePageComments`, project-assignment enforced). `sanitizeComment` now exposes the non-PII `resolvedAt` so the tick reflects saved state. Touches `prisma/schema.prisma` + the new migration, `src/app/api/admin/feedback/{route,resolve/route}.ts`, `src/components/ProjectFeedbackList.tsx` (new), `src/app/admin/projects/page.tsx`, `src/components/MessageBubble.tsx`, `src/components/CommentSection.tsx`, `src/lib/comment-sanitization.ts`, and `src/hooks/useCommentManagement.ts`.

### Fixed

- **Voided invoices are now excluded from the Sales Dashboard, calendar, and overdue reminders** — 2.1.2 added the `VOID` status and correctly excluded voided invoices from all **accounting** reports (P&amp;L, aged receivables, balance-sheet AR, BAS/GST), because those queries filter by an explicit status **whitelist**. But several **sales** surfaces instead used a **blacklist** (`!== 'PAID'`) or no status filter at all, so a voided invoice silently leaked back in: the Sales Dashboard **"Awaiting payment"** total and **"Open invoices"** count still included it (the reported symptom), as did the accrual **"Total sales"** figure and monthly revenue chart, the dashboard's open-invoice list, the per-project invoiced totals, and the due-date **calendar**. Most seriously, the overdue-reminders worker keys off due-date + outstanding balance and ignores stored status, so a voided-but-unpaid invoice would have **emailed the client to pay a cancelled invoice**. All sales aggregates now exclude `VOID`: `openInvoices`/`openBalanceCents` in the rollup, `getInvoiceDashboardAmountCents` (a central guard returning `0` for voided, which also covers the revenue chart), the dashboard open-invoice list, the `projects-chart` relation query, the calendar query + post-filter, and a `status === 'VOID'` skip in the reminders worker. Touches `src/app/api/admin/sales/rollup/route.ts`, `src/lib/sales/dashboard-reporting.ts`, `src/app/admin/sales/page.tsx`, `src/app/api/admin/sales/projects-chart/route.ts`, `src/app/api/admin/sales/calendar/route.ts`, and `src/worker/sales-reminders.ts`.

## [2.1.2] - 2026-07-01

### Fixed

- **Worker no longer permanently loses Redis after a transient network drop — restores batched comment notifications** — With the app + Redis on the VPS and the worker on the NAS reaching Redis over WireGuard, a single tunnel blip would kill notifications for good. The general-purpose Redis client (`getRedis()`) had a `retryStrategy` that returned `null` after 3 failed reconnects, which parked ioredis in a closed state that **never reconnected** — harmless on a single host, fatal across a network. Once closed, the worker's hourly batch-notification job kept firing (its BullMQ connection retries forever) but died immediately on the dead client at `admin-notifications.ts`/`client-notifications.ts` (`redis.get()` for cancelled-comment markers), throwing `Connection is closed` before any mail was sent — so admin/client comment-summary emails silently stopped (observed stuck since a drop ~a week prior) while the scheduler looked healthy. `getRedis()` now retries **indefinitely** with a capped backoff (never gives up at runtime, still skips retries during the production build), raises `maxRetriesPerRequest` to 20, adds a 10 s TCP `keepAlive` to detect dropped links promptly, and forces a reconnect on `READONLY`/`ETIMEDOUT`/`ECONNRESET`; the BullMQ connection gains the same `keepAlive`. Queued notifications are unaffected and flush on the next tick once the connection recovers. Directly sent emails (invoices, quotes, password/OTP) were never affected — they're sent inline by the app on the VPS and don't touch this client. Touches `src/lib/redis.ts`.

### Added

- **Void &amp; re-issue for unpaid invoices** — invoices could previously only be **hard-deleted**, which wiped the record and its revision history, orphaned the client's share link, and freed the invoice number for reuse — leaving no audit trail. You can now **void** an unpaid invoice instead: it keeps its number and full record, is marked `VOID`, has its public share link revoked, and is **excluded from all accounting** (P&amp;L, aged receivables, balance-sheet AR, and BAS/GST — all of which filter invoices by an explicit status whitelist, so voided documents drop out with no reporting changes). Voiding is restricted to invoices with **zero payments** (manual or Stripe) and is **reversible** via an **Un-void** action that returns the invoice to `Open`. `VOID` is terminal while set — the status recompute that runs on payment changes leaves it untouched so it can't be silently un-voided. To **re-issue**, the existing **Duplicate** button now also carries the client, project, and due date into the pre-filled new invoice (which is created under a fresh number, so the voided number is never reused). New `VOID` value on the `SalesInvoiceStatus` enum + `POST /api/admin/sales/invoices/[id]/void` endpoint (`{ action: 'VOID' | 'UNVOID' }`, optimistic-locked, payment-guarded); Void/Un-void actions on both the invoice list and detail pages. Touches `prisma/schema.prisma`, `src/lib/sales/{types,badge,status,server-invoice-status,admin-api}.ts`, `src/app/api/admin/sales/invoices/[id]/void/route.ts`, and `src/app/admin/sales/invoices/{page,[id]/page,new/page}.tsx`.

## [2.1.1] - 2026-06-27

### Removed

- **Removed the `STREAM_HLS` kill-switch — HLS is unconditionally the playback path** — `STREAM_HLS=false` (`hlsStreamingEnabled()`) was a holdover from when the player could fall back to a single-file MP4. Since 2.1.0 retired that fallback the flag no longer degraded gracefully: setting it disabled **all** video playback (the share/admin/guest/asset token routes stopped minting `hlsUrl`, the `/api/hls` delivery route 404'd, and the `hls-reconcile` sweep stopped rebuilding bundles) with nothing to fall back to — a config footgun that could only break things, never help. Removed the function and every guard so HLS is offered whenever a packaged `HLS_PLAYLIST` bundle exists (the real, correct gate). Touches `src/lib/video-stream-url.ts`, `src/worker/hls-reconcile.ts`, `src/worker/index.ts`, `src/app/api/hls/[token]/[[...path]]/route.ts`, the four video-token routes (`share`, `admin`, `guest-video-links`, asset `download-token`), and `.env.example`.

- **Removed dead transcoding helpers from the pre-direct-to-HLS pipeline** — `packageHlsRendition()` + its `PackageHlsOptions` interface (`src/lib/ffmpeg.ts`) — the legacy MP4→HLS `-c copy` remux that direct-to-HLS encoding replaced — and `finalizeVideo()` (`src/worker/video-processor-helpers.ts`) — the old MP4-preview finalizer superseded by `finalizeVideoWithoutPreview` — both had zero callers. Also dropped the now-unused `FileRole`/`RegisterStoredFileParams` imports they left behind.

### Fixed

- **No more frame flash when scrubbing or clicking the video timeline** — Two flashes were possible after 2.1.0's sprite-first scrubbing. (1) **Clicking** a point on the timeline flashed roughly twice: a press both flashed the low-res scrub sprite *and* issued two seeks (a pointer-down scrub seek plus the trailing click re-seek), so the player jumped sprite → frame → frame. Scrubbing visuals now only engage once the pointer moves past a small threshold (`SCRUB_DRAG_THRESHOLD_PX`), so a plain click shows **no sprite at all** and resolves to **exactly one** seek issued on release (the redundant trailing `onClick` re-seek is suppressed via `suppressNextTimelineSeek`), letting the `<video>` seek directly (the browser holds the current frame until the new one decodes). The playhead indicator still jumps to the press position immediately on click-and-hold, before any movement. (2) **Dragging then releasing** flashed once: the sprite overlay covering the player was dropped before the `<video>` had finished seeking to the released frame, so the pre-seek frame showed through. The release now bridges the same way the Shift/precision drag already did — the sprite is held until the video reports `seeked` at the released frame (600 ms safety net) — via a new `scrubSettling` state mirroring `precisionFrameReady`. The release also lands exactly one real seek compared against the video's actual position (not the UI playhead ref), so dragging while paused then pressing play correctly resumes from the dragged position. Applies to the client share, admin share-preview, and guest players on both mouse and touch. Touches `src/components/VideoPlayer.tsx`.

- **The player no longer shows an indefinite "Preparing video stream…" for a video with no HLS** — With no MP4 fallback, a client whose video had no playable HLS bundle (a rare chronic packaging failure, or a bundle deliberately shed on close) sat on *"Preparing video stream…"* forever with no signal it would never resolve. The player now escalates: it keeps *"Preparing video stream…"* during the brief token-minting window, then after a short grace period (~5 s) with still no stream switches to **"This video is currently not available."** — setting a clear expectation for genuinely-unavailable videos without flashing the message on healthy ones during the normal token fetch (the timer resets per video and is cancelled the instant a real `hlsUrl` arrives). Also corrected two stale `src/types/video.ts` comments that still referenced the removed single-file MP4 fallback. Touches `src/components/VideoPlayer.tsx` and `src/types/video.ts`.

- **Corrected the "Delete previews for closed projects" confirm dialog** — its text claimed it would delete *"preview files and timeline sprites"*, but timeline sprites are **kept** and the heavy rendition it actually deletes (the HLS bundles) went unmentioned. Reworded to state it deletes the HLS streaming bundles + any legacy MP4 previews and keeps thumbnails, timeline sprites, and originals. Touches `src/components/settings/StorageOverviewSection.tsx`.

- **HLS-reconcile retry sweep no longer lets a large failure backlog starve newer videos** — Both retry legs selected `take: 100` candidates with **no ordering**, so an arbitrary-but-stable first 100 was re-checked every tick; 100+ genuinely-unrecoverable items (e.g. corrupt originals) sorted ahead could keep recoverable ones from ever being retried. Both legs now `orderBy: { updatedAt: 'asc' }` — and since a (re)processing attempt bumps the row's `updatedAt`, stuck items rotate to the back so the sweep cycles through the whole backlog. Touches `src/worker/hls-reconcile.ts`.

- **Preview deletion no longer orphans files when a storage delete fails** — Both the manual "Delete previews for closed projects" action and auto-close-on-approval attempted each storage delete with `Promise.allSettled` but then removed the `StoredFile` rows **unconditionally** — so a storage error left an orphaned file/bundle on disk with no registry row pointing at it, and because the manual action resolves paths *from the registry* a re-run couldn't find the orphan to retry. Both paths now track which deletes actually succeeded and drop only those rows: an MP4 preview row is removed only when its `deleteFile` succeeded, and an HLS bundle's `HLS_PLAYLIST` + `HLS_SEGMENTS` rows (plus the `hlsReady` reset) are removed only when its `deleteDirectory` succeeded. A failed delete keeps the row, so the operation is idempotent and the next run retries it. (`deleteFile`/`deleteDirectory` no-op on already-missing paths, so "already gone" still counts as success and the row is dropped.) Touches `src/app/api/settings/delete-closed-project-previews/route.ts` and `src/worker/auto-close-projects.ts`.

- **Video-asset HLS is now self-healing, like main videos** — Video-type assets play via their own single-rendition HLS bundle, but nothing rebuilt it when packaging failed: `maybePackageAssetHls` caught and **silently swallowed** errors, so a transient R2 failure left the asset with `previewStatus=READY` and no bundle, and neither the `hls-reconcile` retry sweep nor `scripts/backfill-hls.ts` ever looked at assets (both were main-video-only). Added a nullable **`VideoAsset.hlsReady`** column (migration `20260627100000_add_videoasset_hlsready`; `null` = N/A for non-video assets, `false` = should have a bundle but doesn't, `true` = ready) mirroring `Video.hlsReady`. The asset preview processor now stamps it (`true` on package success / already-present, `false` on failure instead of swallowing), `hls-reconcile` gained a `retryMissingAssetHls` leg (re-enqueues the asset preview job for `hlsReady=false` assets in non-CLOSED projects), and `backfill-hls.ts` gained an asset phase (self-normalising: re-running the preview job stamps `true` if a bundle already exists, else builds it). The shedding paths (auto-close, the manual delete-closed-previews action) set asset `hlsReady=false` when they delete a bundle. On **reopen**, the video-asset "needs preview" check now keys off `hlsReady` (was the never-present `PREVIEW_MP4`, which made it always re-enqueue), and reopened **videos** whose only shed rendition was HLS now get an immediate `hlsOnly` rebuild (deduped with the reconcile sweep's jobId) instead of waiting up to ~15 min for the next sweep. Touches `prisma/schema.prisma`, the new migration, `src/worker/share-upload-preview-processor.ts`, `src/worker/hls-reconcile.ts`, `src/worker/auto-close-projects.ts`, `src/app/api/settings/delete-closed-project-previews/route.ts`, `src/app/api/projects/[id]/route.ts`, and `scripts/backfill-hls.ts`.

- **Storage Overview (admin settings) now counts HLS bytes in local-storage mode** — The settings → Storage Overview grand total summed each project's `totalBytes` column on the assumption that preview bytes were already inside it. That holds for files with a real `fileSize`, but the `HLS_SEGMENTS` (and `TIMELINE_SPRITES`) StoredFile rows are directory markers with a null `fileSize` — and since direct-to-HLS the HLS bundle is the bulk of preview storage — so the local grand total under-counted by (often) most of the preview footprint while the "Video Previews" breakdown line (read from `previewBytes`) showed the right number, leaving the two inconsistent. The local branch now uses the reconciled `project.diskBytes` (a true on-disk walk of the project + previews trees, HLS and sprites included), falling back to `totalBytes` only if `diskBytes` hasn't been computed yet. S3 mode is unchanged (it already adds the prefix-summed `previewBytes`). Touches `src/app/api/settings/storage-overview/route.ts`.

- **Closed projects no longer get their previews regenerated, and auto-close now actually sheds the heavy rendition** — Two gaps surfaced after the direct-to-HLS migration. **(1)** The HLS-reconcile retry sweep (`retryMissingVideoHls`) and the `scripts/backfill-hls.ts` backfill both selected READY videos purely by HLS readiness/version with **no project-status filter**, so a legacy/failed video in a **CLOSED** project — including one closed with `autoDeletePreviewsOnClose` — would be re-encoded from the original, rebuilding the exact renditions the close was meant to shed (the backfill's full reprocess also regenerated the thumbnail + timeline sprites). Both now exclude `project.status = CLOSED`; reopening a project makes its videos eligible again. **(2)** `autoDeletePreviewsOnClose` only deleted the legacy MP4 preview roles (`PREVIEW_480/720/1080`, `PREVIEW_MP4`), which no longer exist on direct-to-HLS videos — so closing a project freed almost nothing. Auto-close now also deletes each video's and video-asset's **HLS bundle** (master playlist + segment directory via `deleteDirectory`, plus the `HLS_PLAYLIST`/`HLS_SEGMENTS` StoredFile rows) and sets `hlsReady=false`, while still keeping the ORIGINAL, thumbnail, and timeline sprites so the FILES area stays browsable. The manual **"Delete previews for closed projects"** settings action (`/api/settings/delete-closed-project-previews`) already deleted the HLS bundles but never cleared `hlsReady` (so a re-opened project wouldn't regenerate) and omitted HLS from its dry-run/summary counts (so an HLS-only closed project reported "0 previews" despite freeing real space) — both fixed, and its description copy updated to mention HLS. Touches `src/worker/hls-reconcile.ts`, `scripts/backfill-hls.ts`, `src/worker/auto-close-projects.ts`, `src/app/api/settings/delete-closed-project-previews/route.ts`, and `src/components/settings/StorageOverviewSection.tsx`.

## [2.1.0] - 2026-06-27

### Added

- **Video previews are now encoded DIRECTLY to HLS — no redundant MP4 intermediate** — Previously a video was transcoded to a 480/720/1080 MP4 preview, uploaded to R2, then **downloaded back and remuxed** into HLS — a wasteful round-trip that also left two near-identical copies (MP4 + HLS segments) in storage. The transcoder now emits keyframe-aligned fMP4 (CMAF) HLS segments in a single ffmpeg pass straight from the original (`transcodeVideo` gained an `hlsOutputDir` mode whose muxer flags mirror the old `packageHlsRendition` exactly, so output is byte-compatible — same encode/scale/alignment, only the output container differs). No `PREVIEW_480/720/1080` MP4 is written to storage at all, halving preview storage and removing the upload→download→remux hop. The HLS-only/reconcile job (`hlsOnly`) and the manual repackage button now re-encode from the retained ORIGINAL rather than remuxing a stored preview; the reconcile sweep's "retry" leg is correspondingly simplified to a single path. Thumbnails and timeline sprites are unaffected (they already use the original for best quality), and downloads still serve the original. **Video assets** get the same treatment: their HLS bundle is encoded straight from the asset original (single rendition, capped at the project's highest selected resolution) — no `PREVIEW_MP4` is produced. The asset still gets a poster JPG for grid cards; its preview-status idempotency, the hourly reconcile, and the asset token route now key off the HLS bundle (not the gone MP4), and the lightbox players already prefer the HLS `m3u8` (falling back to the original only until HLS is ready). Touches `src/lib/ffmpeg.ts` (`transcodeVideo` HLS-output mode), `src/worker/video-processor-helpers.ts` (`packageVideoHlsFromOriginal`, `packageAssetHlsFromOriginal`, `encodeHlsRenditionFromOriginal`, `finalizeHlsMaster` — replacing the remux-based `processHlsPackaging`/`processPreview`/`packageAssetHls`), `src/worker/video-processor.ts`, `src/worker/share-upload-preview-processor.ts`, `src/app/api/videos/[id]/assets/[assetId]/download-token/route.ts`, and `src/worker/hls-reconcile.ts`.

- **HLS is now the sole playback path — in every storage mode — with an upload retry + self-healing safeguard** — After 2.0.8/2.0.9 proved HLS robust, the player commits to it fully and the single-file MP4 stream is retired (see the **Changed** entry below). Because there's no longer a fallback, an HLS packaging failure would leave a video unplayable, so the packaging pipeline is hardened on three fronts. **(1) Retryable segment uploads:** HLS segments were uploaded from a `fs.createReadStream`, so a transient R2 `500 InternalError` mid-upload surfaced as *"non-retryable streaming request"* — the AWS SDK can't replay a consumed stream. Uploads now go through `s3UploadFileWithRetry`, which re-opens the stream on each attempt with exponential backoff + jitter (`withS3Retry`/`isRetryableS3Error`), and the S3 client is configured with `maxAttempts: 5` + `retryMode: 'adaptive'` for replayable (buffered) operations. **(2) Completeness gate:** the packager records every file it writes and re-confirms each is present and non-empty (`verifyHlsBundleComplete`) before flagging `hlsReady` — a half-uploaded bundle can never be marked playable; on failure it throws so the bundle stays unready and gets retried. **(3) Self-healing sweep:** a new `hls-reconcile` maintenance job (every 15 min, modelled on `reconcile-project-total-bytes`) finds READY videos with `hlsReady=false` and re-enqueues an `hlsOnly` job that re-encodes the bundle from the retained ORIGINAL — so a transient failure recovers with **no manual intervention** (the old amber "MP4 only" repackage button is gone). Touches `src/lib/s3-storage.ts` (`s3UploadFileWithRetry`, `withS3Retry`, `isRetryableS3Error`, `s3ListPrefixSizes`, client retry config), `src/lib/storage.ts` (`moveUploadedFile` retry, `getStoredFileSize`, `listStoredFileSizes`), `src/worker/video-processor-helpers.ts` (`verifyHlsBundleComplete`, `verifyStoredHlsBundle`), `src/worker/video-processor.ts`, `src/worker/share-upload-preview-processor.ts`, `src/worker/hls-reconcile.ts` (new), and `src/worker/index.ts`.

- **Double-tap (or double-click) the video to seek ±10s, YouTube-style** — On the client share, admin share-preview, and guest-video players you can now double-tap/double-click the **left half** of the video to jump back 10 seconds or the **right half** to jump forward 10 seconds, with a brief on-screen rewind/fast-forward indicator on the tapped side. Repeated taps on the same side chain (each adds another 10 s, e.g. "20 seconds"). A single tap still toggles play/pause but is now delayed by a short window (280 ms) so it can be disambiguated from a double-tap — no play/pause flicker when seeking — and shows a brief centred play/pause icon flash to match. Implemented in the player's `onClick` handler (`handleVideoClick`) with paired seek/play-pause overlay state and two CSS keyframes (`yt-seek-pop`, `yt-tap-pulse`). Touches `src/components/VideoPlayer.tsx` and `src/app/globals.css`.

- **HLS playback now works in local-storage mode, not just S3/R2** — HLS packaging and delivery were hard-gated to S3 mode (segments were only ever delivered as presigned R2 URLs). With MP4 retired, local/self-hosted-disk deployments need HLS too. Packaging now runs in both modes (the `isS3Mode()` early-returns in `maybePackageHls`/`maybePackageAssetHls` are gone; `moveUploadedFile` already handles local moves vs. S3 uploads transparently), `hlsStreamingEnabled()` is no longer S3-only (still honouring the `STREAM_HLS=false` kill-switch), and the repackage route no longer 409s on local disk. The `/api/hls/{token}/…` delivery route gained a local-mode path: variant playlists rewrite segment URIs **same-origin** (instead of presigned R2) and a new token-gated branch streams the segment bytes (`init.mp4` + `seg-*.m4s`) straight from local storage as full-file `200` GETs — same proxy-robust behaviour, no R2 required. The share/admin/guest token routes already gate `hlsUrl` on `hlsStreamingEnabled()` + an `HLS_PLAYLIST` row, so they begin minting HLS URLs in local mode automatically. Touches `src/lib/video-stream-url.ts`, `src/app/api/hls/[token]/[[...path]]/route.ts`, `src/app/api/videos/[id]/repackage-hls/route.ts`, `src/worker/video-processor.ts`, and `src/worker/share-upload-preview-processor.ts`.

- **MP4 video previews are reclaimed automatically once HLS is verified** — HLS segments are a byte-identical `-c copy` remux of the 480p/720p/1080p MP4 previews, so keeping both roughly doubles preview storage. The `hls-reconcile` sweep now deletes a video's MP4 previews (`PREVIEW_480/720/1080` files + StoredFile rows) once it has **independently verified** the stored HLS bundle is complete (`verifyStoredHlsBundle` re-walks the master → variant playlists → every init/segment via a single prefix listing, not the `hlsReady` flag), then refreshes the project's derived byte totals. The ORIGINAL is never touched — it remains the rebuild source. This doubles as a one-time backfill for legacy videos (processed before direct-to-HLS): on its first runs it drains the existing library, and the candidate set self-limits as previews are reclaimed. The sweep also reclaims video-**asset** `PREVIEW_MP4` files once each asset's HLS bundle verifies. Gated by an `HLS_RECLAIM_MP4_PREVIEWS=false` kill-switch. Touches `src/worker/hls-reconcile.ts` and reuses the deletion pattern from `src/worker/auto-close-projects.ts`.

### Changed

- **Timeline scrubbing now previews with lightweight sprites, not full-resolution video frames** — Dragging the playhead or a comment IN/OUT marker on the share/admin players used to seek the real `<video>` element on every move, so the browser fetched the actual (up to 1080p) frame at each position — a lot of bandwidth for what is only a scrubbing preview, when we already ship a cheap timeline sprite sheet for exactly this. The default drag now shows the **sprite tile** instead of seeking: it's stretched (letterboxed to the video's aspect ratio) over the player *and* shown in the timeline hover box, with no real seek until you release (one final seek lands the playhead). Holding **Shift** — the existing precision/frame-by-frame drag — switches to the **exact, full-resolution video frame** for the rest of that drag (releasing Shift returns to sprites), so frame-accurate placement is still one keypress away. The sprite preview is held in place until the real video has actually seeked to the target frame, so pressing Shift no longer flashes the video's stale last frame. The live-frame preview canvas is now only painted during a Shift drag. On touch (no Shift) every drag uses sprites, a straight data win. The drag cue copy now notes Shift also reveals the exact frame. To keep sprite scrubbing fine-grained, timeline previews are now captured **every second** instead of every 2 s (`intervalSeconds` in `processTimelinePreviews`; 100 s of video per 10×10 sheet, was 200 s) — going-forward for newly processed videos. Touches `src/components/VideoPlayer.tsx` and `src/worker/video-processor-helpers.ts`.

- **Removed the single-file MP4 playback path and the per-video HLS/MP4 badge** — The player (`VideoPlayer`) no longer falls back to an MP4 stream: the `<video>` source is resolved purely from the HLS master (hls.js/MSE on desktop, native HLS on iOS Safari), and the MP4 quality-stream fetch (`loadVideoUrl`) and its `videoUrl` plumbing are gone. When a video's HLS isn't packaged yet the player shows a *"Preparing video stream…"* state instead of an MP4. The admin video-list HLS-readiness pill (green **HLS** / **HLS · legacy** / amber **MP4 only** + repackage button) is removed — recovery is now automatic via the `hls-reconcile` sweep — along with its now-unused state and the `s3Mode`-gated rendering. The `/api/videos/[id]/repackage-hls` route is kept (used by the sweep and available for manual recovery). Touches `src/components/VideoPlayer.tsx` and `src/components/VideoList.tsx`.

- **Spacebar plays/pauses the video** — On the client share, admin share-preview, and admin project players you can now tap **Space** to toggle playback (in addition to the existing **Ctrl+Space**), the way YouTube and editing tools behave. It's suppressed whenever a text field or interactive control has focus — the comment box, the comment-time segment inputs, buttons/links, or anything inside an open dialog/popover — so typing a space still types a space and never hijacks an open editor. Handled in the player's global capture-phase key listener and listed in the keyboard-shortcuts dialog. Touches `src/components/VideoPlayer.tsx`.

- **Type an exact comment in/out time — click the timecode above the comment box** — Landing a comment marker on a precise spot by dragging the timeline handles is fiddly (the new Shift-precision drag helps, but you still can't just *enter* a number). The amber timecode pill shown above the message box on both the client share and admin share pages is now a button that opens a small **non-dimming popover anchored to the pill** (so you can watch the marker move on the timeline as you edit) with **Comment in** and **Comment out** fields (side-by-side on desktop, stacked on mobile) plus a **Time ⇄ Timecode** toggle. The toggle defaults to whatever format is currently in use and is wired through the shared `useTimeDisplayMode` hook, so flipping it here reformats the player readout *and* the comment list across the whole share page. Fields render in the active format — `M:SS` / `H:MM:SS` for Time (hours appear automatically once the video runs past an hour), or `HH:MM:SS:FF` (frame-accurate, drop-frame aware) for Timecode — and parsing accepts either. Each field is split into separate two-digit segment boxes per unit — `HH:MM:SS` (or just `MM:SS` for sub-hour videos), or `HH:MM:SS:FF` in Timecode mode — that clamp to their unit's range (minutes/seconds 0–59, frames < fps) and auto-advance to the next box as you fill them, so garbage like `555:505235` is impossible. A small helper line shows the single format that applies to the current video, not a list of options. Out-of-range values (a frame ≥ fps, an out before the in, or any time past the real end of the video — read live from the player) are rejected with an inline message instead of silently sticking. On open the fields seed from the current selection, with **Comment out** pre-filled but greyed until you actually set it. Every *valid* keystroke previews on the timeline immediately, before you press **Done**: typing an **in** with no out drops a single point marker (mirrored into out); typing an **out** extends the range and places the out marker. A typed time is *pinned* so playback no longer drifts the point or clears the range out from under you, with the existing **Reset** affordance returning to playhead-following. Wires a new absolute-position `setCommentRange` and a `getCommentTimeContext` query event into the player (alongside the existing delta-based `adjustCommentRangeHandle`) so the editor, the management hook, and the timeline stay in sync in every player context — including the admin and client share pages, which render `CommentInput` directly rather than through `CommentSection`. While replying to a comment — which threads under its parent and carries no timeline position — the pill is hidden entirely (and the reply box no longer spawns a timeline marker on focus), so a misleading time can't be shown or edited for a reply. Touches `src/components/CommentInput.tsx`, `src/components/CommentSection.tsx`, `src/hooks/useCommentManagement.ts`, `src/components/VideoPlayer.tsx`, `src/app/admin/projects/[id]/share/page.tsx`, and `src/app/share/[token]/page.tsx`.

- **Hold Shift for frame-by-frame scrubbing/handle dragging on the video timeline** — On a long video a single pixel of the scrub bar can be worth several seconds (a 30-minute clip maps ~3 s to a small mouse move), making it hard to land the playhead or a comment IN/OUT marker on an exact frame. Holding **Shift** mid-drag now engages a frame-by-frame mode: cursor travel is mapped to whole-frame steps (`PIXELS_PER_FRAME = 6` px per frame, using the video's FPS metadata) and the result is snapped onto the exact frame grid, so the marker lands on real frames regardless of clip length. Videos with no FPS metadata fall back to a scaled fine-control drag (15% of cursor movement, `PRECISION_DRAG_FACTOR`). It's anchored to the cursor position where Shift engaged, so the marker doesn't jump when you press Shift; releasing Shift returns to normal 1:1 dragging. The drag preview shows a contextual cue — "Hold Shift for frame-by-frame dragging" while coarse, switching to "Frame-by-frame — release Shift, then mouse" while engaged (the marker snaps back to the raw cursor if Shift is released after the mouse, so the cue tells users the correct release order; copy falls back to "precise"/"Fine control" when FPS is unavailable). Applies uniformly to the playhead scrub, the comment-range IN handle, and the OUT handle on the client share, admin share-preview, and admin project players. It is desktop/mouse-only — the cue is gated on `(hover: hover) and (pointer: fine)` and touch pointer events never carry a Shift modifier, so mobile never engages it or sees the hint. The trailing click that fires after a scrub-release is suppressed when precision was used, so the fine-tuned playhead position isn't yanked back to the cursor. Touches `src/components/VideoPlayer.tsx`.

### Removed

- **Watermarks, the per-video revision cap, and the timeline-previews toggle are gone — timeline scrub previews are now always on** — Three rarely/never-used settings were retired to simplify the codebase and shrink surface area. **(1) Watermarks** (`Project.watermarkEnabled`/`watermarkText`, the `Settings.defaultWatermark*` globals, and the per-project + global "Enable Watermarks" UI) are removed entirely, along with the FFmpeg `drawtext` watermark logic and its text validation/escaping + secure temp-file handling in `src/lib/ffmpeg.ts` (`validateAndSanitizeWatermarkText` and the `watermarkText` transcode path). Existing already-encoded previews keep any baked-in watermark; this is a going-forward change. Because version labels no longer feed watermark text, editing a version label no longer prompts a "reprocess" (the `ReprocessModal` component is deleted) — labels save directly (the S3 background-rename confirmation is unaffected). **(2) Revision tracking** — the per-video revision *cap* (`Project.enableRevisions`/`maxRevisions`), its upload-time enforcement, the "Revisions X/Y" counter, and the Revision Tracking settings section are removed. Multi-version uploads (v1/v2/v3) and version-tagged comments are unchanged — only the cap and counter are gone. **(3) Timeline previews** — the on/off toggle (`Project.timelinePreviewsEnabled`, `Settings.defaultTimelinePreviewsEnabled`, and both settings UIs) is removed; sprite/VTT scrub previews are now generated unconditionally for every video, gated only by the existing per-asset `timelinePreviewsReady` readiness flags (so the worker, the `/api/content` delivery route, and the share/admin/guest fetch paths no longer check a project toggle). The `/api/projects/[id]/timeline-previews` endpoint is kept for one-off backfill of videos processed before this change. A migration (`20260627000000_remove_watermark_revision_cap`) drops the seven dead columns. Touches `prisma/schema.prisma`, `src/lib/ffmpeg.ts`, `src/lib/validation.ts`, `src/worker/video-processor.ts`, `src/worker/video-processor-helpers.ts`, `src/worker/share-upload-preview-processor.ts`, the project/settings/share/guest API routes, and the project-settings, global-settings, share, and video-list/manager UIs.

### Fixed

- **Hold-to-2x playback no longer drops when your finger moves** — On mobile, press-and-hold on the video boosts playback to 2x, but moving your finger even slightly (while still holding) reset it back to 1x. The video surface had no `touch-action`, so the browser interpreted the move as a scroll/pan gesture and fired `pointercancel` on the captured pointer, cancelling the boost. Setting `touch-action: none` on the `<video>` element keeps the pointer captured, so 2x now persists until you lift your finger. (It also suppresses the browser's native double-tap-zoom, which keeps the new double-tap-to-seek gesture clean.) Touches `src/components/VideoPlayer.tsx`.

- **The comment timecode and its timeline marker no longer disagree** — While composing a comment, the IN/OUT brackets are meant to flank the playhead ball, but an unplaced point marker wasn't tracking the playhead: scrub the video after focusing the comment box and the brackets stayed put (e.g. at 0:22) while the timecode above the input followed the playhead (e.g. 0:52), so the marker and the time you'd actually post diverged. The point marker now rides the playhead until you deliberately place it — by dragging a handle, keyboard-nudging, or typing an exact time in the editor — at which point it detaches and stays fixed (and the timecode stays locked to it). Implemented with a `commentPointFollowsPlayheadRef` flag in `src/components/VideoPlayer.tsx`: set when a fresh point is activated on the playhead, cleared on any deliberate placement, and gating a small effect that keeps the brackets (and the comment-box timecode, via a `commentRangeChanged` emit) on the ball as it moves. Touches `src/components/VideoPlayer.tsx`.

- **Opening the admin app in a second browser window no longer forces a fresh login** — By default the admin refresh token lives in `sessionStorage` (the "Remember this device" toggle off), which is private to each tab/window, so middle-clicking a link into a new window cold-started with an empty store and bounced you to `/login`. The cross-tab `BroadcastChannel` only ever *pushed* token changes to windows already listening — a brand-new window never *asked* an open one for the current session, so it couldn't inherit one. The channel now does a startup **handshake**: a freshly-loaded, tokenless window broadcasts a `request`, any window holding a live session replies with an `offer` carrying the tokens, and the new window adopts them into its own `sessionStorage` and rotates to a fresh pair through the normal `/api/auth/refresh` flow. If no sibling answers within ~300 ms (e.g. it's the only/first window) it falls through to login exactly as before, so cold start isn't delayed. The handoff travels only over `BroadcastChannel` (same-origin, same browser profile) and the token is still never written to disk — closing every window still ends the session, preserving the existing security posture. The per-window inactivity timeout is unaffected: a window that idles out still logs out only itself (it's gated out of answering `request`s), and a stale `offer` can't clobber a window that has meanwhile logged in. Touches `src/lib/token-store.ts` (`requestSessionFromPeers` + `request`/`offer` channel messages) and `src/components/AuthProvider.tsx` (`bootstrap`).

## [2.0.9] - 2026-06-25

### Added

- **HLS-readiness now visible (and recoverable) per video in the admin project view** — HLS packaging is a non-fatal enhancement layered over the MP4 previews, so a packaging failure (e.g. a transient R2 `InternalError`) leaves the video MP4-only and the job still reports success — previously with no signal in the UI that segmented playback was missing. Each READY video version now shows an HLS status pill in the admin video list (S3 mode only): green **HLS** for a current keyframe-aligned (ABR-safe) bundle, **HLS · legacy** for a pre-alignment bundle, and an amber **MP4 only** when `hlsReady` is false. The **MP4 only** state also exposes a one-click repackage button (visible to users who can change project settings) that enqueues an `hlsOnly` job — re-packaging the bundle from the existing previews via `-c copy` with no re-transcode and no playback interruption (the video stays READY), recovering cleanly from a transient failure. The badge reads the existing `Video.hlsReady`/`hlsVersion` columns (already persisted by the worker on success/failure), now surfaced through the project payload. Touches `src/app/api/projects/[id]/route.ts` (exposes `s3Mode`), `src/app/api/videos/[id]/repackage-hls/route.ts` (new), `src/components/VideoList.tsx`, `src/components/AdminVideoManager.tsx`, `src/app/admin/projects/[id]/page.tsx`, and `src/types/video.ts`.

- **Stuck transcodes are no longer a UI dead zone — automatic recovery on worker startup + a manual clear** — If the worker is killed mid-transcode (deploy, OOM, crash), a `Video` row could stay `QUEUED`/`PROCESSING` forever: nothing reconciled it, and both the Running Jobs clear action and the Reprocess action refused to touch a `PROCESSING` row, leaving it permanently spinning. Two fixes: **(1)** a startup reconciler (`reconcileStuckVideos`, run from the worker's `main()`) flips any `QUEUED`/`PROCESSING` video that has **no** backing BullMQ job (active/waiting/delayed/prioritized) to `ERROR` so it surfaces as failed and can be reprocessed — with a 2-minute grace window so it never races a freshly-enqueued job, and leaving genuinely-`active` jobs alone so BullMQ's own stalled-job recovery can run instead. **(2)** the Running Jobs API now computes a `stalled` flag (DB says `PROCESSING` but no queue job backs it) and the clear action accepts stalled `PROCESSING` rows — re-checking the queue **server-side** so a live transcode is never cleared out from under a worker, and resetting the row to `ERROR` (not `READY`, which would present a half-finished, unplayable video as good). The Running Jobs bell renders stalled jobs with a warning icon and a "Stalled — worker stopped. Clear to reset for reprocessing." line plus the clear button. Touches `src/lib/reconcile-stuck-videos.ts` (new), `src/worker/index.ts`, `src/app/api/running-jobs/route.ts`, `src/components/RunningJobsBell.tsx`, and `src/components/UploadManagerProvider.tsx`.

### Fixed

- **No more 404s for comment-author avatars on users with default initials** — 2.0.8 made the avatar GET endpoint return a clean 404 when a user has no profile picture, but the client still *requested* `/api/users/[id]/avatar` for every USER-type comment author, so authors on default initials produced a visible failed request on every project/share page. The server now resolves which authors actually have an avatar (`getUserIdsWithAvatar`, one batched StoredFile query) and only emits `avatarUrl` for those when sanitizing comments; `InitialsAvatar` additionally confirms existence via a new always-200 `GET /api/users/[id]/avatar/exists` endpoint (session-cached, deduped across instances) before rendering the `<img>`, so no avatar request fires for an initials-only user. Touches `src/lib/stored-file.ts` (`getUserIdsWithAvatar`), `src/lib/comment-sanitization.ts`, `src/app/api/comments/route.ts`, `src/app/api/comments/[id]/route.ts`, `src/app/api/share/[token]/comments/route.ts`, `src/app/api/users/[id]/avatar/exists/route.ts` (new), and `src/components/InitialsAvatar.tsx`.

- **Admin share *preview* now also suppresses the mobile long-press "Save Video" menu** — The 2.0.8 download-affordance suppression (context-menu block, `controlsList=nodownload`, disabled PiP, touch-callout off) keyed off `!isAdmin`, so it didn't apply when an admin viewed the share *preview* — even though that view passes `hideDownloadButton` to mirror exactly what the client sees. The player now keys these off a `suppressDownloadUi = !isAdmin || hideDownloadButton` flag, so the admin preview matches the client experience while admins on their own project views keep native save. Touches `src/components/VideoPlayer.tsx`.

## [2.0.8] - 2026-06-25

### Added

- **HLS (segmented) video playback — fixes seeking behind corporate proxies that even Option B couldn't** — Some locked-down corporate networks (SSL-inspection / DLP web gateways) mangle HTTP `Range` on *any* `video/mp4` request, not just across the `/api/content`→R2 redirect — so 2.0.7's direct-from-R2 presigned URLs (Option B) still seek-reset to 0:00 for those viewers, because the proxy strips `Range` on the direct R2 request too. The robust fix is to stop relying on Range entirely and deliver video as **HLS**, exactly like YouTube: the stream is split into small fMP4 segments fetched as ordinary full-file `200` GETs (seeking = "fetch a different segment"), which corporate proxies handle fine. **Packaging:** the worker remuxes the existing 480p/720p/1080p MP4 previews into a per-rendition HLS playlist + fMP4 (CMAF) segments plus a `master.m3u8`, using a stream copy (`ffmpeg -c copy`) — no re-encode, no quality loss, near-identical bytes, negligible extra CPU. Output is ID-keyed under `previews/{projectId}/videos/{videoId}/hls/` and registered in `StoredFile` as new `HLS_PLAYLIST` / `HLS_SEGMENTS` roles. **Delivery (minimal app egress):** segments are streamed **direct-from-R2** via presigned URLs, so the heavy bytes never touch the app and keep R2's free egress; only the tiny `.m3u8` playlists pass through a new same-origin, token-gated `/api/hls/{token}/…` endpoint, which rewrites variant URIs to same-origin and segment URIs to presigned R2 URLs (rendered playlist cached in Redis per session so segments are presigned once, not per fetch). **Player:** `VideoPlayer` now plays via `hls.js` on desktop (incl. desktop Safari) and native HLS on iOS Safari, preferring the HLS master playlist whenever the server provides one and falling back to the existing MP4 stream URLs otherwise; the manual quality selector maps to hls.js levels, and on keyframe-aligned bundles "Auto" hands control to hls.js bandwidth-based adaptive bitrate (see the dedicated entry below); legacy non-aligned bundles stay pinned, gated by a `hlsVersion` marker. The forward buffer is capped (~30 s, no growth) so playback fetches segments as it plays rather than prefetching the whole file — hls.js defaults would download any clip under ~60 MB entirely on open, wasteful for a review tool where reviewers open a video briefly and jump around by timecode; seeking still fetches the target segment on demand. Fatal hls.js errors (e.g. an expired presigned segment URL on a >4h session) route into the existing token-refresh recovery, which re-mints a fresh playlist. **Rollout:** HLS is additive and gracefully degrades — videos without a packaged bundle just use MP4. New uploads are packaged automatically (S3 mode); existing videos are backfilled with `npx tsx scripts/backfill-hls.ts`. Gated by a new `STREAM_HLS=false` kill-switch (no-redeploy revert to MP4), and requires a one-time R2 CORS rule allowing `GET` from the app origin (hls.js fetches segments via XHR). **Lifecycle integration:** the new `HLS_SEGMENTS` directory-style role is wired into every system that special-cases the `TIMELINE_SPRITES` directory pattern — the storage-orphan cleanup protects the whole `hls/` prefix from deletion (the segments are not individually registered) and excludes the directory row from the missing-files check; project preview-bytes accounting (S3 prefix sum + local disk walk) and the project storage-overview breakdown count the HLS tree under "video previews"; the S3↔local backup enumerates and backs up the segment files; and the packager wipes the prior HLS bundle before regenerating (and both reprocess routes also delete it up front) so a shrinking rendition set — e.g. a resolution removed from project settings then reprocessed — can't leave stale segments, regardless of how packaging was triggered. Video/project deletion already removes it (the `hls/` dir lives under the ID-keyed previews tree). Touches `src/lib/ffmpeg.ts` (`packageHlsRendition`), `src/worker/video-processor-helpers.ts` (`processHlsPackaging`), `src/worker/video-processor.ts`, `src/lib/queue.ts`, `src/lib/project-storage-paths.ts`, `src/lib/video-stream-url.ts`, `src/app/api/hls/[token]/[[...path]]/route.ts` (new), the share/admin/guest token routes, `src/components/VideoPlayer.tsx`, `src/types/video.ts`, the share/guest player pages, `prisma/schema.prisma` (+ migration), and `scripts/backfill-hls.ts` (new).

- **Adaptive bitrate (automatic quality switching) for HLS** — Video previews are now transcoded with forced, scene-cut-free keyframes at a fixed 2 s interval (`-force_key_frames "expr:gte(t,n_forced*2)"` + `-x264-params scenecut=0`), so every rendition's `-c copy` HLS segments share identical boundaries (verified: matching keyframe timestamps and segment durations across resolutions) — the prerequisite for seamless mid-stream switching. The player now enables hls.js bandwidth-based ABR for **"Auto"** on aligned bundles, and the `Auto (xxx)` label tracks the level hls.js actually plays (via `LEVEL_SWITCHED`); a manual quality pick still pins a level. A `Video.hlsVersion` marker gates it — only bundles packaged at the current version (keyframe-aligned) auto-switch, so legacy bundles can't glitch — surfaced to the player as an `hlsAbr` flag on the share/admin/guest token payloads. Because alignment lives in the *encode*, upgrading an existing library is a full re-transcode rather than a repackage: `scripts/backfill-hls.ts` now enqueues a full reprocess for every video below the current version (idempotent). Touches `src/lib/ffmpeg.ts` (`alignKeyframes`), `src/worker/video-processor-helpers.ts`, `src/worker/video-processor.ts`, `src/lib/video-stream-url.ts` (`HLS_PACKAGE_VERSION`/`hlsAbrReady`), the share/admin/guest token routes + player pages, `src/components/VideoPlayer.tsx`, `prisma/schema.prisma` (+ migration), and `scripts/backfill-hls.ts`.

- **HLS playback extended to video *assets*** — Video assets (files attached to a version) get a single MP4 playback preview served the same Range-prone way, so they had the same seek-behind-proxy problem. They now also get an HLS bundle: the worker packager was generalised to any entity (`packageHlsBundle`), assets are packaged right after their MP4 preview (single rendition — no ABR, but the seeking fix and direct-from-R2 segments apply), under `…/assets/{assetId}/hls/`. The `/api/hls` endpoint serves asset bundles (the access token carries `entityType:'asset'`), and the asset download-token route returns an `hlsUrl`. A new shared `useHlsVideo` hook + `HlsVideo` component (extracted from the main player's hls.js logic, HLS detected by the `.m3u8` URL) back the `ShareFilesBrowser` lightbox used on both the client share and admin share-preview pages, which now prefer the asset `hlsUrl`. Asset HLS is wired into the full lifecycle too — reprocess (both routes), asset deletion, and close-project purge clean the asset `hls/` tree; orphan cleanup, backup, and preview-bytes accounting already covered it (entity-agnostic by role). `copy-to-version` is unchanged (the copied asset uses its MP4 fallback; reprocess regenerates HLS). Audio assets are unaffected (download-only, no player); voice notes stay on their existing path (short, fully-buffered, Range-immune in practice). Touches `src/worker/video-processor-helpers.ts`, `src/worker/share-upload-preview-processor.ts`, `src/lib/project-storage-paths.ts`, `src/app/api/hls/[token]/[[...path]]/route.ts`, the asset download-token route + share/admin-share resolvers, `src/hooks/useHlsVideo.ts` (new), `src/components/HlsVideo.tsx` (new), `src/components/ShareFilesBrowser.tsx`, and the reprocess/deletion/close-project lifecycle routes.

### Fixed

- **User-avatar endpoint no longer 302-redirects to a missing file in S3 mode** — `GET /api/users/[id]/avatar` falls back to a guessed `users/{id}/avatar.jpg` path when no avatar is registered, but in S3 mode it presigned and redirected to that path **without checking the object exists** — so a user with no avatar (e.g. a commenter on default initials) produced a redirect to a presigned R2 URL that then 403'd in the browser (the `avatar.jpg (failed)` request visible on share pages). It now `s3FileExists()`-checks before redirecting and returns a clean 404 so the client falls back to initials. The local-disk branch already stat-and-404'd correctly. Touches `src/app/api/users/[id]/avatar/route.ts`.
- **Stronger suppression of the mobile long-press "Save/Download Video" menu on the share player** — The main `VideoPlayer` now mirrors the asset lightbox's proven recipe: `onContextMenu` preventDefault on both the `<video>` and its wrapper, plus `controlsList="nodownload noplaybackrate noremoteplayback"` and `disablePictureInPicture` (non-admin only). This reliably blocks the menu in mobile Chrome/Samsung Internet; a fully native in-app WebView can still draw its own long-press menu that page code cannot intercept. Touches `src/components/VideoPlayer.tsx`.

### Changed

- **Removing a preview resolution from project settings now deletes that resolution's previews** — Previously, unticking e.g. 1080p only cancelled in-flight jobs and changed what future processing generated; the existing 1080p MP4 (and, once HLS shipped, its HLS rendition) were left orphaned in storage. The project-settings update now deletes the removed resolution's `PREVIEW_*` files + StoredFile rows for every video in the project, and makes HLS match: ABR-ready (keyframe-aligned) bundles are repackaged from the remaining previews via a cheap `-c copy` remux so the master drops the removed rendition, while legacy non-aligned bundles are deleted outright (repackaging would falsely stamp them ABR-ready; they rebuild correctly on the next full reprocess). Storage totals refresh immediately. Re-adding a resolution later re-encodes it. Touches `src/app/api/projects/[id]/route.ts`.

### Known limitations

- **Storage roughly doubles for previews** when HLS is packaged (the `-c copy` segments are ≈ the MP4 bytes). HLS is only generated in S3 mode. Forced keyframes every 2 s also add a small amount to preview size vs. scene-cut keyframing.

## [2.0.7] - 2026-06-25

### Changed

- **Mobile edge-swipe project navigation: corrected direction, live drag feedback, and an iOS-style page transition** — Refines the edge-swipe navigation added in 2.0.6. **Direction reversed** to match the natural back/forward mental model: dragging in from the **left** edge now goes **back** (project → projects dashboard; share page → project), and dragging in from the **right** edge goes **forward** (project → share page). (The 2.0.6 mapping was the opposite, which read backwards.) **The page now follows your finger as you drag** — the content surface translates live (with light resistance) so it's obvious the gesture is registering, and releasing short of the commit threshold springs it back. **Committing now plays a directional push/pop transition** instead of a hard cut: the outgoing page slides the rest of the way off-screen in your drag direction while the incoming page slides in from the opposite edge. Because the outgoing page unmounts on navigation, the two halves are coordinated through a one-shot "pending direction" (`src/lib/swipe-page-transition.ts`, new) that the gesture sets on commit and the persistent admin layout consumes once the next route mounts, sliding it in. Respects `prefers-reduced-motion` (falls back to instant navigation) and stays touch-only / no-ops on desktop. The transition is scoped to swipes — normal menu/back-button navigation is unaffected. A dedicated translatable surface (`#admin-content-surface`) was added inside the admin layout's existing `overflow-x-hidden` container so the slide never introduces a horizontal scrollbar. Touches `src/hooks/useEdgeSwipeNavigation.ts`, `src/lib/swipe-page-transition.ts` (new), `src/app/admin/layout.tsx`, `src/app/admin/projects/[id]/page.tsx`, `src/app/admin/projects/[id]/share/page.tsx`.

### Fixed

- **Video seeking no longer resets to the start behind some corporate proxies (S3/R2 mode)** — On locked-down corporate networks, seeking to a position and pressing play could snap the video back to 0:00, both on the client share page and guest-video-only links. Root cause was transport-level: in S3 mode the `<video>` element's source (`/api/content/{token}`) issues a **302 redirect to a presigned R2 URL**, and some corporate proxies/SSL-inspection appliances do not carry the HTTP `Range` header faithfully across that cross-origin redirect — so a seek returns the whole file with `200` instead of `206 Partial Content`, and playback restarts. (Confirmed network-layer: it reproduced on guest links, which have no token-refresh recovery logic, and only on that client's multi-egress proxy network — never locally.) **Option B fix:** in S3 mode the share `video-token` and guest-video-link endpoints now hand the player a **direct presigned R2 stream URL** for the main video qualities (480p/720p/1080p/original), removing the redirect hop entirely — the browser streams straight from R2 with native `Range`/`206` support. The same treatment is applied to **video asset playback previews** (the lightbox player for video assets, served via `assetPlayback=1`), which took the identical redirect. Thumbnails, timeline VTT/sprites, and downloads deliberately keep flowing through `/api/content` so their per-request gating and analytics are preserved, and the static "video version watched" analytics event (`POST /api/track/video-view`, fired on play) is unaffected — only the live per-range streaming heartbeat is lost. Access is authorized once at URL-issue time (approval/quality rules unchanged); the trade-off is no per-range revocation within the URL's TTL and coarser live streaming analytics. Local-disk mode is unchanged (it already streams same-origin `206`s). A new `STREAM_DIRECT_FROM_R2=false` env var reverts to the redirect without a redeploy. Quality→path resolution is now shared between the delivery route and the token endpoints (`src/lib/video-stream-url.ts`) so the two can't drift. Touches `src/lib/video-stream-url.ts` (new), `src/app/api/content/[token]/route.ts`, `src/app/api/share/[token]/video-token/route.ts`, `src/app/api/guest-video-links/[token]/route.ts`, `src/app/api/videos/[id]/assets/[assetId]/download-token/route.ts`, and `src/app/share/[token]/page.tsx`.
- **Long-pressing a playing video on mobile no longer pops the "Save/Download Video" callout** — On the client share page, holding on the video to engage the 2× speed-boost gesture would eventually trigger the browser's native long-press media menu (offering to download the video). The player already blocked the desktop right-click menu via `onContextMenu`, but that doesn't cover iOS Safari's touch callout; the video element now also sets `-webkit-touch-callout: none` (plus `user-select: none` and `controlsList="nodownload"`) for non-admin viewers, suppressing the callout while leaving the pointer-event-based speed-boost gesture intact. Touches `src/components/VideoPlayer.tsx`.

## [2.0.6] - 2026-06-25

### Added

- **Mobile edge-swipe navigation between a project, its share page, and the projects list** — On touch devices you can now move through the project pages with horizontal edge swipes instead of reaching for the breadcrumb buttons. On the project detail page, dragging in from the left edge opens the project's Share page (forward), and dragging in from the right edge returns to the projects dashboard (back); on the Share page, dragging in from the right edge returns to the project. Gestures only register when they *start* within ~32px of a screen edge, so they don't hijack the video scrubber, wide tables, or other interior horizontal-scroll surfaces, and they no-op entirely on fine-pointer (desktop) devices. The swipe-to-Share is suppressed when the viewer lacks share access or the project is closed (matching the visible Share button), and the swipe-back from the Share page honors the unsent-comment guard so an accidental flick can't silently discard a draft. New reusable `useEdgeSwipeNavigation` hook (`src/hooks/useEdgeSwipeNavigation.ts`); touches `src/app/admin/projects/[id]/page.tsx` and `src/app/admin/projects/[id]/share/page.tsx`.
- **Invoices now show amount paid and remaining balance everywhere a client or admin sees the totals** — When an invoice has any counted payments (manual `SalesPayment` rows that aren't excluded from the balance, plus Stripe payments), the totals block now renders an "Amount paid" line and a bold "Balance due" line beneath the Total, on all three surfaces: the admin Invoice Details page, the public HTML web view, and the generated/emailed PDF. The figure is the sum of all payments, and the balance is `total − paid` (floored at zero). The underlying paid total already drove the `Partially Paid` / `Paid` status; this just surfaces the numbers. A shared `aggregateInvoicePaidCents()` helper (`src/lib/sales/invoice-paid.ts`) centralises the local+Stripe payment aggregation (used by the public view and the send-email route; the reminders worker and admin page already had the figure), and the PDF renderer gained an `amountPaidCents` field on `PdfPartyInfo`. Touches `src/lib/sales/pdf.ts`, `src/lib/sales/invoice-paid.ts`, `src/app/sales/view/[token]/page.tsx`, `src/app/sales/view/[token]/public-sales-doc-actions.tsx`, `src/app/admin/sales/invoices/[id]/page.tsx`, `src/app/api/admin/sales/send-email/route.ts`, `src/worker/sales-reminders.ts`.

### Changed

- **Quote and invoice PDFs have a refreshed, more polished layout** — The generated documents share a single renderer now (the two builders were ~95% duplicated) and use a neutral charcoal accent — deliberately brand-agnostic so it sits well beside any logo — across the line-items table header and an emphasised, filled "Total" panel. The table uses zebra-striped rows (alternating subtle tint) instead of per-row hairlines, the column header text is inset from the bar edge, the tax column is de-emphasised in muted grey, and a hairline rule separates the company/recipient masthead from the body. Line spacing in the masthead and payment-details blocks is tighter, the masthead title is a clean near-black (no accent rule), and both the "Accept Quote" and "Pay Invoice" calls-to-action are now rounded-corner buttons in the app's darker `--success-solid` green so they clearly read as buttons. Row density was tuned so typical documents still fit on a single page. Purely a visual refresh — no change to the figures, fields, links, or pagination behaviour. Touches `src/lib/sales/pdf.ts`.

### Fixed

- **The installed admin PWA no longer launches with Chrome's URL bar showing on first open (Android)** — The manifest `start_url` was `/admin/`, but that route renders nothing and immediately client-side `router.replace()`s to the user's landing page (`/admin/projects`), or to `/login` — which is outside the `/admin/` scope — when the session check hiccups on a cold launch. Android Chrome only grants the borderless standalone window when the launched URL settles in-scope without bouncing, so the launch-time redirect left the address bar visible until a manual refresh reloaded the (in-scope, redirect-free) current URL. `start_url` now points directly at `/admin/projects` so the common case lands without a redirect; `id` stays `/admin/`, so existing installs keep their identity. The `/admin/` index page retains its permission-based routing as a fallback for direct navigation. Touches `public/admin/manifest.webmanifest`.
- **Dragging the playhead and comment IN/OUT markers now shows a reliable scrub preview on touch devices (client + admin share pages)** — On mobile the drag preview was erratic: a single frozen frame, or no image at all. Two causes: the IN/OUT marker drag never forced the preview, so on touch (where the hover-capable check is false) the preview helper bailed out and showed nothing; and during any drag the preview painted the live video frame onto a `<canvas>`, but drawing a paused, rapidly-seeking video to canvas is unreliable on mobile (stale or blank frame). Marker drags now force the preview like the playhead scrub already did, and the live-frame canvas is used only on desktop — touch devices fall back to the sprite tile (a static image lookup that always renders, and now denser at one every 2s), so the preview tracks the drag on mobile. The canvas draw loop is also skipped entirely on touch. Touches `src/components/VideoPlayer.tsx`.

## [2.0.5] - 2026-06-24

### Changed

- **Removed the dormant light theme — the UI is now dark-only at the stylesheet level (no visual change)** — The app has always rendered dark (the root `<html>` was hard-pinned to `.dark` and `useTheme` always returned `{ theme: 'dark' }`), but `globals.css` still carried a full light `:root` palette and ~120 `dark:` Tailwind overrides whose light base never rendered. Collapsed the dual `:root`(light)/`.dark` theme blocks into a single dark `:root`, stripped every `dark:` variant down to its dark value across 36 component/page files, removed the `dark` class from `<html>`, simplified the accent-colour override generator to emit one `:root` block, de-scoped the dark-only date-picker CSS, and deleted the now-unused `src/hooks/useTheme.ts`. Purely a cleanup — rendering is identical. Touches `src/app/globals.css`, `src/app/layout.tsx`, `tailwind.config.ts`, `src/hooks/useTheme.ts` (deleted), and 36 component/page files.
- **Destructive, warning and success states now use the design tokens consistently instead of hard-coded Tailwind palette shades** — Swept the codebase for stray `red/orange/amber/yellow/green/emerald` utilities used for semantic state and routed them through the `destructive` / `warning` / `success` tokens: error messages and the notifications-bell badge/error rows, the "newer version available" labels, the busy/processing ring accents on the video & album managers, the unmatched-transaction and possible-duplicate accounting warnings, success confirmation messages, completion check icons and upload "done" indicators, and the approve buttons. Categorical/data-encoding colours (accounting account-type maps, P&L sign colouring, project-status and sales badges, chart gradients, avatar palettes) were deliberately left alone. Touches many components and admin pages.
- **Solid success backgrounds use a dedicated darker-green token so white text stays legible** — The bright `--success` green is tuned as a foreground accent (check icons, status dots, `text-success` labels) and drops below readable contrast under white text when used as a large solid fill. Added a `--success-solid` token (a darker green, ~5:1 contrast with white) used by `.btn-success` (every `variant="success"` button) and the approved-video check badge, while `--success` stays vivid for accents and `--success-visible` remains the subtle tinted-surface shade. Touches `src/app/globals.css`, `tailwind.config.ts`, `src/components/VideoSidebar.tsx`.

- **Derived previews are now stored under a stable, ID-keyed `previews/{projectId}/…` tree instead of a `.previews` folder inside each project, so renames no longer move them (fixes flaky S3 renames)** — Every preview derivative (transcoded MP4 previews, thumbnails, timeline VTT+sprites, video-asset image/playback previews, share-upload previews, album-photo thumbnails) used to live in `.previews/` mirrored under the project's name-based path (`clients/{client}/projects/{project}/.previews/videos/{folder}/{version}/…`). Renaming a client/project/video/album therefore forced a physical move of the whole preview mirror; on S3 (no native rename) that's a slow, non-atomic copy-then-delete that was wrapped in a "non-fatal" catch — so a partial failure left `StoredFile` rows rebased to a location the files never reached, breaking thumbnails. Previews now live at `previews/{projectId}/videos/{videoId}/…`, `previews/{projectId}/uploads/{uploadFileId}/…` and `previews/{projectId}/album-photos/{albumPhotoId}/…`, keyed by stable cuids and outside the name-based tree, so renames touch **zero** preview files. `StoredFile` remains the single source of truth for these paths (readers resolve from it; `projectId` is still derived from the owning entity, so `renameStoredPaths`' prefix substitution correctly leaves preview rows untouched). The bulk of the rename worker's preview-move + stale-prefix-recovery code is removed, and project deletion now also clears `previews/{projectId}/`. Album-photo `-social.jpg` derivatives are unchanged (they live beside the original and move with the album folder). **Migration:** existing `.previews` files keep serving until regenerated — run "Regenerate previews" per project (or full reprocess) to write previews to the new locations, then run Storage → orphan cleanup to sweep the old `.previews/*` files. Touches `src/lib/project-storage-paths.ts`, `src/worker/{video-processor-helpers,share-upload-preview-processor,asset-upload-timeline-processor,album-photo-thumbnail-processor,folder-rename-processor}.ts`, `src/lib/{album-photo-upload-finalize,project-storage-orphan-cleanup}.ts`, and the videos/albums/content/share-upload/copy-to-version routes.
- **Separate share-link password emails are now sent by the background worker (staggered, durable) and show up in analytics** — Previously the notify route blocked the admin's HTTP request with an in-process 10-second `sleep` before sending the password emails inline, so a client/proxy timeout or a web-process restart during that window could leave the link delivered but the password never sent — and password sends were invisible to analytics (no sent event, no open tracking). The password send is now enqueued as a delayed (`10s`) BullMQ job (`password-email` queue + processor) that returns the request immediately, survives restarts, and retries on failure. It also records a `PASSWORD` project email event ("sent") and a per-recipient open-tracking pixel (when tracking pixels are enabled), surfaced in project analytics as "Project Password". Touches `src/lib/queue.ts`, `src/worker/password-email-processor.ts`, `src/worker/index.ts`, `src/lib/email.ts`, `src/app/api/projects/[id]/notify/route.ts`, `src/app/api/analytics/[id]/route.ts`.
- **Email sending now reuses a pooled SMTP connection instead of opening a fresh connection per email** — `createTransporter` built a brand-new nodemailer transport (full TCP+TLS+AUTH handshake) on every `sendEmail` call, so a single multi-recipient notification fired one simultaneous SMTP connection per recipient — which large recipient lists and stricter providers throttle or refuse. Sends now share a memoized pooled transporter (`maxConnections` 5, `maxMessages` 100 by default; tunable via `SMTP_POOL_MAX_CONNECTIONS` / `SMTP_POOL_MAX_MESSAGES`), so concurrent sends are bounded at the transport layer. The pool is keyed on a signature of the SMTP connection fields and rebuilt automatically when they change, so both the web app (which also calls `invalidateEmailSettingsCache()`) and the worker pick up SMTP setting changes within one 30s settings-cache window. The one-off SMTP connection test still uses a throwaway non-pooled transport. Touches `src/lib/email.ts`.

### Fixed

- **Storage overview now reports "Video previews" correctly in local (disk) storage mode** — When derived previews moved to the ID-keyed `previews/{projectId}/…` tree (see the Unreleased "Changed" note), the local-mode storage figures stopped adding up. Local `previewBytes` was never reconciled (it was treated as S3-only), and the settings Storage Overview estimated previews as `diskBytes − totalBytes` — an estimate that silently collapsed to ~0 because `computeProjectDiskBytes()` only walks the name-based project tree (which no longer contains previews) while `project.totalBytes` *does* count them (preview `StoredFile` rows carry real `fileSize` on local disk). `computeProjectPreviewBytes()` now measures the `previews/{projectId}` subtree on disk in local mode (capturing sprite sheets, which have no per-file size), `previewBytes` is reconciled and persisted in **both** storage modes (nightly + after each preview generation), and both the global Storage Overview and the per-project storage view read the reconciled `previewBytes` column. The grand total is unchanged in either mode: S3 adds `previewBytes` (preview rows have null size, so they're not already in `totalBytes`), local does not (they already are) — fixing a latent double-count that would have appeared once local previews were measured. **`diskBytes` now also includes the `previews/{projectId}` subtree** so it reflects the project's true on-disk footprint — the dashboard "Data" total and the project page "Project Data" figures (which read `diskBytes` in local mode) now include preview/thumbnail/timeline storage instead of omitting it. Touches `src/lib/project-total-bytes.ts`, `src/app/api/settings/storage-overview/route.ts`, `src/app/api/projects/[id]/storage/route.ts`.
- **Removed the unused `GET /api/videos/[id]/download` route** — A legacy direct-download endpoint with no callers (the app downloads via short-lived tokens through `/api/content/[token]?download=true`). It also had no S3 branch, so it only ever worked in local storage mode and would have 500'd under S3 — dead code superseded by the storage-agnostic token path. Also removed a duplicate `existsSync` check in `src/app/api/content/[token]/route.ts` and a no-op ternary in `src/lib/storage.ts`. Touches `src/app/api/videos/[id]/download/route.ts` (deleted), `src/app/api/content/[token]/route.ts`, `src/lib/storage.ts`.
- **The manual "Comment Summary" send and the scheduled worker can no longer double-send the same summary** — Both pull the same pending `NotificationQueue` rows, but the manual path used its own all-or-nothing recipient loop (throwing on the first failed address) and a `|manual`-salted batch hash, so its idempotency markers weren't shared with the worker — a manual send overlapping a scheduled run (or following a partial failure) could re-email recipients who already received it. The manual client/admin sends now route through the same per-recipient idempotent helper as the worker, compute the identical batch hash (so Redis skip-markers are shared across both paths), and both paths take a short Redis advisory lock (`notif:lock:client:{projectId}` / `notif:lock:admin`, 2-minute TTL) so they can't run for the same scope concurrently. If a manual send finds the lock held, it reports that the summary is already being sent rather than firing a duplicate. Touches `src/worker/notification-helpers.ts`, `client-notifications.ts`, `admin-notifications.ts`, `src/app/api/projects/[id]/notify/route.ts`.
- **Scheduled notification summaries no longer re-email recipients who already received them when another recipient in the same batch fails** — Send state on `NotificationQueue` is tracked per batch, not per recipient, and the worker's send loops threw on the first failed address, so the whole batch was marked unsent and retried — re-mailing everyone who had already received the summary (every 2 minutes on the fast-retry path). All four scheduled processors (client, admin, internal-comment, task-comment) now send via a shared per-recipient idempotent helper that records each success in Redis and skips already-sent recipients on retry, while still attempting every remaining recipient before surfacing failure. Also fixes the task-comment processor silently logging failed sends as "Sent" (it awaited `sendEmail`, which returns `{ success }` rather than throwing). Touches `src/worker/notification-helpers.ts`, `client-notifications.ts`, `admin-notifications.ts`, `internal-comment-notifications.ts`, `task-comment-notifications.ts`.
- **Dragging a comment IN/OUT marker into the playhead snap zone now "holds" like the playhead-to-marker snap does (admin + client share player)** — Both snaps committed the snapped time correctly, but the marker drag updated its on-screen preview from the raw cursor position, so the displayed time jiggled on the slightest move inside the snap zone and only settled back to the snapped value on release — clunky compared to the playhead snap, which holds steady until you pull past the threshold. The IN/OUT drag now drives the preview from the committed snapped time while snapped (matching the playhead path), so the time holds until you drag clear of the snap zone. Touches `src/components/VideoPlayer.tsx`.

## [2.0.4] - 2026-06-24

### Changed

- **Comment IN/OUT markers are now solid rectangles flanking the playhead ball (admin + client share player)** — When you start a comment, the IN/OUT markers previously opened with a duration-percentage time gap between them, which could be misleading (the same gap meant very different amounts of time depending on the video length). Both markers now start as a single point at the playhead and are drawn as solid amber rounded rectangles whose inner edges sit at the current time (IN's right edge, OUT's left edge), with the round playhead ball rendered centered on top of the join. The markers stand slightly proud of the bar and keep marking their points as you drag out a range. The scrub bar is also now inset by a fixed pixel amount on both ends (`TIMELINE_EDGE_INSET_PX`) so the playhead ball and the markers render fully at 0:00 and the end of the video instead of being clipped at the edges. The ball sits above the markers (so the playhead stays grabbable), while each marker stays grabbable on the part that extends outward beyond the ball. Touches `src/components/VideoPlayer.tsx` (marker size is the tunable `RANGE_HANDLE_WIDTH_PX` / `RANGE_HANDLE_HEIGHT_PX`).
- **The playhead and comment IN/OUT handles now show a coloured frame preview on hover as well as while dragging (admin + client share player)** — The unmistakable framed scrub preview previously only appeared mid-drag. It now also shows when you simply **mouse over** the playhead thumb or a comment IN/OUT handle: the playhead uses the **primary app colour** with a "PLAYHEAD POSITION" label, and the IN/OUT handles use the amber range colour with "Comment start point" / "Comment end point". Crucially, on hover the preview is anchored to the element's **true stored timecode**, not the cursor position — the IN/OUT handles are rendered slightly apart on the bar for visual clarity, so their on-screen position doesn't exactly match their real timecode, and hovering now reveals the exact point each one represents before you drag. Until you've dragged out an explicit range, the IN and OUT handles both represent the single point at the playhead, so hovering either one shows the playhead's time (rather than the OUT handle's offset visual position). An active drag still takes priority over a hover, and the cue falls back to an anchored framed label + time badge when timeline sprites are unavailable. Hovering the "Clear time range" ✕ shows the same framed preview in the **destructive red** with a "CLEAR TIME RANGE" label (and its plain browser tooltip is removed in favour of this cue). (A range-handle drag also no longer leaves the scrub preview "pinned" open after you stop hovering the bar — the pin is cleared on drag end.) **While actively dragging a handle or scrubbing the playhead, the preview now paints the exact live video frame onto a canvas instead of the timeline sprite** — the sprite sheet is too coarse to track scene changes mid-drag, so it could lag the real frame; the canvas matches the main player exactly. Passive hover still uses sprites (it doesn't seek the playing video). Touches `src/components/VideoPlayer.tsx`.
- **The playhead and comment IN/OUT handles are now subtly "sticky" to each other while dragging (admin + client share player)** — Lining a range handle up with the playhead (or the playhead up with a marker) was fiddly. Dragging a comment IN/OUT handle now gently snaps it to the playhead, and — when a comment range is active — dragging the playhead gently snaps it to the nearest IN/OUT handle, in both cases when the cursor comes within ~6px of the target. It's noticeable enough to catch reliably, but small enough that you can still place things just before or after. Thresholds scale with the timeline width. The handle→playhead snap targets the live playhead value (`currentTimeRef`) the on-screen playhead/timecode uses, so a handle snapped to the playhead now reports the **exact same timecode to the frame** (previously it snapped to a frozen drag-start reference that could be a couple of frames off, so e.g. the OUT marker read `…:17:09` while the playhead showed `…:17:11`). Touches `src/components/VideoPlayer.tsx`.
- **The "Clear time range" ✕ is now hidden whenever a timeline preview is showing (admin + client share player)** — The dismiss ✕ that floats above the OUT handle stayed visible during interactions, where it could sit under the cursor/preview and get in the way. It is now hidden while dragging a range handle, dragging the playhead, or hovering the playhead/IN/OUT handle, and reappears once the preview clears. Touches `src/components/VideoPlayer.tsx`.

## [2.0.3] - 2026-06-23

### Changed

- **Timeline now has a YouTube-style draggable playhead thumb (admin + client share player)** — The video scrub bar previously showed only a coloured progress fill with no visible handle at the current position. It now renders a round thumb at the playhead that grows when hovered directly and is grabbable (a press on the thumb bubbles to the bar's existing pointer handlers, so dragging it seeks like dragging the bar). The thumb sits below the comment IN/OUT range handles so those remain easy to grab, and it only enlarges on its own hover (not when hovering anywhere along the bar). Touches `src/components/VideoPlayer.tsx`.
- **Comment range handles now show a clear labelled preview while dragging (admin + client share player)** — Dragging the IN/OUT markers on the video timeline gave no explicit indication of what the handle did, which confused some clients. While a range handle is being dragged, the timeline scrubbing preview now renders with a thick amber frame and tint matching the range colour, an amber-coloured timestamp, and a labelled header reading "Comment start point" or "Comment end point" depending on which handle is active. When timeline sprites are unavailable (so there's no scrub preview), an equivalent amber-framed label + time badge is shown anchored to the dragged handle, so the cue is identical with or without sprites. The plain preview styling is unchanged for normal scrubbing. Touches `src/components/VideoPlayer.tsx`.
- **Approved videos now show "Comments are now closed" above the existing thread (admin + client share player)** — When a video/project was approved the comment input is hidden, but if the thread already had comments there was no indication that commenting had closed — the "This video has been approved. Comments are now closed." copy only appeared on an empty thread. The closed notice now renders as a labelled, lock-iconed section divider at the top of the comment list whenever comments are disabled and comments exist (using the project- vs. video-approved wording already used in the empty state). The empty-state placeholder circle above that message is now a lock icon for the closed case too. Touches `src/components/CommentSection.tsx`.

### Fixed

- **"Project approval confirmation" toggle is now honoured when an admin manually marks a project APPROVED** — The Admin → Settings → Client System Emails "Project approval confirmation" toggle (`clientEmailProjectApproved`) was respected on the client-driven approval path (`/api/projects/[id]/approve`), but the admin status-change path that fires when you set a project's status to APPROVED in the project page sent the client "Project Approved" email unconditionally, ignoring the toggle. The admin path now reads `clientEmailProjectApproved` alongside the auto-close settings and skips the client email when it is disabled (logging `Skipped - clientEmailProjectApproved is disabled`), matching the client-driven path. Touches `src/app/api/projects/[id]/route.ts`.

### Removed

- **QuickBooks Online integration removed** — The pull-only QuickBooks (QBO) integration has been removed entirely. This deletes the QBO OAuth connect flow, the Sales → Settings → "Quickbooks Integration" tab and the "QuickBooks Actions" panel on the Sales dashboard, the `/api/sales/quickbooks/*` routes (auth, health, settings, imports, and the customer/quote/invoice/payment pulls), the QBO import-detail pages under `admin/sales/{invoices,quotes}/imports/[id]`, and the worker's `quickbooks-refresh-token` and `quickbooks-daily-pull` scheduled jobs (the worker now purges any stale repeatable QBO jobs left in Redis on boot). The QBO failure push-notification type (`QUICKBOOKS_DAILY_PULL_FAILURE`) and the `QBO_*` / `QUICKBOOKS_*` environment variables (documented in `.env.example`) are gone. Migration `20260623000000_remove_quickbooks` drops the five QBO staging tables (`QuickBooksIntegration`, `QuickBooksEstimateImport`, `QuickBooksInvoiceImport`, `QuickBooksPaymentImport`, `QuickBooksPaymentAppliedInvoice`). The sales records themselves are unaffected: the `qboId` columns on `SalesQuote`/`SalesInvoice`/`SalesPayment`, the `Client.quickbooksCustomerId` column, and the `SalesPaymentSource.QUICKBOOKS` enum value are intentionally retained as inert historical identifiers, so previously-imported quotes/invoices/payments remain intact. Also removes the now-orphaned `src/lib/sales/server-native-store.ts` (no importers). Touches `prisma/schema.prisma`, `src/worker/index.ts`, `src/app/admin/sales/page.tsx`, `src/app/admin/sales/settings/page.tsx`, `src/lib/pinned-system-notifications.ts`, `src/lib/push-notifications.ts`, `.env.example`, and deletes `src/lib/quickbooks/`, `src/lib/sales/server-qbo-merge.ts`, and the `src/app/api/sales/quickbooks/` routes.

## [2.0.2] - 2026-06-22

### Changed

- **Desktop share-sidebar thumbnails now scale with the sidebar width (client + admin)** — On both share pages (`share/[token]` and the admin `projects/[id]/share` preview) the desktop VideoSidebar's Videos, Albums and Uploads thumbnails were fixed-size (64×36 video/album tiles, an 80px Uploads folder mosaic) regardless of how wide the sidebar was dragged. They now scale proportionally with the sidebar width, with the previous sizes kept as the minimum (the scale floors at 1.0 at the default 256px width), so widening the sidebar enlarges every thumbnail in step. The Uploads folder mosaic was also resized to match the video/album thumbnail width (previously larger), and the folder "tab" lip in `FolderPreviewMosaic` is now sized as a fraction of the card (`w-[30%]`/`left-[5%]`) instead of a fixed `w-16`/`left-3` so it scales with the folder and no longer overflows narrow tiles — this also keeps the tab proportional in the FILES browser folder grid across breakpoints. Touches `src/components/VideoSidebar.tsx` and `src/components/FolderPreviewMosaic.tsx`.

### Fixed

- **Thumbnail grids load much faster on first open (S3 mode), app-wide** — Opening a project detail page, a photo album, or a client share page could take several seconds to show its thumbnails when storage is S3/R2-backed. Each thumbnail `<img>` pointed at `/api/content/...`, which on every request re-verified the token, ran several DB/Redis lookups, made an existence `HeadObject` call to R2, and finally **302-redirected** to a presigned R2 URL — so each tiny thumbnail cost two sequential network hops through the app server, all competing for the browser's ~6-connections-per-origin budget. Now every list/payload endpoint that renders a thumbnail grid **presigns the R2 URLs up front** (S3 mode only) so each `<img>` loads straight from R2 in parallel, with no per-thumbnail app round-trip, existence HEAD, or redirect:
  - **Video poster thumbnails** — admin project grid (`/api/admin/video-token/batch` gains a `directUrls` map consumed by `AdminVideoManager`), admin share preview (`projects/[id]/share` resolver prefers `directUrls`), and the client share payload (`/api/share/[token]`).
  - **Album photo grids & covers** — admin album manager (`/api/albums/[albumId]/photos`), admin project album list covers (`/api/projects/[id]/albums`), and the client share gallery + covers (`/api/share/[token]/albums` and `/api/share/[token]/albums/[albumId]`), via a shared `presignAlbumPhotoThumbnailUrls` helper.
  - **Video asset preview tiles** — `/api/videos/[id]/assets` presigns the generated preview image directly (stored `PREVIEW_IMAGE` for image assets; the computed preview path for video assets).

  Every case falls back to the existing token-based `/api/content/...` proxy URL when not in S3 mode, or when a thumbnail isn't ready yet (so local-storage installs are unaffected). Separately, the content routes now skip the redundant pre-redirect `s3FileExists` HEAD for inline preview serving (thumbnails, timeline VTT/sprites, asset previews in `/api/content/[token]`; inline images in `/api/content/photo/[token]`) — a missing object simply 404s from R2 on the redirect, the same outcome without the extra round-trip; downloads keep the check. Touches `src/lib/photo-access.ts`, `src/components/AdminVideoManager.tsx`, the `admin/video-token/batch`, `content/[token]`, `content/photo/[token]`, `albums/[albumId]/photos`, `projects/[id]/albums`, `videos/[id]/assets`, `share/[token]`, `share/[token]/albums`, and `share/[token]/albums/[albumId]` API routes, and `admin/projects/[id]/share/page.tsx`.

### Added

- **"Uploads" is now a Project Type** — The Create New Project form and Project Settings → Project Type now offer an **Uploads** checkbox alongside Video and Photo (new `Project.enableUploads` column — defaults on for existing projects via migration `20260622000000_add_enable_uploads`, but the Create New Project form leaves it **unticked** by default). It acts as the master switch for the project's **UPLOADS** folder: when unticked, the folder is hidden from the share Files browser for **both clients and admins** (the `/api/share/[token]/downloadable-files` endpoint omits all `uploads` groups, so the sidebar entry, mosaic, and admin upload affordances disappear too). When ticked, the existing **"Enable Share Page Uploads for clients"** toggle still governs whether *clients* see it (admins always do). As with Video/Photo, the Uploads type cannot be unticked while files exist in the UPLOADS folder — the checkbox is disabled with a "Remove existing uploaded files to disable Uploads in this project" hint, and the API rejects the change with a 400. The "Enable Share Page Uploads for clients" help copy (Project Settings and Admin → Settings → Default Project Settings) was updated to reflect that admins only see the folder while the Uploads project type is enabled. Touches `prisma/schema.prisma`, `src/app/admin/projects/new/page.tsx`, `src/app/admin/projects/[id]/settings/page.tsx`, `src/components/settings/VideoProcessingSettingsSection.tsx`, `src/lib/validation.ts`, and the `projects`, `projects/[id]`, `share/[token]`, and `share/[token]/downloadable-files` API routes.

## [2.0.1] - 2026-06-21

### Fixed

- **Opening a project video version no longer autoplays** — Selecting a video version from the share Files browser (client share page and admin share preview) used to start playback automatically, which briefly flashed the video's poster thumbnail before the first frame rendered. The version now opens paused on its thumbnail and waits for the viewer to press play, removing the flash. The `seekToTime` event simply no longer carries `autoPlay: true` for these openings; the file-lightbox preview (a separate fullscreen `<video autoPlay>` in `ShareFilesBrowser`) is unaffected. Touches `src/app/share/[token]/page.tsx` and `src/app/admin/projects/[id]/share/page.tsx`.
- **Switching videos on the share page no longer leaves a dead, unplayable player after a session 401** — Loading a different video (and auto-playing a version) could leave the player loaded but frozen: the video would not start and even a manual click would not play it, with a `401 Unauthorized` on `/api/share/<slug>` and a `play() request was interrupted by a new load request` AbortError in the console. Root cause was the share-page token lifecycle racing against itself. The base share route mints a fresh session token on every call, and the page's main project-loader effect listed `shareToken` in its dependency array — so each load set a new token, which re-ran the loader, which minted another token, churning the token continuously. A burst of token requests (exactly what a video switch fires) could then go out mid-rotation with a stale/empty token, returning 401; the client's recovery handler treated that single transient 401 as a dead session and tore everything down — clearing the token and caches — which also invalidated the currently-playing video's `/api/content` stream tokens (they are bound to the same session), so the `<video>` element's `src` started returning 401/403 and playback could not recover. Three changes fix it: (1) the project-loader no longer depends on the `shareToken` state — it reads the freshest persisted token at call time via a ref, breaking the refetch loop; (2) `handleSessionExpired` now re-validates the session once (coalescing a burst of concurrent 401s into a single probe) with the latest persisted token before tearing down, so a healthy session survives a transient 401 and silently adopts the renewed token; and (3) the `VideoPlayer` now reports a failed stream `src` to the share page, which re-mints that video's tokens and reloads it (fired at most once per failed source) as a recovery safety net. Touches `src/app/share/[token]/page.tsx` and `src/components/VideoPlayer.tsx` (new optional `onStreamError` prop).

## [2.0.0] - 2026-06-21

### Changed

- **Share page VIEW and FILES modes are now a single combined view (client + admin)** — Both share pages (`share/[token]` and the admin `projects/[id]/share` preview) previously had a VIEW/FILES "Mode" toggle (header + mobile) that swapped the whole right panel between the video player and the file browser. The two are now merged: the right panel rests on the Files browser (full project tree, nothing selected on first load) and the sidebar keeps its VIEW look (video/album thumbnails with for-review/approved grouping) while also surfacing an **UPLOADS** folder rendered with the same 3-thumbnail mosaic the FILES browser uses at root. Selecting a sidebar item navigates the Files browser to that folder; selecting the same item again deselects back to the project root. The sidebar selection and the Files browser folder stay correlated in both directions — navigating into a folder inside the browser highlights the matching sidebar entry, and vice versa. Opening a specific video version from the Files browser swaps the panel to the player + comments; for clients the approved-video **Download** button returns to the Files browser. The standalone Mode toggle and the Files browser's "Close files view" X are removed. Guest links are unaffected (they keep showing the player directly). Touches both share pages, `VideoSidebar.tsx` (new opt-in `showUploadsInView` / `onUploadsSelect` / uploads mosaic props), `ShareFilesBrowser.tsx` (deselect-to-root navigation), and the shared `FolderPreviewMosaic.tsx` component.

### Removed

- **Project-level Guest Mode has been removed** — The per-project **Guest Mode** toggle (Settings → Security) and the "Continue as Guest" entry on the share-page auth screen are gone, along with the supporting `/api/share/[token]/guest` session endpoint, the `/share/[token]/guest` auto-entry path, and the `Project.guestMode` column (dropped via migration `20260621000000_remove_project_guest_mode`). Guest sessions granted a restricted videos-only view of an entire project (no comments/approvals/downloads) and required maintaining parallel sanitized share-page variations throughout the client share page and several API routes (share payload, comments, recipients) — all of that branching is removed. The separate, still-supported **"Generate Video Link"** feature in the share modal (renamed **Share Video**) is unaffected: it issues a 14-day view-only link to a single video version via `/gv/[token]` + `/api/guest-video-links`.

### Fixed

- **Video asset / share-upload timeline sprites no longer fail with `EACCES: permission denied, mkdir '/app/temp'`** — `asset-upload-timeline-processor.ts` defaulted its scratch directory to `path.join(process.cwd(), 'temp')`, which in the container resolves to `/app/temp` — a path the non-root worker user cannot create. Every asset/upload timeline-sprite job therefore threw `EACCES` on `mkdir` and the hover-scrubbing timeline was never generated for uploaded video assets (the preview/thumbnail steps, which already used `os.tmpdir()`, were unaffected). The processor now uses the shared worker temp dir (`TEMP_DIR` from `cleanup.ts`, under `STORAGE_ROOT/.worker-tmp`) — the same writable, startup-ensured, orphan-swept location the main video-processor timeline code uses. Existing assets uploaded before this fix can regenerate their timelines via Reprocess.
- **Asset preview progress now shows real "processed" counts and a monotonic bar** — The Running Jobs asset-preview row reported `${processingCount}/${totalCount} processed`, where `processingCount` was the live worker concurrency (always ~2, capped by `videoWorkerConcurrency`) and `totalCount` was only the *remaining* work (pending + processing), which shrank as assets finished — so a 11-asset wave displayed a misleading "2/11 processed" that drifted to "2/5" as the denominator descended, and the progress bar (`processingCount / totalCount`) lurched around instead of climbing. `/api/running-jobs` now also returns a per-project `doneCount` (assets whose preview finished within the recent window), and the bell renders against the stable full-wave total (`doneCount + remaining`): the label and progress bar now read genuine completed-of-total (e.g. "2/11 processed · 18%" climbing cleanly to "11/11 · 100%"). Concurrency was already respected — asset previews run on the `share-upload-preview` worker at the configured `videoWorkerConcurrency`; the old "2" was that cap, not a count of finished items.
- **No more redundant "Asset previews complete" entry while a wave is still running** — `/api/running-jobs` surfaced a project in its `completed` list whenever any of its asset previews had finished within the last 30 minutes, even while the rest of the wave was still processing — producing a periodically-updating "N asset previews complete" row in the Recently-finished section alongside the live in-progress row. The completed list now excludes any project that still has active preview work, so a single completion entry surfaces only once the whole wave is done (via the same server signal and the existing client-side disappearance detector).

## [1.9.9] - 2026-06-20

### Changed

- **Project page Videos and Photos cards are now visual** — The admin project detail page (`/admin/projects/[id]`) previously rendered video groups and photo albums as text-only collapsible cards. Both sections now lead with imagery: each collapsed video group shows a 16:9 poster thumbnail (minted in one batch via `/api/admin/video-token/batch`) and each album shows a square cover thumbnail (first ready photo), with the reprocess action moved to a hover overlay on the tile and a status-coloured ring (red error / orange busy / neutral). Expanding an album now renders its photos as a responsive thumbnail grid (`/api/albums/[albumId]/photos` returns a per-photo `thumbnailUrl`) instead of a filename list, with filename/size and delete revealed on hover. Expanding a video version's **Uploaded Assets** now shows a thumbnail for previewable image/video assets (`/api/videos/[id]/assets` returns a per-asset `thumbnailUrl` via an `assetPreview=1` content token) with the file-type icon as fallback. Supporting polish: the album "Download ZIPs" panel is now two Ready/Building status rows with badges instead of a counts dump; both section headers gained count chips ("3 videos", "2 albums · 212 photos") and a consistent layout; approved video groups get a success-coloured left border; empty sections show a proper empty-state card; and expanding a card animates in. All thumbnails fall back to an icon on token-expiry image errors and re-mint on the next data fetch. New thumbnail URLs are added to existing RBAC-gated endpoints (`/api/projects/[id]/albums`, `/api/albums/[albumId]/photos`, `/api/videos/[id]/assets`) by minting access tokens for the admin session — no new routes.
- **Album photo and video-asset uploads start on selection and clear themselves** — Both upload queues (`AlbumPhotoUploadQueue`, `VideoAssetUploadQueue`) previously required a two-step flow: choose files, then click "Add to Upload Queue". Selecting (or dropping) files now adds them straight to the queue, which begins uploading immediately (S3 multipart or TUS, as before). Completed items also auto-clear from the queue ~1.5s after finishing — the album photo grid / asset list is the source of truth — so the manual "Clear Completed" buttons are gone. Failed items stay listed for retry. (New video / new-version uploads are unchanged for now, since their S3 storage path is derived from the video name + version label set at creation.)
- **Running Jobs are now grouped into one card per project** — The Running Jobs bell previously rendered every background job as its own flat row, so a project generating (say) 20 asset previews plus transcodes and a ZIP flooded the dropdown with 20+ rows. Jobs are now rolled up into a single collapsible card per project showing an aggregate progress bar (computed as completed-items / total-items, with partial credit for in-flight work), a per-type breakdown (e.g. `3 transcodes · 14 previews · 1 ZIP`), and active/queued counts; expanding a card reveals the individual jobs (unchanged `JobRow`s, with the same per-job cancel actions). A project sits in exactly one section — "In Progress" while any job is active, "Queued" while only queued, and "Recently finished" once fully idle, where its completions consolidate into a single `N complete` entry (failures stay listed individually and persist until dismissed). Jobs with no project (e.g. client folder renames) collect under a "Maintenance" group. This is a presentation-only change in `RunningJobsBell` — the polling/provider layer and the `/api/running-jobs` payload are unchanged, so re-running work (e.g. Reprocess Previews) reuses the existing deterministic-key reconciliation to move a project cleanly back into "In Progress" without a stale "complete" lingering.

### Fixed

- **Share page thumbnails no longer stay broken after the device sleeps while AFK** — Share-page preview thumbnails load via short-lived `/api/content/<token>` URLs whose Redis TTL equals the client session timeout (15 min default); once a token lapses the route returns 403 and the tile breaks. `useContentImageRefresh` already re-minted tokens on `<img>` errors, a periodic timer, and `visibilitychange`, but none of those fire in the most common AFK case: the user steps away with the tab still **visible** and the display/PC sleeps — no `visibilitychange`, no window `focus`, and the periodic `setInterval` is suspended mid-cycle so its next run lands after the token already expired (Redis TTL keeps counting in wall-clock time). Added a wall-clock heartbeat layer that ticks every 20 s and, on detecting a gap larger than 60 s between ticks (i.e. the device slept or timers were throttled), refreshes all content tokens immediately on wake.
- **Social media downloads toggle can now be re-enabled after disabling** — Disabling the toggle passed `enabled: false` to the server in both directions; enabling now correctly sends `enabled: true`. Additionally, disabling in S3 mode left an orphaned `ZIP_SOCIAL` StoredFile row (the server used `fs.statSync` to read the file size, which throws on S3 and swallowed the delete calls). The disable path now reads the file size from the StoredFile record and deletes the ZIP via the storage abstraction, which handles both local and S3 correctly.
- **Reprocessing a video with a custom thumbnail no longer leaves an orphaned `thumbnail.jpg`** — The worker's `processThumbnail` always generated and wrote `.previews/videos/{video}/{version}/thumbnail.jpg` to storage, but the finalize step (correctly) skips registering a `THUMBNAIL` StoredFile row when the video has a user-set custom (asset-based) thumbnail. The generated file was therefore written but never tracked, so every Reprocess Previews / Reprocess run on a custom-thumbnail video deposited a fresh untracked thumbnail that the storage integrity scan then flagged as an orphan. `processThumbnail` now checks for a custom thumbnail up front and skips generation entirely (also saving the wasted FFmpeg work), so no orphan is produced. This complements the 1.9.8 route-side fix that preserves the custom `THUMBNAIL` pointer during reprocess. Existing orphaned thumbnails can be cleared with the storage orphan cleanup (Settings → Developer Tools / the nightly reconcile).
- **Timeline hover scrubbing no longer flashes black frames between sprite sheets** — On long videos whose timeline previews span multiple sprite sheets (each sheet packs 100 frames ≈ 8.3 min of video), moving the cursor across a sprite-file boundary briefly showed a black frame while the next sheet was fetched on demand — a long video produced one flash per boundary crossed. Two changes fix it: (1) both hover components (`VideoHoverPreview` for thumbnail/asset/upload hovers and the `VideoPlayer` timeline scrubber) now preload every distinct sprite sheet referenced by the WebVTT index as soon as it is parsed, warming the browser cache before the cursor reaches each boundary; and (2) the content delivery endpoint (`/api/content/[token]`) now serves timeline sprites/VTT and thumbnails with `Cache-Control: private, max-age=3600` instead of `no-store` (in both local-disk and S3-proxy modes), so the preloaded bytes are actually reused instead of re-fetched on every hover. These derived preview files remain token-gated and `private` keeps them out of shared/CDN caches.

### Security

- **Running Jobs no longer leaks projects a user can't see** — The `/api/running-jobs` GET aggregated asset- and upload-timeline jobs (`videoAsset` / `shareUploadFile` with an active `processingPhase`) using only a `processingPhase != null` filter, with none of the project-status / assigned-user scoping every other query in the route applies. A non-system-admin polling the Running Jobs bell could therefore see project titles and video/file names for projects they were not assigned to. Both queries now apply the same visibility filter, and the POST clear endpoint now authorizes the target's project before removing the queued BullMQ job or DB row (cross-project rename clears are restricted to system admins).

### Performance

- **Share page preview thumbnails load with far fewer round-trips (admin + client)** — Four changes cut the request fan-out that gated every preview tile:
  - *Video thumbnails no longer need a per-video token round-trip before they can load.* The client share page (`/api/share/[token]`) previously returned `thumbnailUrl: null` with `hasThumbnail: true`, forcing the browser to POST `video-token?quality=thumbnail` once **per video** before any sidebar/folder tile could start loading; the payload now mints each video's thumbnail token inline (session-bound and cached per session, so no token proliferation) and ships a ready `thumbnailUrl`, so thumbnails appear on first paint. The admin share-preview page (`/admin/projects/[id]/share`), which mints through its own `/api/admin/video-token`, now coalesces those per-video thumbnail/timeline GETs into a single batched POST via the new `/api/admin/video-token/batch`.
  - *Upload preview tokens are batched (admin + client).* The FILES browser resolved upload previews one POST per visible file (`/api/share/[token]/uploads/download-token`). A new batch endpoint `/api/share/[token]/uploads/download-tokens` mints tokens for many files at once, and both share pages now coalesce the burst of visible-tile requests into a single (chunked, max 100) request per frame.
  - *No more client-side video downloads to make poster frames (admin + client).* `ShareFilesBrowser` (shared by both share pages) previously fell back to downloading a video and drawing a frame to a canvas (`captureVideoPoster`) when a file had no server-side image thumbnail — pulling video bytes just to fill a grid tile. It now relies on server-generated thumbnails and shows the icon fallback otherwise.
  - *S3 thumbnails are redirected, not proxied (admin + client).* In S3 mode the content endpoint streamed every thumbnail's bytes through the app server (to avoid CORS on JS-fetched timeline assets). Thumbnails are rendered via `<img>`/CSS `background-image`, which are not CORS-sensitive, so they now 302-redirect to a presigned R2 URL — offloading the transfer to R2. Timeline VTT (fetched from JS) stays proxied.

## [1.9.8] - 2026-06-18

### Fixed

- **Admin PWA is installable again on Chrome/Android** — The admin service worker (`public/admin/sw.js`) intentionally shipped without a `fetch` handler ("purely online; no caching"). Since Chrome 93, a service worker with a `fetch` handler is a hard installability requirement, so Chrome silently withheld the "Install app" option on Android (DevTools reported "Page does not work offline"). The worker now registers a minimal navigation-only `fetch` handler — a network pass-through with a tiny offline fallback, no caching — which satisfies the install criteria without changing the app's online-only behaviour. Existing devices must reload `/admin` (closing the tab/app) so the updated worker activates.
- **"Delete previews for closed projects" honoured its dry-run and stopped orphaning sprite frames** — The batch Storage Overview action computed a `dryRun` flag but ignored it, so a "preview" run always deleted. It also tried to remove `TIMELINE_SPRITES` (a directory) with the single-file delete, which silently no-ops on a directory and left the sprite frames on disk after removing their `StoredFile` row (the storage integrity scan would later flag them as orphans). The action now genuinely previews on dry-run, no longer touches sprites at all, and returns the richer result shape the settings UI renders (closed-project / preview-file counts, per-project sample, and delete/error tallies) instead of the previously mismatched payload that showed blanks.
- **Reprocessing a video with a custom thumbnail no longer destroys the source asset** — When an image asset is set as a video's playback thumbnail, the `VIDEO/THUMBNAIL` StoredFile is repointed to share the asset's original file. Three flows (project Reprocess, Reprocess Previews, and asset deletion) detected custom thumbnails with a stale query that looked for a non-existent `VIDEO_ASSET/THUMBNAIL` row, so detection always failed — reprocessing then deleted the `THUMBNAIL` role and, with it, the shared asset original from storage, breaking the asset's FILES-view thumbnail and lightbox. A new shared `getVideosWithCustomThumbnail()` helper (mirroring the worker's correct detection: the video's `THUMBNAIL` path matching one of its own assets' stored paths) now drives all three flows. Deleting the asset that is the live custom thumbnail now drops the pointer and regenerates a system thumbnail (matching the "remove custom thumbnail" behaviour) instead of leaving a dangling pointer. Note: assets whose original was already deleted by a prior reprocess must be re-uploaded.

### Changed

- **Closed projects keep every thumbnail and still image; only heavy playable renditions are shed** — All three close-time cleanups (closing a project from the project page, the scheduled auto-close of approved projects, and the manual "Delete previews for closed projects" action) now delete the same minimal set: video 480p/720p/1080p previews and the video-asset playback MP4. Video thumbnails, timeline sprites/VTT, and the video-asset still image (`PREVIEW_IMAGE`) are always preserved so every file in the Share FILES area still shows a thumbnail after close. Previously the three paths each deleted a different mix (some removed thumbnails, the asset still image, or sprites), and none refreshed the project's stored byte totals — they now recalculate per project so freed space shows immediately instead of waiting for the nightly reconcile. Reopening a closed project regenerates the purged renditions as before.
- **Share/admin FILES lightbox no longer opens an empty player for a purged asset preview** — When a video asset's playback MP4 has been purged (e.g. after close) but its still image is kept, the FILES browser now treats the asset as image-only: the play overlay is hidden and clicking it no longer opens a video lightbox that would have nothing to play. A new `playbackPreviewAvailable` flag on the downloadable-files API drives this on both the client Share page and the admin Share preview.
- **StoredFile is now the sole source of truth — legacy path columns removed** — Following the StoredFile registry introduced in 1.9.7, all reads/writes now go through `StoredFile`, and the legacy per-entity path/size columns (`Video.originalStoragePath`, `preview*Path`, `AlbumPhoto.storagePath`, `Settings.companyLogoPath`, etc.) have been dropped across 14 tables.

### Migration safety

- **Re-backfill before dropping legacy columns (no data loss on upgrade)** — The 1.9.7 release created and backfilled `StoredFile` once, but the app it shipped with still wrote new files only to the legacy columns, so every file uploaded since then existed only there. Two new migrations make the cutover seamless: `20260618000000_rebackfill_stored_files` re-runs the backfill (`ON CONFLICT DO NOTHING`, idempotent; re-applies the timeline-path fix and `projectId` backfill) to capture every file created since 1.9.7, and `20260618000001_drop_legacy_file_columns` then removes the legacy columns. The re-backfill is guarded per-table by `information_schema` checks, so it is a clean no-op on databases where the columns were already removed (e.g. a dev DB synced via `prisma db push`); the drop uses `DROP COLUMN IF EXISTS`. Both are safe to re-run.

## [1.9.7] - 2026-06-06

### Added

- **Timeline hover previews for video assets and uploaded video files** — Video assets (in the FILES view of Share pages) and uploaded video files (UPLOADS section) now support timeline hover previews, extending the sprite-sheet feature that was previously only available for video versions. A new `VideoHoverPreview` component renders the sprite frame at the cursor position, and a dedicated `asset-upload-timeline-processor` worker generates sprite sheets and WebVTT index files. Two new BullMQ queues (`asset-timeline` and `upload-timeline`) handle the generation jobs, which appear in the Running Jobs bell alongside existing processing tasks.
- **Duration vs Timecode toggle on Share page** — Viewers on the Share page can now toggle the video time display between Duration (MM:SS) and Timecode (HH:MM:SS:FF) via a dropdown arrow next to the timestamp. The initial mode respects the project's `useFullTimecode` default, and the user's choice is persisted in `localStorage` and synchronised across the VideoPlayer, CommentSection, and CommentInput via a new `useTimeDisplayMode` hook.
- **Multi-layer content token refresh for stale thumbnails** — A new `useContentImageRefresh` hook provides three layers of defence against broken thumbnails caused by expired content API tokens: (1) a global capture-phase `<img>` error listener that debounces and triggers a full token refresh, (2) a proactive periodic refresh timer (every 10 minutes), and (3) a visibility-change handler that refreshes tokens when the tab becomes visible after being hidden for >30 seconds. This replaces ad-hoc visibility/focus handlers on both the admin and client share pages.
- **Balance Sheet now supports Cash vs Accrual basis** — The Balance Sheet report page includes a Basis dropdown (Cash / Accrual) that controls how GST liability is calculated. On a Cash basis, GST collected is derived from payments received; on an Accrual basis, it is derived from all issued invoices. The default follows the reporting basis set in Accounting Settings. The balance sheet API also accepts a `basis` query parameter.
- **`JobStatus` PostgreSQL enum** — `FolderRenameJob.status` and `AlbumThumbnailJob.status` columns now use a typed `JobStatus` enum (`PENDING` | `IN_PROGRESS` | `COMPLETED` | `FAILED`) instead of a plain text field, providing type safety and constraint enforcement at the database level.
- **Expense amounts consistency CHECK constraint** — A database-level constraint ensures `amountExGst + gstAmount ≈ amountIncGst` with ±1 cent rounding tolerance, preventing data integrity issues in the Expense table.
- **StoredFile — centralized file path registry** — a new StoredFile database table with EntityType and FileRole enums now acts as the single source of truth for every file path in the system, replacing 30+ scattered path columns across 14 entity tables. A companion stored-file.ts module provides registerStoredFile() for workers and upload handlers to upsert file records, along with query helpers (getAllStoredPaths, renameStoredPaths, getStorageTotalsByEntityType, findStoredFilesToDelete) that will replace the multi-query enumeration patterns currently used by storage integrity scans, folder rename processors, storage totals calculations, and closed-project cleanup. The migration backfills all existing file paths from legacy columns and the table is ready for a phased dual-write rollout.

### Changed

- **Timeline sprite frame width increased from 160px to 320px** — Hover preview sprites now render at double the resolution, providing sharper frame detail when scrubbing across video thumbnails.
- **Sales tax rate and fiscal year settings are now cached** — A new `getSalesSettingsSnapshot()` cached helper (60-second TTL) in `settings.ts` reduces repeated `SalesSettings` database queries. All consumers (`calculateBas`, expense creation, account balances, P&L/Balance Sheet reports) now use this cached lookup. The cache is invalidated when sales settings are updated.
- **Closed-project preview cleanup no longer deletes timeline sprites** — Both auto-close (`processAutoCloseApprovedProjects`) and the manual "Delete previews for closed projects" action now preserve timeline sprite files and VTT indices, since they are small and costly to regenerate. Only video playback previews (480p/720p/1080p) and video-asset playback previews are deleted. The Storage Overview admin UI has been updated to reflect this policy.
- **Reprocess Previews now also regenerates timeline sprites for assets and uploads** — When reprocessing all previews for a project, the system now clears timeline preview metadata and enqueues timeline sprite generation jobs for video-type assets and upload files, in addition to the existing video and playback-preview jobs. Toast feedback now reports upload timeline and asset timeline job counts.
- **Timeline Preview management (Generate/Delete) now spans videos, assets, and uploads** — The admin Timeline Previews action now finds and enqueues eligible video assets and upload files alongside videos. Deleting timeline previews clears sprite directories and DB fields across all three entity types.
- **Running Jobs now surfaces asset and upload timeline processing** — The Running Jobs API and bell UI poll `VideoAsset` and `ShareUploadFile` records with active `processingPhase` values, displaying their progress rows in the bell dropdown and contributing to the badge count.
- **Accounting report types consolidated** — `ProfitLossReport` and `BalanceSheetReport` types were moved from `accounting/reports.ts` into the canonical `accounting/types.ts` module, with re-exports for backward compatibility. The unused `TrialBalanceReport` type, `buildTrialBalanceReport` function, and `trial-balance` API route were removed.
- **Balance Sheet sign handling now uses per-account debit-normal lookup** — Previously the sign logic assumed all accounts in a batch shared the same type (e.g. all ASSET). Now a `debitNormalSet` is built per batch, so mixed-type batches (ASSET + LIABILITY) compute correct balances for each account.
- **Accounting default reporting basis changed from Accrual to Cash** — The `AccountingSettings.reportingBasis` default is now `CASH`, matching the most common reporting method for Australian small businesses.
- **`JournalEntry.taxCode` no longer has a database-level default** — The default is now applied exclusively by the Zod validation schema in the API layer, preventing inconsistent defaults between direct DB writes and API-created entries.

### Fixed

- **Admin approval notifications no longer spam other admins** — When an admin/internal user approves or unapproves a video via the admin share page, the email notification to other admin users is now skipped. Only client-initiated approvals trigger admin notification emails. The push notification message now uses the author's name instead of the generic "Client" label.
- **Balance Sheet bank transaction / journal entry signs corrected** — Bank transactions follow bank-statement convention (positive = money in / credit), but ASSET (debit-normal) accounts need the sign negated to correctly increase the balance. Journal entries already follow account perspective (positive = increase to account), so they now negate for credit-normal (LIABILITY/EQUITY) accounts. Previously a single `isDebitNormal` flag derived from the first account in the batch was applied uniformly, causing incorrect balances.
- **Video and folder rename now correctly rebase asset timeline preview paths** — When renaming a video version label or performing a folder rename, `VideoAsset.timelinePreviewVttPath` and `VideoAsset.timelinePreviewSpritesPath` are now correctly rebased to use the `.previews` prefix pair, matching the existing fix for `previewPath`.
- **S3 migration and local backup now include asset/upload timeline files** — The `collectReferencedPaths` function in the local-to-S3 migration module and the `collectTimelineSpriteKeys` function in the S3 local backup module now enumerate `VideoAsset` and `ShareUploadFile` timeline paths, ensuring these files are migrated and backed up.
- **Storage integrity scan now protects asset and upload timeline paths** — The orphan file scanner and missing-file reference builders now recognise `VideoAsset` and `ShareUploadFile` timeline sprite directories and VTT files, preventing false-positive orphan/missing reports.
- **Project total bytes calculation now includes asset/upload timeline files** — `computeProjectPreviewBytes` now queries and sums file sizes for asset and upload timeline sprite files, ensuring accurate storage usage reporting in the Storage Overview.
- **Album thumbnail broken-image fallback** — Album card thumbnails now show a transparent placeholder with an icon when the image fails to load, instead of a broken image icon.
- **Video asset card image error handling** — Video asset thumbnails in the VideoSidebar now hide the broken image element on load failure, allowing a background placeholder to show through.

## [1.9.6] - 2026-06-04

### Added

- **Right click context menu for FILES mode of Share page** - Improves usability of the files area and restricts users from mistakenly right clicking on images and selecting 'Save Image As' and download a preview file.

### Changed

- **Dockerfile optimisations** - reordered system packages before npm global install for stable layer caching. Replaced `COPY . .` in builder stage with explicit file/directory copies to reduce cache busting. Removed duplicate `apk update` call after the retry loop. Added `npm cache clean --force` after npm ci/install in deps-full stage to shrink image layers. Simplified postinstall script to use `;` separators instead of `&& ||` error masking.
- **Share page FILES mode improvements** - Numerous small UI improvements across the FILES mode of the Share page.
- **Running Jobs improvements** - Numerous small tweaks and improvements to Running Jobs.

### Fixed

- **Share page: stale thumbnails after session expiry + reauthentication** - After a client's share session expired and they reauthenticated, stale in-memory caches retained signed URLs from the old session, causing thumbnails and previews to fail with 401/403 errors. Introduced a centralized handleSessionExpired() that clears all caches and resets auth state, replacing 7 duplicated inline 401 handlers. Auth handlers now also purge caches and re-fetch downloadable files with the new token, so all content loads fresh after reauth without requiring a manual page refresh.

### Removed

- **Stripped remaining Dropbox references** - Removed legacy support for resolving dropbox paths.

## [1.9.5] - 2026-06-03

### Added

- **Centralized DOMPurify hook configuration** - created `src/lib/security/dompurify-config.ts` as the single source of truth for global DOMPurify `afterSanitizeAttributes` hooks. All three sanitization modules (`validation.ts`, `html-sanitization.ts`, `email-html-sanitization.ts`) now call `ensureDomPurifyHooksRegistered()` instead of each registering their own copy of the same link-safety hook. This eliminates the risk of conflicting duplicate hooks and ensures consistent `rel="noopener noreferrer nofollow"` enforcement on external links regardless of import order.
- **`sanitizeSlug()` now lives in `utils.ts`** - moved from the single-utility `password-utils.ts` into `src/lib/utils.ts` alongside the existing `generateSlug()`. The old module remains as a deprecated re-export (`export { sanitizeSlug } from '@/lib/utils'`) for backward compatibility.
- **Right click context menu for FILES mode of Share page** - Improves usability of the files area and restricts users from mistakenly right clicking on images and selecting 'Save Image As' and download a preview file.

### Changed

- **Timeline left and right range marker improved** - The animated timeline marker with draggable left/right bars for range comments now uses a percentage based gap between each other to better indicate that the bars are two separate items that can be interacted with. Previously for longer videos the bars were too close together and appeared as a single object.
- **Encryption key derivation is now cached per process** - `getEncryptionKey()` in `encryption.ts` computes `scryptSync` once at module initialization and returns the cached `Buffer` on subsequent calls. Previously every `encrypt()` or `decrypt()` call re-derived the key, blocking the event loop each time.
- **Rate-limit admin functions now use `SCAN` instead of `KEYS`** - both `unblockIpAddress()` and `getRateLimitedEntries()` in `rate-limit.ts` use cursor-based `redis.scan()` with `MATCH`/`COUNT` instead of blocking `KEYS *`, preventing Redis performance degradation on large key sets.
- **Token revocation now uses shared `ensureRedisReady()`** - all five functions in `token-revocation.ts` (`revokeToken`, `isTokenRevoked`, `revokeAllUserTokens`, `isUserTokensRevoked`, `clearUserRevocation`) call `ensureRedisReady(redis)` instead of manually checking `redis.status !== 'ready'` and calling `redis.connect()`, avoiding "already connecting/connected" race conditions under concurrent load.
- **Removed backward-compatible queue proxy exports** - the `videoQueue` and `assetQueue` Proxy objects were removed from `queue.ts`. All consumers (`uploads/s3/complete/route.ts`, `pages/api/uploads/[[...path]].ts`) now use `getVideoQueue()`/`getAssetQueue()` directly.
- **Removed unused `getRedisConnection` alias** - the backward-compatibility alias `export const getRedisConnection = getRedis` was removed from `redis.ts` after confirming zero remaining references.
- **Project settings page imports `sanitizeSlug` from `@/lib/utils`** - updated the single caller in `admin/projects/[id]/settings/page.tsx` to use the new canonical location.
- **Consolidated duplicate user queries in auth layer** - introduced `fetchUserById(userId)` helper in `auth.ts` that performs the user + role/permissions query and mapping once. All four callers (`getCurrentUserFromRequest`, `getCurrentUser`, `getAdminOverrideFromRequest`, `refreshAdminTokens`) now delegate to this shared function, eliminating 3 redundant copies of the same ~25-line Prisma query.
- **`requireApiAdmin()` renamed to `requireApiUser()`** - the function only checks authentication (not admin role). All 8 route call sites (web-push routes, notifications route) updated. Old name kept as deprecated alias.
- **`getMaxAuthAttempts()` DB query now cached** - `getMaxAuthAttempts()` in `settings.ts` and `getMaxPasswordAttempts()` in `otp.ts` cache the `SecuritySettings.passwordAttempts` value for 30 seconds, eliminating repeated DB queries on every login/OTP attempt. `incrementRateLimit()` in `rate-limit.ts` also uses the cached `getMaxAuthAttempts()` instead of repeating its own Prisma query.
- **OTP send rate limiting added** - new `checkOTPSendRateLimit()` prevents rapid OTP generation requests (1 per minute per email+project). Separate from the existing per-window request count limit.
- **Encryption module now uses ESM imports instead of `require()`** - `encryption.ts` replaced `require('crypto')` and `require('bcryptjs')` with standard ESM imports. This ensures compatibility with strict ESM environments.
- **TypeScript target updated to ES2022** - changed `tsconfig.json` target from `ES2017` to `ES2022`, unlocking modern JS features.
- **Removed legacy per-project `.vitransfer_project_redirect` stub file reading** - the old per-project stub folder redirect path and its `PROJECT_REDIRECT_FILENAME` constant were removed. Project redirects now exclusively use the central `.vitransfer_projects_redirects.json` index file.

### Fixed

- **Non-approvable videos no longer say Video Approved when a project status is set to Approved** - Added a Project Approved banner and text that states that particular version was not eligible for download/approval.

## [1.9.4] - 2026-06-02

### Added

- **Smart Version Label logic** - When adding a new video or video version, the system automatically identifies "v*" from the filename, enters it into the Version Label and removes it from the Video Name field.

### Removed

- **Removed the Approve Project / Unapprove Project button from Project page** - Project Status is changed by clicking the Status pill, which supports all statuses, including the final possible status "Closed".

### Fixed

- **Storage integrity scan now respects closed-project video assets with thumbnail only** � The close-project cleanup was clearing VideoAsset preview metadata too aggressively, even when the surviving file that matters is the companion JPG thumbnail used for asset cards. That left the integrity scan with no database-backed way to recognize those JPGs, so they showed up as orphan paths. It also meant the asset preview APIs could no longer treat those thumbnails as valid after close. Changed the closed-project cleanup paths so they only delete video-asset playback preview MP4s, keep the JPG thumbnail state intact, and leave image/non-video asset previews alone. Also updated the storage integrity reference builder, preview-bytes accounting, and asset preview token/content logic so a closed-project video asset in �thumbnail only� state is treated as valid instead of orphaned. The admin copy for �Delete previews for closed projects� now matches that behavior.
- **Rewired Video Asset's "Copy to Version" to account for S3 storage and new previews folder** - Copy to version had not been updated to account for new storage provider mode and Video Asset previews for the FILES view of Share pages.
- **Album ZIP files now renamed on album name change** - Album ZIP files now rename when renaming an existing album.
- **Video Asset video previews for previously closed projects** - Re-opening a previously closed project now properly regenerates missing Video Asset video previews if they were deleted when the project was closed.
- **Reprocess Previews no longer deletes custom set playback thumbnails video asset** - The "Set as video thumbnail" function still referenced old preview paths and was allowing the original file to be deleted when running Reprocess Previews.

## [1.9.3] - 2026-05-31

### Added
- **Global PWA metadata is now emitted from app-level metadata generation** � root metadata now declares `manifest`, mobile web-app capability hints, Apple web-app capability, and a global theme color so installability signals are present across auth redirects and non-admin entry points.

### Changed
- **Admin PWA wiring now uses a belt-and-suspenders manifest strategy** � admin route head output keeps explicit manifest/mobile-app tags, and admin client layout re-adds a runtime manifest-link fallback for browsers that miss head tags after client transitions.
- **Manifest identity and display preferences were hardened** � admin manifest now includes a stable `id` (`/admin/`) and `display_override` fallback chain while keeping `display: standalone`.

### Fixed
- **Install option reliability on Android Chrome has been improved** � installability regressions caused by inconsistent manifest discovery were addressed by ensuring PWA metadata is available at first render and after route hydration.
- **Top browser chrome can now be avoided more consistently when launched as an installed PWA** � standalone launch behavior is now more dependable once users install from the updated build.

## [1.9.2] - 2026-05-31

### Added
- **Downloadable files API now exposes per-version approval capability metadata** � share downloadable-file payloads now include `allowApproval` for video versions so the FILES UI can distinguish between "approval required" and "downloads disabled" states.
- **Admin pages now include a dedicated head definition for PWA metadata** � added `src/app/admin/head.tsx` with the admin manifest and mobile web-app meta tags to keep admin PWA configuration explicit and route-scoped.

### Changed
- **Share FILES folder details now provide clearer availability messaging** � opening a video folder now shows an approval-aware status banner, and the Video Assets section is shown only when an approved version exists; album folders show a dedicated ZIP/photo download hint.
- **FILES sidebar folder tree now opens in a cleaner default state** � in desktop FILES mode, the top project folder starts expanded while video/album/uploads subfolders default collapsed (without overriding user toggles), reducing initial visual noise.
- **FILES sidebar text sizing was refined for readability** � folder/file labels in the sidebar were slightly increased for better legibility while preserving density.
- **Primary accent foreground tokens now follow computed contrast text** � global theme CSS now sets `--accent-foreground` to the generated foreground color for better contrast consistency with custom branding accents.
- **Timeline range-handle first-appearance cue now rests on a subtle separated baseline** � the handle nudge keyframes and animation classes now use +/-1px baseline offsets to make the separation affordance more apparent.
- **Filename sanitization now preserves ampersands (`&`) across upload/storage paths** � filename-safe character sets were expanded in shared sanitizers and route fallbacks (project/client/user files, album photos, video assets, comment file paths, temp storage names, and asset ZIP name generation).

### Fixed
- **Mobile share-page comment focus no longer causes smooth-scroll jumpiness** � while admin/client share pages are mounted on mobile/coarse-pointer devices, global smooth scroll is temporarily disabled to prevent browser auto-scroll animation conflicts during focus.
- **Expired preview/download tokens in FILES mode now trigger automatic list refresh** � when preview token requests fail with auth/not-found statuses (401/403/404), share pages request a downloadable-files refresh to recover from stale token state.
- **Folder preview tile image failures now request token refresh with throttling** � ShareFilesBrowser now calls a debounced preview-token refresh callback when preview tiles error, reducing repeated broken previews from expiring short-lived URLs.
- **Upload-file card interactions in FILES mode are now safer and more consistent** � single-click no longer attempts preview/lightbox for upload files, while double-click performs download when permitted.

## [1.9.1] - 2026-05-29

### Changed
- **Accounting dashboard trend controls are more flexible and space-aware** � the Profitability Trend chart now includes a Cost of Goods Sold (COGS) series (yellow dashed line), centered checkbox legend toggles for Income/Total Costs/COGS/Net Profit, and responsive COGS legend labeling (`COGS` on mobile, full label on larger screens).
- **Profitability Trend now supports an explicit All time range option** � the period selector includes an All time option for long-range reporting.
- **Accounting page heading text is cleaner** � removed the leading "Under Development." copy from the Accounting section header.
- **Keyboard shortcuts button now follows desktop-only behavior in share views** � both admin and client share feedback screens now hide the shortcuts launcher on non-desktop layouts.
- **Timeline preview behavior is improved on touch devices** � video timeline hover previews now appear while actively scrubbing on mobile/touch, then hide when scrubbing ends.
- **Draft timeline handles now include a first-appearance separation cue animation** � when the comment range handles appear, the IN and OUT bars briefly move apart and return twice to better communicate that they are independently draggable.

### Fixed
- **All time accounting trend requests now start from the earliest real accounting record** � monthly profit/loss API now resolves `from=all-time` against earliest relevant income/cogs/expense activity instead of using an arbitrary historical start date.
- **Project rename patch flow now handles in-progress S3 rename jobs safely** � when a matching rename job is already queued/running, non-storage project updates can proceed without triggering duplicate rename workflows.
- **Draft range selection is no longer cleared on playback when a range is already selected** � starting video playback now preserves active IN/OUT comment range selections unless no draft content or range has been set.

## [1.9.0] - 2026-05-28

### Added
- **Timeline range comments (in/out) are now supported** � comments can now include an optional `timecodeEnd` alongside `timecode`, backed by a new Prisma migration and schema field; the video timeline includes draggable IN/OUT handles while drafting so a comment can span a precise segment instead of a single frame.
- **Timeline now visualizes comment ranges** � top-level comments with a range render an amber span on the scrub bar, while point comments continue to render as markers.

### Changed
- **Comment composer time badge now shows range-aware timestamps with reset controls** � the composer displays either a point timestamp or `start - end` range, supports resetting the active range, and keeps comment draft timing synchronized with timeline range interactions.
- **Comment timestamps now display ranges across UI and notifications** � message bubbles and email notification templates now render `timecode -> timecodeEnd` when a range exists.
- **SRT export now honors explicit comment end times** � subtitle cue generation uses stored `timecodeEnd` for root comments when present, falling back to duration heuristics only when no explicit end exists.
- **Share and admin review header controls were refined for mobile and desktop** � spacing and inactive-tab styling for View/Files toggles were adjusted, and FILES multi-select controls now provide clearer selected-state highlighting.

### Fixed
- **Share-page video tokens now refresh after tab focus/visibility return** � client share view now re-resolves short-lived video tokens after idle/AFK return to reduce expired-token playback failures.
- **Guest video links are no longer blocked when project guest mode is disabled** � guest video-link routes now allow token generation/refresh/lookup independent of `guestMode`, while still enforcing closed-project and expiry restrictions; the Guest Links dialog remains available from video actions, and full project guest links are still shown only when guest mode is enabled.

## [1.8.9] - 2026-05-27

### Fixed
- **ZIP and FSA bulk downloads now recreate the folder structure inside the archive** � selecting multiple video groups, album groups, or upload subfolders and downloading them via the main file browser or the VideoSidebar now places each group's files inside a named sub-folder (e.g. `Campaign Video/clip.mp4`, `UPLOADS/Test Folder/photo.jpg`) rather than dumping everything flat; this applies to both client-side ZIP streaming (via `client-zip`) and direct-to-disk FSA bulk downloads.
- **VideoSidebar Download All / Download Selected buttons now annotate files with folder paths** � both sidebar download handlers previously flattened files from groups without preserving group context, so `downloadFolderPath` was never set and the ZIP/FSA logic received unannotated files; both handlers now apply the same group-name annotation used by the main file browser.
- **"Use Chrome or Edge for large downloads" dialog now appears for VideoSidebar downloads** � the FSA-unsupported pre-flight check (size threshold exceeded + `showDirectoryPicker` unavailable) was only wired up in the main file browser; the VideoSidebar now performs the same check in both `handleDownloadAll` and `handleDownloadSelected` and shows the identical `ConfirmDialog` when triggered; the dead `showLocalModeWarning` inline banner has been removed.
- **Speed and Time left stats removed from above the Select All / Clear Selected buttons in VideoSidebar** � these duplicate metrics are already shown in the TRANSFERS panel below; only the "Downloading� X%" progress line is retained above the action buttons.

## [1.8.8] - 2026-05-27

### Added
- **`enableClientUploads` per-project and global-default setting** � admins can now toggle whether authenticated clients see the UPLOADS folder in the FILES mode of the Share page; when disabled the UPLOADS section is hidden from clients while admins continue to see it; the setting is available in both the global defaults and individual project settings pages with an on-by-default value.
- **Video asset preview and album social-copy jobs now appear in the Running Jobs bell** � the `RunningJobsBell` now shows live progress rows for active video-asset preview generation (grouped by project) and album social-copy derivative generation (grouped by album), both contribute to the badge count, and completion notifications are shown when each batch finishes.

### Changed
- **Share page password input now has `autoComplete="off"`** � share-page passwords are project-specific access codes, not user credentials; the browser will no longer offer to save or autofill them.

### Fixed
- **Share page now boots client to re-authentication when their share token expires** � a proactive JWT expiry timer fires client-side when the share token approaches expiry; the client is returned to the authentication screen rather than left on a broken page; if an active upload or download is in progress the timer waits until the transfer completes before redirecting.
- **Share sessions are now renewed during long transfers** � keepalive calls made by the share page (every ~5 minutes) now return a fresh share token from the server so clients engaged in lengthy uploads or downloads no longer hit an expired session mid-transfer.
- **Admin users viewing a share page are now redirected to admin login when their session expires** � previously an expired admin token on a share page silently failed API calls; the API client now detects the case where admin tokens were present and routes the 401 to the admin login page instead of showing a generic error.
- **Password field is cleared after successful share-page authentication** � the `password` React state is now reset on a successful verification response; if the re-authentication form is shown again (e.g. after session expiry) the field starts empty rather than showing the previously typed password.
- **Auto-delete-on-close now also clears `VideoAsset` preview files and metadata** � the auto-close worker previously deleted video preview MP4s and timeline sprites but never touched `VideoAsset.previewPath`; video asset preview files were left on storage and their DB metadata remained `READY`, which caused the storage integrity scan to falsely report missing companion JPG paths for those assets on closed projects; the worker now deletes each asset's preview file and nulls `previewPath`, `previewStatus`, `previewError`, `previewGeneratedAt`, and `previewFileSize` for all assets belonging to the newly-closed project, matching the behaviour of the manual "Delete previews for closed projects" action; the worker also now correctly deletes `timelinePreviewVttPath` files (previously only the sprite directory was deleted).
- **Preview reconciler now detects and re-enqueues video assets missing their companion JPG thumbnail** � `VideoAsset` records with `previewStatus = READY` and a `.mp4` `previewPath` (processed before companion-JPG generation was introduced) were never re-enqueued because the reconciler considered them fully complete; the reconciler now checks whether the companion `.jpg` file actually exists on storage for each such asset and re-enqueues any that are missing it.
- **Worker generates missing companion JPG without re-encoding the MP4** � when a video asset's MP4 playback preview already exists on storage but the companion JPG thumbnail is absent, the worker previously fell through to a full re-encode of both files; it now detects the `playbackExists && !thumbnailExists` state early and runs only the lightweight frame-extraction step to produce the missing JPG, leaving the existing MP4 untouched.
- **`.previews` directory now moved for album and video-group renames in all storage modes** � previously renaming an album or video group left all generated thumbnail and preview files under the old `.previews/` path; the rename routes and background S3 processor now move both the main content folder and its companion `{project}/.previews/albums/{folder}/` or `{project}/.previews/videos/{folder}/` tree; this applies to both local-filesystem and S3/R2 modes.
- **`thumbnailStoragePath` rebase now uses the correct `.previews` prefix after album rename** � the per-photo `thumbnailStoragePath` column was being rebased against the album storage root (e.g. `projects/x/albums/y/`) which never matched the actual thumbnail path (`projects/x/.previews/albums/y/`); it now uses the preview-specific prefix pair for that column.
- **Video group rename now correctly rebases all preview-path columns in the database** � after a group rename the video preview columns (`preview480Path`, `preview720Path`, `preview1080Path`, `thumbnailPath`, `timelinePreviewVttPath`, `timelinePreviewSpritesPath`) were being replaced using the main video folder prefix, which never matched those paths stored under `.previews/videos/`; they now use the correct `.previews/videos/{group}/` prefix pair.
- **`VideoAsset.previewPath` now rebased after project or client local rename** � the video asset preview-path column was missing from the select and update in the local-filesystem rename transactions for projects and clients; it is now included so asset previews stay accessible after a project or client is renamed.
- **S3 rename confirmation dialogs added for album, video-group, and video-version-label renames** � these three rename flows now return HTTP 202 with `{ requiresJobConfirmation: true }` when an S3 folder move would be required (matching the existing project/client pattern); the admin UI for albums (`AdminAlbumManager`), video groups (`AdminVideoManager`), and version labels (`VideoList`) now shows a confirmation modal explaining that files will be copied as a background job before enqueuing the work.
- **Video version label rename now correctly moves storage folders** � previously renaming a version label (e.g. "v1" ? "Final Cut") only updated the `versionLabel` field in the database while leaving all file paths pointing to the old folder name; both the main version folder (`videos/{name}/{label}/`) and its companion previews folder (`{project}/.previews/videos/{name}/{label}/`) are now moved; all stored path columns (`originalStoragePath`, `preview480/720/1080Path`, `thumbnailPath`, `timelinePreviewVttPath`, `timelinePreviewSpritesPath`) and `VideoAsset` paths are updated atomically; in local storage mode the moves and DB update happen inline in the request; in S3 mode a background `FolderRenameJob` (entity type `VIDEO_VERSION`) is created, the version label is updated immediately, and the S3 copy + DB path rebase run asynchronously with progress visible in the Running Jobs bell; if the sanitized folder name does not change (e.g. only capitalisation differs) no storage operation is performed.

## [1.8.7] - 2026-05-25

### Changed
- **All browser-native dialogs replaced with consistent in-app UI** � every remaining `confirm()`, `alert()`, and `prompt()` call across admin pages and shared components has been replaced with modal confirmation dialogs (`ConfirmDialog`) and toast notifications (`sonner`), giving the app a uniform interaction pattern and eliminating browser-chrome interruptions across sales, accounting, BAS, chart-of-accounts, bank accounts, vehicles, settings, and kanban pages.
- **Kanban Add Task / Edit Task close guard now works correctly** � Cancel and the ? button on the task dialog now close immediately when no changes have been made; if real edits are present a "Discard changes?" confirmation is shown instead of silently blocking close.

### Fixed
- **Storage integrity scan now recognizes companion JPG previews for video assets** � video-asset preview generation writes both an MP4 playback preview and a JPG card thumbnail; orphan/missing reference builders now include the canonical JPG companion path for video assets so valid preview thumbnails are no longer falsely reported as storage orphans.
- **Project reopen regeneration now respects configured preview resolutions and requeues all preview families** � reopening from CLOSED now checks each READY video against the project's selected preview resolutions (instead of only `preview720Path`), regenerates only missing preview/timeline/thumbnail work, and also requeues missing or stale share-upload and video-asset preview jobs.
- **Video-asset preview paths now stay aligned during rename flows** � single-video rename, batch video-group rename, and background folder-rename SQL rebases now keep `VideoAsset.previewPath` and its companion JPG path synchronized with moved storage roots/folders.
- **Closed-project preview cleanup now also removes Video Asset previews** � both auto-delete-on-close and the manual "Delete previews for closed projects" action now delete `VideoAsset.previewPath` files and clear related preview metadata on `VideoAsset` records.

### Removed
- **Developer Tools preview-path migration action has been removed** � the `POST /api/settings/migrate-preview-paths` endpoint, the backing preview-path migration module, and the Developer Tools UI controls/results for that action have been deleted.

## [1.8.6] - 2026-05-24

### Fixed
- **Running Jobs now exposes a quick clear action for stuck queued entries** � queued processing, album ZIP, album thumbnail, and folder rename rows now show a small top-right X that removes the item from the UI and best-effort clears the matching BullMQ job / DB record so stale queued work can be dismissed without restarting workers.

## [1.8.5] - 2026-05-24
 
### Fixed
- **Docker startup migration failure (Prisma P3009) caused by duplicate migration timestamp ordering** � the share-upload media metadata migration folder was retimestamped from `20260522000000_add_share_upload_media_metadata` to `20260522000001_add_share_upload_media_metadata` so it consistently runs after `20260522000000_add_share_uploads` (which creates `ShareUploadFile`), preventing production boot loops where `prisma migrate deploy` failed on app startup.

## [1.8.4] - 2026-05-24

### Added
- **Voice Note comments are now supported** � users can now add audio voice-note comments in the review flow, making feedback faster when typing is less convenient.
- **Share-page uploads now have a full API and storage pipeline** � added tokenized share-upload routes for list/create/download/content and S3 multipart presign/complete/abort flows, backed by new schema migrations for share uploads, media metadata, and preview fields.
- **Preview generation for share uploads is now first-class** � added folder-aware share-upload preview storage helpers and a dedicated `share-upload-preview` worker/queue path to generate and track preview artifacts.
- **Preview maintenance tools were added for operators** � Admin Developer Tools now include a preview-path migration action backed by `POST /api/settings/migrate-preview-paths` (dry run by default) with scanned counts, update totals, samples, and error reporting.
- **Project-level preview rebuild controls were added** � `POST`/`GET /api/projects/[id]/reprocess-previews` and related project actions now support cancelling in-flight preview jobs, deleting stale preview derivatives, and re-enqueueing video/share-upload/video-asset/album preview work.

### Changed
- **Share review/file-browse UX was refined after 1.8.3** � admin/client share pages, sidebar selection, and files-browser state handling were tightened for approval/download flows, including better handling of upload folders and transfer state.
- **Comment and file delivery routes were hardened** � comment file routes, share content delivery, and video-asset/share-upload download-token paths were updated together with S3 multipart handlers to keep upload/download behavior consistent.
- **Storage accounting now includes broader preview coverage** � project totals, orphan scans, local-to-S3 migration, and S3 local backup logic were extended to account for preview-derived files and updated preview path conventions.
- **Release validation assets were expanded** � added share uploads API/UI check scripts and planning/remediation docs for share uploads and previews.

### Fixed
- **Preview-path drift can now be repaired safely** � migration logic now reconciles stored preview paths for videos, timelines, album thumbnails, share uploads, and video assets against canonical project storage roots, with best-effort file moves.
- **Preview rebuilds now better preserve intended assets** � reprocess logic avoids clobbering custom video thumbnails and improves cleanup/requeue sequencing so regenerated previews align with current storage conventions.
- **Share/comment file handling edge cases were reduced** � recent updates to content-token and comment/share file flows address inconsistent playback/download outcomes seen in mixed preview and attachment scenarios.

## [1.8.3] - 2026-05-21

### Added
- **Authenticated share pages now include project switching and a dedicated Files view** � admin users can jump between share-enabled projects from the review page, authenticated clients can switch between their available projects from the public share flow, and both experiences now expose a new file browser for approved video masters, video assets, and album ZIP downloads with previews, folder grouping, and batch download support; guest sessions remain blocked from file downloads.

### Changed
- **The share experience has been reorganized around a cleaner review/download workflow** � the admin and client share pages now keep active-version state, sidebar selections, approval state, and downloadable-file lists in sync more tightly, add explicit View/Files tabs on desktop, and surface approved content as downloadable directly from the share UI instead of treating downloads as a separate flow.
- **Branding/theme handling has been simplified to a single dark presentation** � the dark-logo variant and theme toggle have been removed, public branding endpoints now consistently use the primary logo/favicon configuration, and the app now renders against an always-dark theme with fewer branding branches to maintain.

### Fixed
- **Primary branding assets now load correctly in S3 mode** � the public logo and favicon routes now serve uploaded branding files from S3-backed storage instead of assuming local disk, preventing broken branding on login/share surfaces when local storage is not active.
- **Approving a version now refreshes downloadable content without a page reload** � the share pages update local approval state immediately and refetch the downloadable-file inventory after approval, so the newly approved version becomes available in the Files view straight away.

## [1.8.2] - 2026-05-18

### Changed
- **Dropbox integration has been removed in favour of S3 to simplify the storage stack going forward** � legacy Dropbox-specific routes, workers, settings UI, docs, and storage-provider branches have been removed so uploads, delivery, and maintenance now converge on the S3-backed path with less code and fewer long-term compatibility surfaces.

### Fixed
- **Share-page approval banner no longer sticks to other unapproved videos until refresh** � the comment panel's optimistic approval state is now scoped to the specific video that was just approved, so switching to another unapproved video in the sidebar no longer incorrectly shows the "Video Approved" banner or download state.
- **Local-to-S3 dry run now checks S3 and reports what would actually be uploaded** � previously the dry run only inventoried local files and labelled all of them "files to copy", even when those objects already existed in S3; `dryRunLocalToS3Migration()` now accepts the S3 credentials entered in the form, performs concurrent `HeadObject` checks (20 parallel workers) against R2, and returns `alreadyInS3` (would skip) and `wouldCopy` / `wouldCopyBytes` (genuinely new uploads); the dry-run route forwards credentials from the request body; the UI passes credentials automatically and shows the new breakdown � "Already in S3 (would skip): N", "Files to copy: M", "Total bytes to copy: X" � with the sample list filtered to only files not yet present in S3.

## [1.8.1] - 2026-05-18

### Fixed
- **Video reprocess in S3 mode now recovers legacy Dropbox-backed original paths** � the worker no longer assumes the stored `originalStoragePath` is always the live S3 key; for older videos that once used Dropbox-backed storage it now probes the stored key, the stripped local-relative key, and the canonical rebuilt original path before downloading, preventing `NoSuchKey` failures during preview reprocessing.
- **Running Jobs no longer shows stale Dropbox entries when Dropbox is disabled or not configured** � Dropbox upload sections are now gated by current Dropbox configuration and `dropboxEnabled` on the underlying video or asset, so editing or reprocessing a project no longer resurrects old "Dropbox upload complete" or failed Dropbox rows unrelated to the current job.

## [1.8.0] - 2026-05-18

### Added
- **Accounting attachment path normalization tool** � Admin Settings > Developer Tools now includes a dry-run + repair action backed by `POST /api/settings/normalize-accounting-attachment-paths`, allowing legacy `AccountingAttachment.storagePath` rows stored as `accounting/FY...` to be previewed and normalized back to the canonical `FY...` format without moving files.
- **Local-to-S3 dry run now shows missing DB-referenced files** � `dryRunLocalToS3Migration()` now returns `missingKeys` in addition to counts, and the Developer Tools UI renders a dedicated sample list for storage paths referenced in the database but missing on local disk.

### Changed
- **Accounting path handling is now canonical across repair, backup, and migration flows** � `normalizeAccountingStoragePath()` centralizes legacy-path cleanup, strips any `accounting/` prefix safely, and is now used by `resolveAccountingFilePath()`, S3 local backup key generation, and local-to-S3 migration so old rows continue to resolve consistently while new rows remain in bare relative-path form.

### Fixed
- **Legacy accounting attachment rows no longer disappear from migration/backup scans** � local-to-S3 migration and S3-to-local backup now resolve `accounting/...`-prefixed database paths through the shared accounting path normalizer, so valid files are included instead of being treated as missing due to duplicated prefix handling.
- **Timeline sprite integrity scan recognizes both historical filename patterns** � missing-file checks now treat both `sprite-###.jpg` and `timeline-#.jpg` as valid sprite files in S3 and local storage, preventing false positives when older and newer sprite naming schemes coexist.

## [1.7.9] - 2026-05-18

### Added
- **Rate limiting on additional sensitive routes** � `rateLimit()` is now applied to: passkey manage (`DELETE`/`PATCH`, 20 req/min), password reset (`POST` 10 req/15 min, `GET` 20 req/15 min), comment S3 multipart complete (30 req/min), kanban card archive/unarchive (30 req/min), share video-token (120 req/min), security rate-limits read/delete (60/20 req/min); closes remaining gaps in API-level brute-force protection.
- **Deep-link URLs in admin push notifications for comments** � `buildAdminShareUrl()` helper generates `/admin/projects/{id}/share?video={name}&version={n}` links when a comment is on a specific video version; both `ADMIN_SHARE_COMMENT` and `CLIENT_COMMENT` push notification payloads now include `__link.href` pointing to the exact video on the share page, as well as `__meta` fields (`commentId`, `videoId`, `videoVersion`, `videoName`) for client-side routing.
- **Local-to-S3 migration handles directory-typed storage paths** � `buildMainLocalEntries()` now detects when a referenced DB path resolves to a directory (e.g. `timelinePreviewSpritesPath`) and enumerates its immediate children, uploading each child file individually under a `{key}/{child}` S3 key; previously these directories were silently counted as missing files.

### Changed
- **Storage integrity scan covers timeline sprite directories** � `buildMissingFilesReferences()` now fetches `timelinePreviewSpritesPath` for all videos and tracks sprite directory prefixes separately; `checkMissingFiles()` verifies sprite existence by matching `timeline-*.jpg` patterns in the S3 key set (or listing the local directory), so missing sprite sheets are correctly reported instead of silently skipped.
- **Album ZIP paths always included in missing-file checks** � previously `buildMissingFilesReferences()` only added album ZIP paths when the cached `fullZipFileSize`/`socialZipFileSize` was non-zero; the size gate is removed so stale or zero-cached sizes no longer hide real DB?storage mismatches.
- **`scannedDirectories` correctly reported in S3 mode** � `cleanupProjectStorageOrphans()` now sets `scannedStorageRoots = 2` for S3 runs (main namespace + `accounting/` prefix) instead of reporting `0` (the length of the empty local `roots` array).
- **`CLIENT_COMMENT` push notifications include metadata and link** � push notification payloads for client comments now carry `__meta` (commentId, videoId, videoVersion, videoName) and `__link.href` matching the `ADMIN_SHARE_COMMENT` pattern, enabling consistent deep-link navigation for both comment types.
- **Video query in comment notifications fetches `version` field** � `handleCommentNotifications()` now selects `version` alongside `name` and `versionLabel` so the correct numeric version is available when constructing deep-link URLs.

### Fixed
- **Push/bell notifications no longer blocked when SMTP is not configured** � `handleCommentNotifications()` previously returned early when SMTP was absent, preventing `sendPushNotification()` from running and leaving the in-app notification bell empty. The function now fires `CLIENT_COMMENT` and `ADMIN_SHARE_COMMENT` push/bell notifications unconditionally; the SMTP-required email path (immediate send / batch queue) is independently gated and skipped gracefully when SMTP is not configured.
- **`AccountingTrendChart` no longer shows a stale "Gross margin" stat** � the `totalCogsCents` memo and `grossMarginPct` calculation are removed; the summary line now shows only "Net Profit / Net Loss" to avoid displaying a misleading gross margin figure when COGS lines are not fully categorised.
- **Comment S3 multipart complete route handles DB failure gracefully** � the `CommentFile` create and `recalculateAndStoreProjectTotalBytes` calls are now wrapped in a `try/catch`; if the DB write fails after S3 upload completes the route logs the orphaned S3 key and returns a 500 instead of an unhandled exception.
- **Kanban archive/unarchive routes return structured errors on DB failure** � both `POST` (archive) and `DELETE` (unarchive) handlers are now wrapped in `try/catch` blocks that log the error and return `{ error: � }` with status 500 rather than propagating unhandled rejections.
- **Share video-token route wraps all DB lookups in a single `try/catch`** � previously an unhandled Prisma error mid-handler would surface as an unformatted 500; the route now returns `{ error: 'Failed to load video' }` with status 500.

## [1.7.8] - 2026-05-13

### Added
- **Album photo thumbnail generation** � a new `AlbumPhotoThumbnailStatus` enum and `AlbumThumbnailJob` model (migration `20260513000000_add_album_photo_thumbnails`) track background thumbnail creation per album; five new columns on `AlbumPhoto` (`thumbnailStoragePath`, `thumbnailStatus`, `thumbnailError`, `thumbnailGeneratedAt`, `thumbnailFileSize`) persist the result; a new `album-photo-thumbnail-processor` BullMQ worker uses `sharp` to produce 320 px long-edge JPEG thumbnails (quality 82) stored in a `thumbnails/` subfolder alongside the originals; both S3 and local storage modes are supported; per-photo progress is written to the `AlbumThumbnailJob` DB record after each photo; if pending photos remain after a run the job self-re-enqueues with a 2-second delay.
- **`enqueueAlbumThumbnailJob()`** � new helper (`src/lib/album-photo-thumbnail.ts`) that creates or reuses an `AlbumThumbnailJob` DB record, deduplicates PENDING jobs, and enqueues the BullMQ worker; called from the upload-finalize path, the share album list route, and the share album detail route.
- **`variant=thumbnail` on the photo content route** � `GET /api/content/photo/[token]` accepts `?variant=thumbnail` and serves the stored thumbnail when `thumbnailStatus === READY`; falls back to the social (2048 px) derivative if available, then to the original; a shared `streamInlineImage()` helper is extracted and used by both the thumbnail and preview paths.
- **Thumbnail URL exposed on share album APIs** � `GET /api/share/[token]/albums` now returns `thumbnailPhotoUrl` (replaces `previewPhotoUrl`) using `?variant=thumbnail`; `GET /api/share/[token]/albums/[albumId]` now returns `thumbnailUrl` and `thumbnailReady` per photo; both endpoints trigger `enqueueAlbumThumbnailJob` when thumbnails are not yet ready, providing lazy backfill for existing albums.
- **`buildAlbumPhotoThumbnailStoragePath()`** � new helper in `project-storage-paths.ts` that derives the thumbnail storage path (`thumbnails/` subfolder, filename normalised to `.jpg`).
- **Album thumbnail jobs in Running Jobs bell** � `GET /api/running-jobs` now includes `albumThumbnailJobs` (PENDING/IN_PROGRESS active jobs + recently completed/failed entries); `UploadManagerProvider` tracks them with the same completion-entry and dismiss pattern as other job types; `RunningJobsBell` renders an "Album Thumbnails" section with per-album progress bars and photo counts.
- **`reconcileAllAlbumZipSizes()`** � new function in `album-zip-size-sync.ts` that bulk-verifies all album ZIP file sizes against storage (S3 or local) using a 4-worker async pool; called at the start of `reconcileAllProjectsStorageTotals()` so the daily reconcile also heals stale ZIP size cached totals.
- **`getAlbumZipStoragePaths()`** � new convenience wrapper in `album-photo-zip.ts` returning both `full` and `social` ZIP paths in a single call; adopted across `album-zip-size-sync.ts`, `project-storage-orphan-cleanup.ts`, `local-to-s3-migration.ts`, and `s3-local-backup.ts` to replace duplicated path construction.
- **`finalizeAlbumPhotoUpload()`** � new `src/lib/album-photo-upload-finalize.ts` module encapsulating the full TUS upload-finish logic (mark `READY`, enqueue social + thumbnail + ZIP jobs, reset Dropbox tracking); the TUS handler now delegates to this function, removing ~100 lines of inline code from `pages/api/uploads/[[...path]].ts`.

### Changed
- **Thumbnail storage paths rebased on project/client/album rename** � `folder-rename-processor.ts` (all three path-rebase SQL blocks), `PATCH /api/projects/[id]`, `PATCH /api/clients/[id]`, and `PATCH /api/albums/[albumId]` now include `thumbnailStoragePath` in rebase operations alongside `storagePath` and `socialStoragePath`.
- **Thumbnail file size included in all storage totals** � `computeProjectTotalBytes`, `GET /api/projects/[id]/storage`, and `GET /api/settings/storage-overview` now aggregate `thumbnailFileSize` alongside `socialFileSize`; photo and album delete routes deduct `thumbnailFileSize` from project totals.
- **Thumbnail file deleted on photo and album delete** � `DELETE /api/albums/[albumId]/photos/[photoId]` and `DELETE /api/albums/[albumId]` now call `deleteFile(thumbnailStoragePath)` after removing the original and social derivative.
- **Thumbnail path stored at photo create** � `POST /api/albums/[albumId]/photos` pre-computes and stores `thumbnailStoragePath` using `buildAlbumPhotoThumbnailStoragePath()` so the path is available before the thumbnail worker runs.
- **S3 local backup includes thumbnail files** � `collectKeysForCategory('photoZipBytes')` now includes `thumbnailStoragePath` entries alongside social derivative and ZIP files.
- **Local-to-S3 migration includes thumbnail and album ZIP files** � `collectReferencedPaths()` now collects `thumbnailStoragePath` per photo and album ZIP paths (guarded by non-zero `fullZipFileSize`/`socialZipFileSize`) so thumbnails and ZIPs are included in a full local-to-S3 migration.
- **Storage integrity scan coverage expanded** � `buildMissingFilesReferences()` now tracks `thumbnailStoragePath` per photo, album ZIP paths (when non-zero size), video preview/thumbnail/timeline paths, user avatar paths, and company logo/favicon/dark-logo paths; the orphan scan (`buildProjectStorageReferences()`) also registers `thumbnailStoragePath` so thumbnail files are not misreported as orphans.
- **`ShareAlbumViewer` and `VideoSidebar` use thumbnail URL** � the photo grid now uses `thumbnailUrl || previewUrl || url` priority order; both components accept `thumbnailPhotoUrl` (renamed from `previewPhotoUrl`) for album cover images; admin share page updated to pass `thumbnailPhotoUrl`.
- **Thumbnail jobs cancelled on project delete** � `cancelProjectJobs()` now also removes any pending BullMQ `album-photo-thumbnail` jobs for the project's albums.
- **BullMQ purge route queue names corrected** � `POST /api/settings/purge-bullmq-jobs` fixes stale queue names (`album-photo-social-processing` ? `album-photo-social`, `album-photo-zip-processing` ? `album-photo-zip`) and adds `album-photo-thumbnail` to the purge list.
- **Excel and PowerPoint files accepted as project and video asset documents** � `.xls`, `.xlsx`, `.ppt`, `.pptx` added to `ALLOWED_ASSET_EXTENSIONS.document` and to `ALLOWED_ASSET_TYPES.document` (with correct MIME types) so spreadsheets and presentations can be attached to projects and shared with clients.

### Fixed
- **`ProjectEmailUpload` completed uploads auto-clear after 1.5 seconds** � a `useEffect` now removes completed queue entries 1.5 s after they appear so the upload list does not accumulate stale "completed" rows requiring manual dismissal.
- **Sales Dashboard Projects Overview chart no longer produces invalid dimension warnings** � `ResponsiveContainer` switched from a fixed `height={220}` to `height="100%"` with `minHeight={220}` so the chart renders correctly before the container has laid out its final height.

## [1.7.7] - 2026-05-12

### Changed
- **S3 file downloads now use presigned URL redirects instead of server-side proxying** � all file download routes (project files, client files, user files, video assets, project comment attachments, project email attachments, comment files, album photos, photo ZIPs) now call `isS3Mode()` and return a `302 NextResponse.redirect` to a presigned `GetObject` URL; inline email attachments use `s3GetPresignedStreamUrl()`; download attachments use `s3GetPresignedDownloadUrl()`; eliminates server-side stream proxying in S3 mode, reduces Next.js memory/CPU load, and allows browsers to show native download progress; local-mode behaviour unchanged. Routes changed: `clients/[id]/files/[fileId]`, `comments/[id]/files/[fileId]`, `content/photo-zip/[token]`, `content/photo/[token]`, `projects/[id]/comment-attachments/[fileId]`, `projects/[id]/emails/[emailId]/attachments/[attachmentId]`, `projects/[id]/files/[fileId]`, `users/[id]/files/[fileId]`, `videos/[id]/assets/[assetId]`.
- **File download clients detect S3 presigned redirect and skip blob buffering** � `CommentSection`, `ProjectFileList`, and `ProjectReadonlyAttachmentList` now inspect `response.url` after `fetch()`; if the resolved URL is external (not `window.location.origin`), they cancel the response body and trigger a direct anchor-click instead of buffering to a Blob; browsers show native download progress bars for S3-stored files.
- **S3 file type validation now uses a ranged GET instead of a full download** � `project-file-processor`, `user-file-processor`, and `client-file-processor` workers now call `s3ReadFileHeader(storagePath, 4100)` for magic-byte detection instead of materializing the entire file via `materializeStoragePathToLocalFile()`; reduces S3 egress and eliminates unnecessary disk I/O in S3 mode.
- **SVG client file sanitization in S3 mode no longer requires a temp-file download** � `client-file-processor` downloads the full SVG body into memory via `s3DownloadFileToBuffer()` in S3 mode, then writes the sanitized content back with `uploadFile()`; the `materializeStoragePathToLocalFile()` path is kept as the local-mode fallback.
- **S3 local backup now supports a dry run** � `runS3LocalBackup()` accepts `options.dryRun` which counts files that `wouldDownload` without writing to disk or updating the DB; `POST /api/settings/s3-local-backup/run` now accepts `dryRun: true` in the request body; `formatBackupResultSummary()` produces a dry-run-specific summary; a "Dry run" button is added to the Local Backup panel alongside "Run backup now".
- **`ProjectFileUpload` drag-and-drop target is now the "Add Files" button** � drag-over/drag-leave/drop handlers are moved from an outer `<div>` to the button itself (now a native `<button>`); `isDragging` state gives visual feedback (`border-primary bg-primary/10`) while files are dragged over; the button is otherwise visually equivalent.
- **`materializeStoragePathToLocalFile()` creates `tempDir` before writing** � `fs.promises.mkdir(params.tempDir, { recursive: true })` is called before writing the downloaded S3 file, preventing `ENOENT` when the temp directory does not yet exist.

### Added
- **`s3ReadFileHeader(key, bytes)`** � new S3 helper that issues a `Range: bytes=0-{bytes-1}` `GetObject` and returns `{ data: Buffer; totalSize: number }`; used by file-processor workers for efficient magic-byte detection.
- **`s3DownloadFileToBuffer(key)`** � new S3 helper that streams an entire S3 object into a single `Buffer`; used by `client-file-processor` for SVG sanitization in S3 mode.

### Removed
- **Dead video download route removed** � `GET /api/videos/[id]/download` was never called by the UI (all video downloads go through the `download-token` ? `/api/content/[token]?download=true` flow); the route also had a latent S3 bug where it would produce a streaming presigned URL instead of a `Content-Disposition: attachment` URL. Route deleted.
- **Asset batch ZIP routes removed** � `POST /api/videos/[id]/assets/download-zip`, `POST /api/videos/[id]/assets/download-zip-token`, and `GET /api/content/zip/[token]` are deleted; the UI button that triggered asset ZIP downloads was already removed in a previous release, leaving these three routes with no callers.

### Fixed
- **S3 mode: user avatar now served correctly** � `GET /api/users/[id]/avatar` previously read from local disk in all modes; in S3 mode it now checks `s3FileExists()` and returns a `302` redirect to a presigned `GetObject` URL, matching the pattern used by all other S3 content routes.
- **S3 mode: album thumbnails now display in the video sidebar** � `VideoSidebar` was using Next.js `<Image>` (which proxies through `/_next/image`) for album preview photos; the Next.js image optimizer does not follow S3 presigned-URL redirects, so thumbnails were blank. Changed to a plain `<img>` tag with `loading="lazy"` so the browser fetches and follows the `302` redirect directly.
- **Email attachments section now appears after email processing completes** � the "Email Attachments" panel in the admin project page is conditionally rendered based on `project.emailAttachmentsCount`; the `onExternalFilesChanged` callback (fired by `ProjectEmailTable` when processing finishes) now also calls `fetchProject()` to refresh that count, so the section appears without a manual page reload.
- **`CLIENT_COMMENT` notification queue entries no longer accumulate as `pending=clients`** � `queueNotification()` now pre-marks `sentToClients=true` for `CLIENT_COMMENT` type entries at creation time. The client-side worker (`processClientNotifications`) only processes `ADMIN_REPLY` type; it never touches `CLIENT_COMMENT` rows, so any project using a non-IMMEDIATE / non-NONE client notification schedule would build up a permanent backlog of `pending=clients` entries that could never be cleared. Admin emails were unaffected (delivered as normal), but the Dev Tools backlog view showed these entries as perpetually unsent.
- **`ADMIN_REPLY` notification queue entries no longer accumulate as `pending=clients` when all client recipients have notifications disabled** � `processClientNotifications()` now marks the affected entries `sentToClients=true` immediately when `getProjectRecipients()` returns no enabled recipients, rather than silently skipping them. Previously these entries would stay in the backlog permanently since no subsequent run would ever clear them.
- **Storage Overview "Recalculate & refresh" icon now spins during the data reload phase too** � the spinner was only active while `recalculateProjectDataTotalsLoading` was true; it now also animates while `loading` is true, and the button is disabled during both phases.

## [1.7.6] - 2026-05-11

### Added
- **S3 ? local backup** � new "Local Backup" panel in Admin Settings � Storage Overview (visible when S3 is active). A daily scheduled job (10 PM) copies files from S3 to local storage at the exact paths they would occupy under local-storage mode. Files already present locally with a matching size are skipped; local-only files are never modified or deleted. Five new `Settings` columns track the feature (`s3LocalBackupEnabled`, `s3LocalBackupCategories`, `s3LocalBackupLastRunAt`, `s3LocalBackupLastRunResult`, `s3LocalBackupRunning`). A **Backup** checkbox column appears in the storage breakdown table when the feature is enabled � each category (Original Videos, Video Previews, Video Assets, Comment Attachments, Original Photos, Photo ZIPs, Communications, Project Files, Client Files, User Files, Accounting Files) can be independently included or excluded.
- **Manual backup trigger with live progress** � a "Run backup now" button in the Local Backup panel starts an immediate backup run via `POST /api/settings/s3-local-backup/run`. Progress (current category, file counts, download/skip totals) is written to the DB every 3 seconds and polled by the UI every 2 seconds with a spinning indicator. Polling auto-stops when the run finishes, including runs triggered by the scheduler.
- **Backup failure notifications** � when a scheduled or manual backup finishes with failures, a pinned system notification is created in the admin notification bell (requires manual clear) and a browser push notification is sent to all eligible admin users via `upsertS3BackupFailureNotification()`.

### Changed
- **Accounting file storage is now S3-aware** � all accounting attachment operations (write, read, delete, move, path-building, filename deduplication) now branch on `isS3Mode()` and store files under an `accounting/` S3 key prefix when S3 is active; local behaviour is unchanged; new `ACCOUNTING_S3_PREFIX` constant exported from `file-storage.ts`.
- **`AccountingAttachment.fileSize` field** � new `Int` column (migration `20260511000002_add_accounting_attachment_file_size`) records the byte size of each attachment after any image processing; used by delta-tracking helpers to keep the cached accounting storage total up to date without a full directory scan.
- **`Settings.accountingFilesBytes` cached total** � new `BigInt` column (migration `20260511000001_add_accounting_files_bytes_to_settings`) persists the aggregate size of all accounting attachments; written atomically on upload/delete via `adjustAccountingFilesBytes()` and reconciled daily via `reconcileAccountingFilesBytes()`; surfaced in Storage Overview.
- **`adjustAccountingFilesBytes(delta)`** � new helper in `accounting/file-storage.ts` that applies an incremental `+/-` delta to `Settings.accountingFilesBytes` using a raw `UPDATE � GREATEST(0, �)` so the cached value stays consistent across concurrent uploads and deletes without a full scan.
- **`reconcileAccountingFilesBytes()`** � new function that performs a full walk (local disk or S3 `ListObjectsV2`) to recompute and persist the true accounting files byte total; called by the daily `reconcile-project-total-bytes` worker job and by the manual "Recalculate & refresh" button in Storage Overview.
- **`getAccountingS3TotalBytes()` / `getAccountingLocalTotalBytes()`** � new helpers that enumerate accounting storage via `s3GetDirectorySizeInfo()` (S3) or a recursive directory walk (local) and return the byte total.
- **`listAccountingS3Keys()` / `listAccountingLocalFiles()`** � new helpers that enumerate all accounting files in S3 or local storage for use by the orphan-file scanner.
- **Accounting orphan scan added to weekly orphan-file cleanup** � `scanAccountingOrphans()` now runs as part of `cleanupProjectStorageOrphans()`; it compares all `AccountingAttachment.storagePath` records against S3 keys (or local files) and reports/deletes unlinked files; a dedicated `pruneEmptyAccountingDirectories()` function prunes empty local directories after deletion.
- **Accounting files included in local-to-S3 migration** � `buildLocalManifest()` now calls `buildAccountingLocalEntries()` in parallel with the main storage pass; accounting files are read from `ACCOUNTING_STORAGE_ROOT` and uploaded to S3 under `accounting/<relPath>`, so a full local-to-S3 migration moves both project and accounting storage in a single job.
- **SVG files now accepted as project and client image assets** � `.svg` added to `ALLOWED_ASSET_EXTENSIONS.image`; the client file processor sanitizes SVG content server-side (strips `<script>` tags, event-handler attributes, and `javascript:` URIs) before writing/replacing the stored file; the client file download route forces `Content-Type: application/octet-stream` for SVGs as defence-in-depth so browsers cannot execute them inline.
- **`toAccountingS3Key(relativePath)`** � exported utility that converts a DB-stored relative accounting path to the full S3 key with `accounting/` prefix.
- **Storage integrity scan � missing files detection** � the weekly `orphan-project-files-scan` job and the Dev Tools manual trigger now perform a two-way check: orphan files (exist on storage but have no DB record) are detected and optionally deleted as before; missing files (DB record references a path that no longer exists on storage) are now detected and reported separately; in S3 mode both checks reuse the single `ListObjectsV2` result so no extra API calls are made; in local mode `fs.access` is called per path; accounting attachments are included in both directions alongside all primary uploaded file types (videos, video assets, project/comment/client/user files, album photos, email raw files and attachments).
- **Dev Tools "Storage integrity scan" section** � the "Orphan project files cleanup" section in Admin Settings � Developer Tools is renamed to "Storage integrity scan"; the description and results display now cover both orphan and missing file counts; the sample paths panel shows separate blocks for orphan paths and missing paths; the action button is relabelled "Clean up orphans" with a confirm dialog that clarifies missing files are not deleted and must be re-uploaded manually.
- **Pinned storage-integrity system notification updated** � the weekly scan notification title is now "System alert: storage integrity issues detected"; the message and details rows distinguish between orphan files (storage ? DB) and missing files (DB ? storage) with separate counts and sample path sections; the notification fires when either count is non-zero.
- **Storage Overview now includes an "Accounting Files" row** � `GET /api/settings/storage-overview` reads `Settings.accountingFilesBytes` from the DB and includes it in the `breakdown` response; the `StorageOverviewSection` component renders it alongside Videos, Albums, Project Files, Client Files, and User Files; the grand `totalBytes` figure now incorporates accounting file size.
- **Daily storage reconcile includes accounting files** � the `reconcile-project-total-bytes` worker job and the manual `POST /api/settings/reconcile-project-data` endpoint now call `reconcileAccountingFilesBytes()` in parallel with `reconcileAllProjectsStorageTotals()`; both surfaces log the resulting `accountingFilesBytes` value.
- **Accounting attachment upload routes persist `fileSize` and call `adjustAccountingFilesBytes`** � the BAS period, expense, and bank transaction attachment `POST` handlers (and the `DELETE` handler in `attachments/[id]`) now write `fileSize` on create and call `adjustAccountingFilesBytes(�delta)` so the cached total stays current without waiting for the daily reconcile.
- **Accounting attachment `GET` route is now S3-aware** � `GET /api/admin/accounting/attachments/[id]` reads the file via `readAccountingFile()` (which handles both local and S3) instead of a hardcoded `fs.readFile` call; the `resolveAccountingFilePath` / `fs.stat` path is kept as the local-mode fallback.
- **Orphan-file main scan now excludes the `accounting/` S3 prefix** � `isIgnoredStoragePath()` skips any key that starts with `accounting/` or equals `accounting` so that accounting files are never misreported as orphans by the primary scan; they are handled exclusively by `scanAccountingOrphans()`.
- **`POST /api/projects` response now serialises `previewBytes` and `diskBytes`** � the project creation endpoint previously only converted `totalBytes`; `previewBytes` and `diskBytes` are now also passed through `asNumberBigInt()` so the response never contains raw `BigInt` values that cause `JSON.stringify` to throw.
- **Video upload `storageBackend` response now reports `s3` when S3 is active** � `POST /api/videos` previously returned only `'dropbox'` or `'local'`; it now checks `isS3Mode()` and returns `'s3'` / `'dropbox'` / `'local'` so clients can correctly label the active backend; the server-side log line is updated to match.
- **Storage provider label in Storage Overview simplified** � "S3 tracked data" ? "S3", "Local tracked data (Dropbox mirrored)" ? "Local & Dropbox", "Local tracked data" ? "Local".
- **"Recalculate & refresh" button in Storage Overview waits for the recalculate call to complete before reloading data** � `onClick` handler is now `async`; `setHasLoaded(false)` runs only after `onRecalculateProjectDataTotals()` resolves, preventing a stale-data flash; `onRecalculateProjectDataTotals` prop type updated to `() => Promise<void>`.
- **"Dropbox Storage" section removed from Admin Settings** � the `DropboxStorageSection` component, its sidebar entry ("Dropbox Storage"), and the associated `dropboxConfigured` / `dropboxRootPath` state are removed from the settings page; Dropbox connection status is surfaced elsewhere.
- **Spaces now preserved in sanitized filenames** � all filename-sanitization regexes across the codebase (file-validation, fileUpload, storage-provider, storage-provider-dropbox, albums photos, video assets, content ZIP) now use `[^a-zA-Z0-9 ._-]` (space included) so filenames like `"My Video 2026.mp4"` are no longer mangled to `"My_Video_2026.mp4"`.

### Fixed
- **Accounting attachment download no longer fails in S3 mode** � the `GET /api/admin/accounting/attachments/[id]` route previously always resolved a local filesystem path and would 404 for any attachment stored in S3; it now calls `readAccountingFile()` which handles both providers transparently.
- **Accounting attachment `move` is now S3-aware** � `moveAccountingFile()` in S3 mode performs a `CopyObject` + `DeleteObject` to the target S3 key and returns the new relative path; the local filesystem move path is unchanged.
- **Accounting attachment existence check is now S3-aware** � `accountingFileExists()` checks S3 via `GetObject` head-check instead of `fs.access` when in S3 mode.

### Security
- **`next` upgraded 16.2.3 ? 16.2.6** � resolves 13 high-severity CVEs including DoS via server components and cache components, XSS in App Router CSP nonces and `beforeInteractive` scripts, cache poisoning via RSC cache-busting and RSC responses, SSRF via WebSocket upgrades, and multiple middleware/proxy bypass issues (GHSA-8h8q-6873-q5fj, GHSA-ffhc-5mcf-pf4q, GHSA-vfv6-92ff-j949, GHSA-gx5p-jg67-6x7h, GHSA-mg66-mrh9-m8jx, GHSA-h64f-5h5j-jqjh, GHSA-c4j6-fc7j-m34r, GHSA-492v-c6pp-mqqv, GHSA-wfc6-r584-vfw7, GHSA-267c-6grr-h53f, GHSA-36qx-fr4f-26g5, GHSA-3g8h-86w9-wvmq, GHSA-26hh-7cqf-hhc6).
- **Nested `postcss` 8.4.31 ? 8.5.14** � the `postcss` version bundled inside `next/node_modules` is now resolved to 8.5.14 via the `overrides` configuration, removing the patched copy and resolving a moderate XSS vulnerability where unescaped `</style>` sequences in CSS stringify output could break out of an HTML `<style>` context (GHSA-qx2v-qp2m-jg93).

## [1.7.5] - 2026-05-11

### Added
- **Background S3 folder rename jobs for projects, clients, albums, and video groups** � a new `FolderRenameJob` database model (migration `20260511000000_add_folder_rename_jobs`) and a dedicated BullMQ worker (`folder-rename-processor.ts`) now handle S3 prefix moves asynchronously; the worker paginates through all objects under the old prefix, copies them one-by-one with throttled progress writes to the DB (every 4 seconds), then rebases all storage paths in the database via bulk raw SQL and deletes the source objects; the worker runs with `concurrency: 1` and a 10-minute lock duration so large renames never timeout; on failure the source objects remain intact so data is never lost.
- **Rename confirmation modal for projects and clients in S3 mode** � before starting a heavy background rename the server returns HTTP 202 with `requiresJobConfirmation: true`; the project settings and client detail pages now detect this response and show a modal that loads and displays the object count and total gigabytes from the new `rename-size` endpoint, with a "Start rename in background" button that calls the `rename-confirm` endpoint to commit the title change and enqueue the worker.
- **`GET /api/projects/[id]/rename-size` and `GET /api/clients/[id]/rename-size`** � pre-flight endpoints that enumerate all S3 objects under the entity's current storage prefix via paginated `ListObjectsV2` and return `{ totalObjects, totalBytes }` to the rename confirmation modal.
- **`POST /api/projects/[id]/rename-confirm` and `POST /api/clients/[id]/rename-confirm`** � confirmation endpoints that apply the new title to the database immediately, create a `FolderRenameJob` record, and enqueue the background copy; `storagePath` is intentionally left unchanged until the worker completes.
- **`POST /api/projects/[id]/files/s3/presign|complete|abort`** � three new browser-direct multipart upload endpoints for project file attachments in S3 mode, mirroring the existing comment/user/client S3 upload pattern.
- **`s3GetDirectorySizeInfo()`** � new S3 helper that paginates `ListObjectsV2` under a prefix and returns total object count and byte sum; used by the `rename-size` endpoints.
- **`s3MoveDirectoryWithProgress()`** � new S3 helper that performs a full prefix copy + delete and invokes a progress callback after each object is copied; used by the background rename worker.
- **`s3CopyObjectWithFallback()`** � internal S3 helper that automatically uses `UploadPartCopy` (multipart) for objects larger than 5 GB during background rename jobs, completing or aborting the multipart session as needed; objects at or below 5 GB use a single `CopyObject` call.

### Changed
- **`moveDirectory()` in `storage.ts` is now S3-aware** � delegates to `s3MoveDirectory()` when `isS3Mode()` is true; local filesystem move otherwise; previously S3 renames fell through to the local path handler.
- **Album rename in S3 mode enqueues a background job instead of blocking** � album PATCH no longer calls `moveDirectory()` synchronously or rebases photo paths inline when S3 is active; a `FolderRenameJob` is created and enqueued, and the worker handles both the S3 copy and the DB path rebase.
- **Batch video-group rename in S3 mode enqueues a background job instead of blocking** � `PATCH /api/videos/batch` now creates a `FolderRenameJob` in S3 mode and skips the inline video/asset path rebase; the worker applies the correct prefix after the copy completes.
- **RunningJobsBell now tracks folder rename jobs** � active `FolderRenameJob` records (PENDING/IN_PROGRESS) appear in the jobs panel with entity name, type label ("Project" / "Client" / "Album"), and copy progress (objects copied and bytes); completed and failed renames surface in the notification list; `folderRenameJobs.length` is included in the total active count badge.
- **`ProjectFileUpload` now uses browser-direct S3 multipart upload in S3 mode** � up to 4 concurrent part uploads via `XMLHttpRequest` with per-part progress tracking, abort support, and presign / complete / abort API calls; TUS behaviour is unchanged in local and Dropbox modes; cancellation aborts the in-flight multipart session on R2.
- **Client/project/user file processors now use `materializeStoragePathToLocalFile()`** � replaced the direct `getFilePath()` call so file-type magic-byte validation works correctly when files are stored in S3 (the processor downloads the file to a local temp directory before reading magic bytes).
- **`UploadManagerProvider` exposes and tracks `folderRenameJobs`** � the provider polls the running-jobs endpoint for active folder rename jobs, emits client-side completion entries when a job disappears between polls, and also surfaces server-reported completed/failed entries; the context type now includes `folderRenameJobs: FolderRenameJob[]`.

### Fixed
- **`ensureRedisReady()` handles all Redis connection states without spurious errors** � new helper in `redis.ts` correctly waits for the `ready` event when the client is already in a `connecting` or `reconnecting` state instead of calling `connect()` again and triggering "Redis is already connecting/connected" errors; all rate-limit functions (`getRateLimitEntry`, `setRateLimitEntry`, `deleteRateLimitEntry`, `unblockIpAddress`, `getRateLimitedEntries`, `clearRateLimitByKey`) now use this helper consistently.
- **QuickBooks token-refresh job is only scheduled when the integration is configured** � the worker now calls `getQuickBooksConfig()` at startup and skips the daily `quickbooks-refresh-token` repeatable BullMQ job when QuickBooks is not set up, logging which config keys are missing; `quickbooks-refresh-token` is also added to the deduplication list so existing stale jobs are not duplicated on restart.
- **Dropbox upload worker skips jobs silently when Dropbox is disabled** � both video and asset Dropbox upload jobs now detect `!isDropboxStorageConfigured()` at the start of processing, clear the `dropboxUploadStatus` / `dropboxUploadProgress` / `dropboxUploadError` fields on the relevant DB record, and return gracefully instead of throwing; this prevents BullMQ retry loops and clears stale "uploading to Dropbox" indicators for users who have migrated away from Dropbox.
- **VideoSidebar now always shows the approved version's thumbnail** � fixed a bug where, if an earlier version of a video was approved but a newer (unapproved) version existed, the sidebar would show the thumbnail for the newest version instead of the approved one. Now, if any version is approved, its thumbnail is always shown in both admin and client share views.

## [1.7.4] - 2026-05-10

### Fixed
- **S3 rename operations now move physical files for all project-level renames** � renaming projects, clients, albums, individual videos, and batch video names previously updated database paths but did not move S3 keys because folder moves only handled local filesystems; `moveDirectory()` is now provider-aware and calls a new S3 prefix move helper (`copy + delete`), so storage keys are renamed in S3 alongside DB path updates.
- **Large S3 rename copies now support files over 5GB** � S3 key moves now automatically use multipart copy for large objects during rename operations (`UploadPartCopy` with complete/abort handling), avoiding single-request copy limits and ensuring project/client/album/video rename paths remain reliable for very large media files.
- **Custom video thumbnails now resolve correctly in S3 mode** � video assets and thumbnails set while Dropbox was active carry a `dropbox:` prefix in the database; the content delivery route now strips this prefix before checking S3 file existence, allowing legacy custom thumbnails to be found and served via presigned URLs.
- **Download modal no longer shows Dropbox toggle for legacy videos** � the share token endpoint and video-statuses admin route now mask `dropboxEnabled` to `false` when `isDropboxStorageConfigured()` returns false, so the Dropbox/Local Server toggle does not appear in the download modal for videos that were previously Dropbox-enabled but Dropbox is no longer configured.
- **Project settings save no longer fails with "Operation Failed"** � the PATCH response was missing the `previewBytes` BigInt field conversion, causing `JSON.stringify` to fail with "Do not know how to serialize a BigInt"; added conversion of `previewBytes` alongside `totalBytes` and `diskBytes` using the existing `asNumberBigInt()` helper.
- **Dropbox folder move operations now guarded when Dropbox is disabled** � project rename, album rename, video rename, client rename, and batch video-name-update operations now check `isDropboxStorageConfigured()` before calling `moveDropboxPath`, preventing attempts to rename Dropbox folders when Dropbox integration is not active; this applies to all 5 rename routes and eliminates spurious console messages.
- **Dropbox storage consistency scan no longer runs when Dropbox is disabled** � the periodic consistency scan job (hourly at :15) is now only scheduled if Dropbox is configured at worker startup; the job handler also now logs "Dropbox scan skipped" instead of "Running" when the scan returns a skipped result, eliminating confusing log spam when Dropbox is not enabled.

## [1.7.3] - 2026-05-10

### Fixed
- **Project storage totals are now consistent across Dashboard, Project Data, and Storage Overview** � added a new `Project.previewBytes` field (migration `20260510000000_add_project_preview_bytes`) so S3 preview storage is persisted in the database and reused across all views; the Projects dashboard now reads `totalBytes + previewBytes` in S3 mode, the per-project storage endpoint uses stored `previewBytes`, and Storage Overview aggregates `SUM(totalBytes)` plus `SUM(previewBytes)` for consistent totals.
- **Project Data and Storage Overview no longer perform live S3 fan-out checks on page load** � removed per-request S3 object-size scans for video previews and album ZIP files from the project storage and settings storage-overview APIs; totals now rely on worker-maintained DB fields, avoiding socket-pool pressure and dashboard slowdowns from repeated `HeadObject`/prefix-size calls during routine page loads.
- **Storage totals refresh immediately after video processing instead of waiting for nightly reconcile** � all video worker completion paths (`full`, `preview-only`, `thumbnail-only`, and `timeline-only`) now recalculate and store `totalBytes`, `previewBytes` (S3 mode), and `diskBytes` (local mode) in parallel after each job, so the Projects list and Project Data panel reflect updated usage as soon as processing finishes.

## [1.7.2] - 2026-05-10

### Changed
- **Inter font preload disabled** � root layout now sets `preload: false` for `next/font/google` Inter to reduce repeated browser warnings about preloaded font files not being used immediately after page load.
- **Accounting pages UI tweaks** - several small UI tweaks for both desktop and responsive designs.

### Fixed
- **Orphan file scan now storage-provider-aware** � the weekly orphan-file cleanup scan was not detecting whether files resided in S3 or local storage, causing false-positive orphan reports when running in S3 mode; the scan now branches on `isS3Mode()` and when S3 mode is active, lists all S3 bucket objects, compares them against database references, and deletes unreferenced files from S3; in local mode it continues using the existing filesystem walk; S3 mode respects the same protected/ignored file patterns as local mode.
- **User and client file uploads are now storage-provider-aware** � `UserFileUpload` and `ClientFileUpload` previously always used TUS regardless of the active storage provider; both components now check `isS3Mode()` at upload time and, when S3 is active, perform browser-direct multipart uploads to R2 via new `POST /api/users/[id]/files/s3/presign`, `/complete`, and `/abort` endpoints (and equivalent `/api/clients/[id]/files/s3/` routes); the DB record and processing queue job are now created in the `/complete` handler after R2 confirms the upload; cancellation aborts any in-flight multipart upload synchronously; TUS behaviour is unchanged in local/Dropbox mode.
- **Authentication hardening for token, passkey, and password flows** � refresh-token reuse after rotation now revokes the full token family; `/api/auth/logout` now fails closed with `503` when token revocation cannot be completed; passkey authenticate-options no longer leaks account/passkey existence; and password length is now capped at 128 characters in hash/verify/validate paths (with matching reset-password input limits).
- **Local-to-S3 migration now supports files larger than 5 GiB** � the migration worker previously used a single `PutObject` request per file, which S3-compatible providers reject above 5 GiB; files at or above the configurable multipart threshold (default 64 MB) are now uploaded via `@aws-sdk/lib-storage` multipart upload; part size (5�512 MB) and parallel queue size (1�8) are also configurable from the Developer Tools UI and are reported in the live status panel.
- **Local-to-S3 migration cancel now aborts in-flight transfers immediately** � clicking Cancel previously only set a flag checked between files, so a large active upload would continue until it finished or errored; the worker now tracks active `AbortController` instances for single-part uploads and `Upload` handles for multipart uploads, and `cancelLocalToS3Migration` aborts all of them synchronously so transfers stop as quickly as the SDK allows; abort errors are treated as cancellation rather than failures and do not increment the error counter.
- **Accounting dashboard sales settings endpoint mismatch** � corrected the Sales settings fetch path from `GET /api/sales/settings` to `GET /api/admin/sales/settings`, eliminating recurring 404s and ensuring fiscal-year/currency values are sourced from the admin route.
- **Sales Dashboard Recharts container warning** � Projects Overview now renders its chart in a stable, explicit-height container (`height={220}` with `minWidth={0}`) instead of `height="100%"`, preventing the warning about invalid chart dimensions (`width(-1)` / `height(100%)`) during initial layout measurement.

## [1.7.1] - 2026-05-09

### Fixed
- **CI workflow updated for Node.js 24 compatibility** � upgraded `actions/checkout` from `v4.2.2` to `v4.3.1` and `actions/setup-node` from `v4.4.0` to `v5.0.0`, both of which natively target Node.js 24; removed the `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` env workaround that was causing the `rbac-lint-tsc` job to exit with code 1 on GitHub Actions runners.

## [1.7.0] - 2026-05-09

### Added
- **S3-compatible storage provider (Cloudflare R2)** � new `STORAGE_PROVIDER=s3` mode with browser-direct multipart uploads, presigned delivery URLs, and server-side S3 helpers (`src/lib/s3-storage.ts`); Docker and env templates now include full S3/R2 configuration (`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, keys, and path-style toggle), and build/runtime provider values are wired through `Dockerfile` and compose files.
- **Runtime storage-provider API for the client** � added `GET /api/meta/storage-provider` plus client helper `src/lib/storage-provider-client.ts` so frontend upload flows can reliably branch at runtime between TUS and S3 in prebuilt Docker images.
- **Comment-file S3 multipart endpoints** � added `POST /api/comments/[id]/files/s3/presign`, `/complete`, and `/abort` to support direct-to-R2 comment attachment uploads with auth checks, completion metadata write, and best-effort abort cleanup.
- **Developer Tools local-to-S3 migration utility** � added admin settings endpoints and UI controls to validate one-time S3 credentials, run a dry-run inventory of database-referenced local files, start a background local-to-S3 copy, poll live migration progress (percent, bytes, files, speed, ETA), and cancel in-flight migration jobs. This workflow intentionally does not switch runtime provider; cutover still occurs later by updating `.env` and restarting services.

### Changed
- **Core storage layer is now provider-aware** � `src/lib/storage.ts` and `src/lib/storage-provider.ts` now route upload/download/delete and materialization logic through S3 when enabled, including temp-file handling for worker processing and presigned stream/download redirects for content delivery.
- **Video, asset, album-photo, and comment upload queues support S3 mode** � `UploadManagerProvider`, `useAssetUploadQueue`, `useAlbumPhotoUploadQueue`, and `useCommentManagement` now use browser-direct multipart uploads in S3 mode (with abort support and progress tracking) while preserving TUS behavior in local mode.
- **Content and photo delivery paths updated for S3** � tokenized content routes now support S3 existence checks and streaming/download behavior in S3 mode; main video content route redirects to presigned R2 URLs for stream/download.
- **Album ZIP and social-photo workers now support S3** � ZIP/social processors can read/write via S3-backed storage; ZIP existence checks were converted to async and updated across API/share routes.
- **Project guest access model simplified** � removed `guestLatestOnly` from schema, API, project settings UI, and share project fetch logic; includes migration `20260509000000_remove_guest_latest_only`.
- **Upload/processing dependency and config updates** � added `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`; updated `fast-xml-parser` override.
- **Account Ledger page now has page-size selection** � chart-of-accounts ledger page adds selectable page sizes (`50`, `100`, `150`, `200`).

### Fixed
- **Album ZIP readiness checks now await async existence checks** � fixed false/missed ZIP-ready states by awaiting `albumZipExists` in all affected routes.
- **Set-thumbnail race for newly uploaded image assets** � `set-thumbnail` now accepts valid image filename extensions while MIME is still `application/octet-stream` before worker classification, and still rejects assets explicitly marked invalid.
- **Client approval UX now updates immediately** � share/comment flows now optimistically update approved state, clear stale sidebar/token caches, and open download UI without waiting for full async refetch.
- **Running jobs progress accuracy improvements** � upload rows cap in-flight progress display below 100 until completion; processing progress now handles both `0..1` and `0..100` formats; S3 download phase is surfaced as `Downloading from cloud...` with throttled progress updates.
- **Comment author-name input now visually flags missing name** � name picker trigger now shows destructive styling when empty.
- **Album manager Dropbox option visibility** � create-album form now hides Dropbox upload controls when Dropbox is not configured.
- **Camera default-device selection improved** � front/selfie camera labels are now strongly deprioritized when choosing default camera.
- **Video sidebar thumbnail rendering and labels** � switched thumbnail rendering to native `img` with fallback hide-on-error and improved version label display when approval grouping is hidden.

### Removed
- **`Project.guestLatestOnly` column and settings UI toggle**.

## [1.6.9] - 2026-05-08

### Added
- **Multi-invoice bank deposit matching** � the Match to Invoice dialog now supports selecting multiple open invoices for a single bank deposit; invoices use checkboxes instead of radio buttons so any combination can be toggled; a balance indicator below the list shows the running total of selected outstanding balances vs the bank deposit amount and is colour-coded green (exact match), amber (within $1.00 rounding tolerance), or red (too far off); the "Match Invoice" button label pluralises to "Match Invoices" when more than one is selected and is disabled when the selected total differs from the bank deposit by more than $1.00; each matched invoice receives its own `SalesPayment` record at its full outstanding balance; a small rounding remainder (= $1.00) is silently absorbed into the first invoice's payment; unmatching the bank transaction deletes all associated payments and recomputes invoice status for every affected invoice; a new `bankTransactionId` field on `SalesPayment` links multi-invoice payments back to the transaction (backed by migration `20260508000002_add_sales_payment_bank_transaction_id`); the matched transaction detail panel shows each linked invoice as a separate line with its amount when multiple invoices were matched; the quick-match invoice badge continues to work for single-invoice matching
- **Stripe rounding account in Accounting Settings** � a new "Bank Reconciliation" settings card lets you configure a "Stripe Rounding Account" (typically Bank Charges or a Rounding account); when reconciling a Stripe bank deposit where the bank amount differs from the Stripe invoice by = $1.00, the difference is automatically posted as a `BAS_EXCLUDED` split line to that account; unmatching the transaction removes the split line; backed by migration `20260508000001_add_stripe_rounding_account`

### Changed
- **Camera defaults to main rear lens with cycle button** � `CameraCaptureButton` now enumerates `videoInputDevices` after permission is granted and sorts them so cameras whose label contains "ultra", "telephoto", or "macro" are deprioritised; if the browser opened a non-preferred camera (e.g. ultrawide) the component immediately reopens the stream on the preferred device; a `SwitchCamera` icon-only button is overlaid in the lower-left of the live-view area whenever more than one camera is available and cycles through all detected cameras in order; Retake resumes on whichever camera was active when the photo was taken; the camera list is cleared on dialog close so the next open always re-enumerates and re-selects the main camera
- **Accounting and Sales nav bars scroll horizontally on mobile** � both section nav bars previously used `flex-wrap`, causing the nav pills to reflow into multiple rows on narrow viewports; they now use a single-row `overflow-x-auto` layout with `scrollbar-hide` so all tabs remain accessible by swiping; nav links gain `shrink-0` to prevent compression; a `data-active` attribute is added to the active link and a `useEffect` calls `scrollIntoView` whenever the route changes, keeping the active tab visible without manual scrolling; a `.scrollbar-hide` utility class is added to `globals.css` to suppress the scrollbar while preserving scroll functionality across all browsers
- **Send Email dialog warns when there are unsaved changes** � `SalesSendEmailDialog` accepts a new `hasUnsavedChanges` prop; when `true`, a yellow caution banner is shown above the send button informing the user that only saved information will be included in the email; the invoice and quote detail pages pass their existing `hasUnsavedChanges` flag into the dialog

### Fixed
- **Sending an invoice or quote email no longer triggers a false "unsaved changes" warning** � after a successful send the invoice/quote detail pages refetch the document and update both `invoice`/`quote` state and `status` state, but `savedSnapshot` was not updated; since the server changes the document status on send (e.g. Draft ? Sent), `currentSnapshot` immediately diverged from `savedSnapshot` and the "You have unsaved changes" banner appeared erroneously; both pages now also patch the new status into `savedSnapshot` after a successful send so the snapshots remain consistent

## [1.6.8] - 2026-05-07

### Added
- **Vehicle & Logbook module** � new Vehicles section in the Accounting area implements the ATO logbook method for business vehicle deductions; vehicles are created with make, model, year, engine capacity, and registration number; each vehicle supports multiple logbook periods (with a 12-continuous-week minimum enforced by a progress indicator); trips within a logbook record date, type (Business/Private), purpose, and distance (entered by typing or by dragging the odometer field up/down); business-use percentage is computed live from trip records or overridden with a manual value once a logbook is finalised; annual odometer records can be stored per financial year; the logbook and trip data can be exported to CSV or PDF; the Vehicles page is accessible from the Accounting navigation menu; backed by migration `20260507000000_add_vehicles` (new `Vehicle`, `VehicleLogbook`, `VehicleTrip`, and `VehicleYearlyOdometer` models)
- **PAYG Income Tax Instalment liability on Balance Sheet** � the Balance Sheet now includes a PAYG Income Tax Instalment line in the Liabilities section; the balance is the sum of T7 amounts on all lodged BAS periods with `endDate = asOf` minus any payments posted to the configured PAYG payable account (via split lines or journal entries), so the outstanding instalment liability is always shown correctly net of payments already made
- **Accounting reminders** � a new worker job runs daily at 08:30 and sends pinned push notifications for two accounting events: (1) **vehicle odometer reading required** � fires on 1 July each year when at least one active vehicle with a logbook exists; the notification is pinned and manually clearable, and links to the Vehicles page; it is deduplicated per financial year so it is created at most once per year; (2) **BAS due date reminders** � begins alerting 13 days before the 28th of the due month for each standard ATO quarter (Q1 Oct, Q2 Feb, Q3 Apr, Q4 Jul); the reminder is suppressed when a `LODGED` `BasPeriod` already exists for the quarter and is cleared automatically on lodge
- **PWA app shortcuts** � the admin web-app manifest now declares two home-screen shortcuts: "Add Trip" (opens `/admin/accounting/vehicles?addTrip=1` to immediately launch the new-trip dialog) and "New Expense" (opens `/admin/accounting/expenses/new`); both shortcuts carry the app's 192 � 192 icon
- **Login `returnUrl` preserves query string** � `AuthProvider` previously used only `pathname` when building the `returnUrl` redirect for unauthenticated users; it now includes the full query string (`pathname?searchParams`) so users are returned to the exact URL they requested (including any filter or pre-open parameters) after signing in

### Changed
- **Expense delete confirmation uses AlertDialog** � the "Delete expense?" action in both the Expenses list page and the Expense Form Modal now presents a proper `AlertDialog` (with Cancel and Delete buttons inline) instead of `window.confirm()`, consistent with the pattern adopted across the accounting module in 1.6.4; a `deleteTarget` state variable holds the pending target so the dialog can reference the expense name after the row is deselected
- **Match Invoice dialog now scrollable** � the invoice-match dialog in Bank Accounts previously applied `max-h-60` / `max-h-48` caps directly to the individual invoice sub-lists, causing the dialog itself to overflow the viewport on screens with many open or Stripe-reconcilable invoices; the dialog content wrapper now uses `flex flex-col max-h-[85vh]` with an `overflow-y-auto` scrollable inner area, and the per-sublist height caps are removed so all rows are always accessible without nested scrollbars
- **Trial Balance and Aged Receivables report tabs removed** � the P&L and Balance Sheet tabs remain on the Reports page; the Trial Balance and Aged Receivables tabs (including their state, fetch functions, CSV/PDF export handlers, and navigation buttons) have been removed
- **Camera capture simplified** � `CameraCaptureButton` no longer enumerates all `videoinput` devices after permission is granted; the camera-switch toggle button, `getCameraList()` helper, `cameras` state, and `cameraIdx` state are removed; the component now passes `facingMode: { ideal: 'environment' }` directly to `getUserMedia` and starts immediately without post-permission device sorting

## [1.6.7] - 2026-05-06

### Added
- **Stripe bank deposit reconciliation** � when a bank deposit arrives for an invoice that was already paid via Stripe, the Pending Transactions invoice-match dialog now shows a second section "Reconcile Stripe bank deposit" listing recently-paid Stripe invoices; selecting one and clicking "Reconcile Deposit" creates a `SalesPayment` with `excludeFromInvoiceBalance=true` (identical to the existing QuickBooks reconciliation pattern), leaves the invoice status unchanged, and marks the bank transaction as matched � preventing the deposit from sitting permanently in Pending while avoiding any double-counting of revenue in P&L, BAS, or cash-receipts reports; the reference is prefixed `"Bank reconciliation: <bank description>"`; the `open-invoices` API accepts a new `includeStripeReconcile=true` param to return these PAID/stripe-paid invoices (filtered to only those not yet reconciled), and `match-invoice` accepts a `reconcile: true` body flag to trigger the non-balance-affecting path

### Fixed
- **Invoice and quote detail pages no longer show a false "unsaved changes" warning on load** � when an invoice (or quote) was loaded, the page built two separate item arrays: one passed to `setItems` (which assigned fresh UUIDs to any items missing an `id`, a safety net added in 1.6.6) and a separate one used to compute `savedSnapshot` (which did not apply the same UUID assignment); for invoices with items stored without an `id` in the database (e.g. invoices converted from quotes before the 1.6.6 fix), `currentSnapshot` contained the generated UUIDs while `savedSnapshot` contained no `id`, causing an immediate mismatch and triggering the "You have unsaved changes" prompt the moment the page finished loading; both pages now compute the items array once and share that single reference between `setItems` and `setSavedSnapshot` so the snapshots are always consistent; the same `id` safety net is also applied to the quote detail page for parity

### Security
- **Cross-project IDOR on recipient PATCH/DELETE** � `PATCH /api/projects/[id]/recipients/[rid]` and `DELETE /api/projects/[id]/recipients/[rid]` previously looked up the recipient by `rid` alone, allowing an admin acting through Project A's URL to modify or delete a recipient that belonged to Project B. Both the `updateRecipient` and `deleteRecipient` helpers now scope all Prisma lookups with `{ id: recipientId, projectId }` so a mismatched project returns 404.
- **Video approval writes are now atomic** � approving a video version previously issued a `updateMany` to unapprove other versions and then a separate `update` to approve the target. A concurrent approval arriving between these two writes could leave both versions marked approved. Both writes are now executed inside `prisma.$transaction([...])` on the non-rename code path, eliminating the race.
- **Email-enumeration timing oracle on OTP verification removed** � `/api/share/[token]/verify-otp` performed a recipient pre-check that returned early (before the Redis OTP lookup) for non-recipients, producing a measurably shorter response time that leaked whether an email was registered. The pre-check is removed; `verifyOTP` returns the same generic error with no side effects when no OTP key exists for the `(email, project)` pair, so both paths now have identical timing.
- **Per-IP rate limit added to `/api/share/[token]/send-otp`** � the existing per-`(email, project)` `checkOTPRateLimit` only counted requests that passed recipient verification. An attacker cycling through random non-recipient emails could call the endpoint indefinitely � triggering an admin push notification on every attempt � without tripping the limit. A 10-per-15-minutes IP-based cap (using the standard `rateLimit` middleware) is now applied to all requests before any other processing.
- **Missing rate limits added to five admin routes** � `POST /api/settings/test-email` (5/min � prevents use as an email-bomb relay), `GET/POST/DELETE /api/security/blocklist/domains`, `GET/POST/DELETE /api/security/blocklist/ips`, and `DELETE /api/security/events` now all apply the standard `rateLimit` middleware after auth checks.
- **Cryptographic randomness for client-side upload IDs** � `Math.random()` fallbacks in `useAssetUploadQueue`, `useAlbumPhotoUploadQueue`, `ProjectFileUpload`, `ClientFileUpload`, `UserFileUpload`, `ProjectEmailUpload`, `MultiVideoUploadModal`, and `UploadManagerProvider` have been replaced with `crypto.randomUUID()`, eliminating predictable upload-ID collision risk in long-lived browser sessions.
- **Upgraded `postcss` to `^8.5.10`** � resolves GHSA-qx2v-qp2m-jg93 (moderate): XSS via unescaped `</style>` in PostCSS CSS stringify output; the top-level workspace `postcss` devDependency is updated to `^8.5.10`; because Next.js pins an exact bundled copy at `8.4.31` that npm overrides cannot replace, the same fix (`escapeHTMLInCSS` applied to all `builder()` call sites in `stringifier.js`) is also applied to that nested copy via a `patch-package` patch (`patches/next++postcss+8.4.31.patch`) so the fix survives every subsequent `npm install`; a `"next": { "postcss": ">=8.5.10" }` override entry is retained in `package.json` so that once Next.js ships a release with an updated postcss the nested copy is automatically dropped
- **Upgraded `uuid` override to `>=11.1.1`** � resolves GHSA-w5hq-g745-h8pq (moderate): missing buffer bounds check in `uuid` v3/v5/v6 when `buf` is provided; a `"uuid": ">=11.1.1"` override is added to `package.json` to force all transitive dependents onto the fixed version
- **Upgraded `bullmq` to `^5.76.5`** � resolves GHSA-w5hq-g745-h8pq indirect path: `bullmq` 5.66.1�5.76.1 depended on the vulnerable `uuid` range; updated to `^5.76.5` (first release past the advisory range) combined with the `uuid` override above ensures no vulnerable `uuid` copy is installed

## [1.6.6] - 2026-04-21

### Fixed
- **Duplicate "Video Approved" emails and notifications no longer sent on rapid double-click** � the approval confirm button in `CommentSection` previously guarded against re-entry using a React state flag (`approving`), which is asynchronous; a rapid double-click could fire two POST requests to `/api/projects/[id]/approve` before the component re-rendered with the disabled state; a synchronous `useRef` guard (`approvingRef`) is now set at the start of `handleApproveSelected` and cleared in the `finally` block, ensuring any concurrent second click exits immediately regardless of React's render cycle
- **Deleting a line item on a converted invoice no longer removes all items** � `onConvertToInvoice` previously mapped quote items without including the `id` field, so all items were stored in `itemsJson` with `id: undefined`; when the invoice page loaded those items, clicking the delete button ran `prev.filter((x) => x.id !== it.id)` which evaluated `undefined !== undefined` as `false` for every row and wiped the entire list; the conversion now passes `id` through for each item, and the invoice detail page also assigns a fresh UUID to any item loaded without one as a safety net for previously converted invoices already in the database

### Changed
- **Qty field on invoices and quotes now accepts decimal values** � the quantity `<Input type="number">` on all four line-item editors (invoice edit, invoice new, quote edit, quote new) previously had no `step` attribute, causing the browser to default to `step="1"` and show a "please enter a valid value" tooltip for entries like `1.5`; `step="any"` is now set on all four inputs so any positive decimal quantity is accepted without a browser validation error
- **Convert Quote to Invoice pre-populates the Due Date from default settings** � clicking "Convert to Invoice" from a quote page previously created the invoice with a blank due date; the conversion now reads `settings.defaultInvoiceDueDays` (already loaded on the page) and sets the due date to today plus that many days, matching the behaviour of creating a new invoice directly
- **Empty trailing line items are stripped on save/create** � after selecting a preset line item the editor automatically adds a new blank row for convenience; if that row was left empty (no item name) it would previously be saved as a line with no description; on save (quote and invoice edit) and on create (quote and invoice new) any line items with a blank description are now filtered out before sending to the API
- **Items list updates immediately after save without requiring a page reload** � the quote and invoice edit pages now call `setItems` with the server-returned items after a successful save, so empty rows stripped by the filter above disappear from the UI immediately rather than persisting until the next page load

## [1.6.5] - 2026-04-21

### Changed
- **Invoice and quote auto-numbering continues from the highest existing number** � `nextSalesDocumentNumber` now allocates `MAX(existing) + 1` instead of scanning for the first available gap from 1; this ensures new documents continue sequentially after any pre-existing numbers (e.g. INV-2001 after INV-2000) rather than incorrectly reusing low numbers such as INV-0001 that were never issued in the current app

## [1.6.4] - 2026-04-20

### Changed
- **Accounting delete confirmations use native browser dialog** � all "Delete X?" `AlertDialog` modals across the accounting section (Expenses list, Expense Form Modal, Chart of Accounts, Account Ledger, Bank Accounts, BAS Periods list, BAS detail page lodgement-document and payment removal, and Accounting Settings tax rates) are replaced with a plain `window.confirm()` call matching the pattern used on the Sales invoices and quotes pages; this avoids the mobile layout issue where the custom dialog footer buttons stacked vertically and the Delete button appeared off-axis; the Lodge BAS confirmation dialog is unchanged
- **Camera defaults to main rear lens and adds a camera-switch toggle** � `CameraCaptureButton` now enumerates `videoInputDevices` after camera permission is granted and sorts them so the main rear camera (neither ultrawide, telephoto, nor macro lens) is selected first; devices whose label contains "ultra", "telephoto", or "macro" are deprioritised; a `SwitchCamera` icon-only button appears in the lower-left of the live-view area whenever more than one camera is available, cycling through all detected cameras in order; the Retake action also resumes on whichever camera was active when the photo was taken

## [1.6.3] - 2026-04-20

### Changed
- **Balance Sheet rearchitected to use Chart of Accounts directly** � the Balance Sheet report now sources all ASSET, LIABILITY, and EQUITY lines from the live Chart of Accounts rather than hardcoded account placeholders; a new `buildPostedBalanceSheetLines` helper accumulates balances from bank transactions, journal entries, and split lines posted to each CoA account; `mergeReportLines` deduplicates and sums lines by account ID so bank-linked ASSET accounts, Accounts Receivable, Accounts Payable, and GST Payable all render with the correct CoA code and name; Retained Earnings is now derived from the balance sheet identity (Net Assets - Contributed Equity) rather than re-totalling income and expense ledger records separately, ensuring the report always balances; any additional EQUITY accounts (contributed capital, drawings) are rendered as separate lines using their CoA codes; `findPreferredBalanceSheetAccount` locates the preferred AR, AP, GST Payable, and Retained Earnings accounts by code, subType, or name with a defined fallback chain
- **Period selector expanded on both Accounting and Sales dashboards** � the period selector in both `AccountingDashboardCharts` and `SalesDashboardCharts` now offers eight options in order: Financial year to date, Last financial year, This financial quarter, Last financial quarter, Year to date, Last 12 months, Last 6 months, Last 3 months; quarter boundaries are computed relative to the configured fiscal year start month
- **Bank Accounts summary removed from Accounting Dashboard** � the bank account balance cards that appeared at the bottom of the Accounting Dashboard overview have been removed; account balances are accessible via the Balance Sheet report and the dedicated Bank Accounts page
- **New invoice and estimate numbers now use 4-digit padding and reuse deleted gaps** � auto-generated sales document numbers now default to `INV-0001` / `EST-0001` instead of 6-digit padding; the shared generator now allocates the first available number in sequence, so deleting an invoice or quote no longer leaves permanent gaps, while still expanding naturally beyond 9999 when needed

### Fixed
- **Camera capture now works in-browser** � the `Permissions-Policy` response header previously blocked all camera access with `camera=()`; it is updated to `camera=(self)` so the `CameraCaptureButton` introduced in 1.6.2 can open the device camera within the app's own origin
- **Invoice due date and quote valid-until date no longer shift by one day** � `addDaysYmd` in both the New Invoice and New Quote pages previously called `toISOString().slice(0, 10)` on the computed date, which converts to UTC and produces the previous calendar day for users in UTC+ timezones; the function now constructs the date string directly from local `getFullYear` / `getMonth` / `getDate` values; additionally the prefill effect now waits until settings have finished loading before writing the default date, preventing a race where a zero-day offset from the unloaded settings was applied before the real default arrived
- **Confirmation dialog buttons consistently aligned** � `AlertDialogFooter` instances across all accounting and expense pages (BAS detail, BAS list, Bank Accounts, Chart of Accounts, Account Ledger, Expenses, Expense Form Modal, and Accounting Settings) now carry `flex-row justify-end gap-2`, ensuring Cancel and Delete/Remove buttons always appear side-by-side on the right rather than stacking vertically on narrow viewports

## [1.6.2] - 2026-04-20

### Added
- **Camera capture for expense receipts and attachments** � a new `CameraCaptureButton` opens the device camera in-browser (preferring the rear-facing camera on mobile), lets the user snap a photo, preview it, and attach it without leaving the expense form; clear inline error messages are shown for denied permission (`NotAllowedError`), no camera found (`NotFoundError`), and camera already in use (`NotReadableError`); the button appears both in the Expense Form Modal's receipt drop-zone and inside the `AttachmentsPanel` when `enableCameraCapture` is set

### Changed
- **Accounting Dashboard Leaderboard displays parent�child account names** � sub-accounts in the Income Breakdown and Expense Breakdown leaderboards previously rendered as `Code � Sub-account name` using the account code plus the raw account name; they now display as `Parent - Sub-account` by tracking the most-recent top-level account name as each row is iterated, making the hierarchy legible without knowledge of account codes; the `depth`-based indent and muted-foreground styling is removed so all rows share the same visual weight
- **Expense date column no longer wraps** � `whitespace-nowrap` added to the Date cell in the Expenses table so dates always render on a single line on narrow viewports

## [1.6.1] - 2026-04-20

### Fixed
- **Account Ledger sorting is now server-side** � the sort key and direction are passed to the `GET /api/admin/accounting/accounts/[id]/entries` endpoint as `sortBy` and `sortDir` query parameters; the combined entries list is sorted on the server before pagination so sorting behaves correctly across all pages rather than only re-sorting the current in-memory page; the page counter is also reset to 1 whenever the sort column or direction changes to avoid stale page offsets
- **CoA balance for linked ASSET accounts now includes the bank account opening balance** � the `/api/admin/accounting/accounts/balances` endpoint was accumulating only post-import transaction amounts for bank-account-linked CoA accounts and ignoring the account's stored `openingBalance`; the opening balance is now always added to the CoA balance regardless of the active date-range filter, so the balance correctly reflects the account's starting point plus all subsequent activity
- **Share page video token requests are now deduplicated** � both the admin share page and the public client share page previously fired duplicate concurrent token API requests when the same video was referenced in multiple render cycles; an in-flight promise cache (`tokenRequestCacheRef`) now coalesces all concurrent callers onto a single in-progress request per video, eliminating redundant API calls and potential race conditions; sidebar thumbnail preloads use a new lightweight `fetchSidebarVideos` path that only requests thumbnail tokens, deferring full stream-token fetches until the user actually selects a video
- **Journal Entry dialog no longer closes on outside click** � the `onOpenChange` handler on the New / Edit Journal Entry dialog was closing the form when the user clicked outside the dialog box, silently discarding any in-progress entry; the handler now ignores the close signal from outside clicks so the dialog can only be dismissed via the explicit cancel or save actions

## [1.6.0] - 2026-04-20

### Added
- **Accounting Dashboard charts** � three new chart panels replace the static text-only dashboard with an interactive overview; all charts share the same period-selector pattern used by the Sales Dashboard (Financial year to date, Last financial year, Year to date, Last 12 months) and respect the configured reporting basis (Cash/Accrual) and fiscal year start month:
  - **Profitability Trend** � full-width line chart showing monthly Income (emerald), Total Costs (red), and Net Profit (indigo dashed) for the selected period; a zero-reference line clearly marks the break-even point; the card header shows period totals and gross margin %; negative Net Profit values fall below the zero line in-place without special styling
  - **Income Breakdown** � leaderboard-style card showing each active Income account's ex-GST contribution for the period, sorted by amount with a relative progress bar; the card header shows total income and gross margin %; account names link directly to the account ledger pre-filtered to the same date range
  - **Expense Breakdown** � same leaderboard style combining COGS and Operating Expense accounts in a single ranked list; each row carries a coloured badge (amber for COGS, rose for Expense) so the two types are visually distinct; the card header shows total spend and the expense-to-income ratio %
- **`GET /api/admin/accounting/reports/profit-loss-monthly`** � new authenticated, rate-limited endpoint that returns per-month income/COGS/expenses/netProfit totals for a date range and reporting basis; queries all four ledger sources (invoices or payments, MANUAL bank transactions, journal entries, split lines) in parallel and groups results by YYYY-MM in a single pass; used by the Profitability Trend chart to avoid multiple sequential P&L calls
- **Bank Account ? Chart of Accounts link** � each bank account can now be linked to an ASSET account in the Chart of Accounts via a new optional `coaAccountId` field; when linked, all non-excluded bank transactions from that account are rolled into the CoA balance for that asset account and appear in the account ledger as `Cash`-type entries; the Balance Sheet uses the linked account's code and name for the asset row so bank balances are reflected under the correct CoA line; backed by migration `20260420000000_bank_account_coa_link`; the bank account edit form gains a searchable ASSET account picker
- **`POST /api/admin/sales/items/reorder`** � new authenticated, rate-limited endpoint that accepts an ordered array of item IDs and updates the `sortOrder` of each `SalesItem` in a single database transaction; returns the full refreshed list sorted by `sortOrder`; used by the drag-to-reorder handle in the Line Item Presets modal
- **Drag-to-reorder in Sales Line Item Presets** � the Line Item Presets modal now renders a `GripVertical` drag handle on every item row; rows can be dragged into a new position using HTML5 drag events and the new order is persisted immediately via `POST /api/admin/sales/items/reorder`; a drop-target highlight and a loading state on the handle give clear visual feedback while the save is in flight

### Changed
- **Balance Sheet equity uses all four ledger sources** � the retained-earnings figure in `buildBalanceSheetReport` previously accumulated only `Expense` records; it now includes MANUAL-matched bank transactions, journal entries, and split lines posted to EXPENSE/COGS accounts (all ex-GST), consistent with the P&L report; the equity row now resolves its account code and name from the first active EQUITY account in the Chart of Accounts instead of using hardcoded placeholder values
- **Balance Sheet asset rows respect the CoA account link** � bank account rows in the Assets section of the Balance Sheet report now use the code and name of the linked Chart of Accounts account (when one is configured) instead of the raw bank account name, so the report line matches the CoA hierarchy
- **Account Ledger shows bank transactions for linked ASSET accounts** � when viewing a CoA account that has a bank account linked via `coaAccountId`, the ledger now fetches all non-excluded transactions from that bank account and displays them as `Cash`-type rows alongside the existing expense, journal, and split entries; each row has an eye-icon button to open the linked bank transaction viewer; CSV and PDF exports include these rows

## [1.5.9] - 2026-04-19

### Added
- **`nextSalesDocumentNumber` � gap-safe invoice and quote numbering** � the duplicated `nextInvoiceNumber` / `nextQuoteNumber` functions in the invoice and quote creation routes are replaced by a shared `nextSalesDocumentNumber(tx, type)` utility in `src/lib/sales/numbering.ts`; the new implementation scans existing documents to derive the highest in-use number before allocating, then uses an optimistic-concurrency retry loop (up to 5 attempts) to jump the sequence counter past any manually-entered numbers, preventing gaps and collisions caused by custom document numbers provided at creation time

### Changed
- **Bank Transactions only show `BAS Payment` when a lodged BAS payment is actually matchable** � the Pending bank transaction action bar no longer shows `BAS Payment` on every debit; it now appears only when there is at least one lodged BAS period awaiting reconciliation whose recorded payment amount exactly matches that transaction amount; the set of matchable amounts is pre-fetched when the Unmatched tab becomes active and is pruned immediately after a successful match
- **Accounting Settings � default T7 instalment amount** � the BAS Payment Defaults card can now store a default T7 value that is applied to new BAS periods and pre-fills untouched editable BAS periods until a period-specific amount is saved; the GST Payable account, PAYG account, and T7 default now sit on a single desktop row
- **Lodgement Document deletion now requires confirmation** � clicking the delete icon on a BAS lodgement attachment previously triggered immediate deletion; it now opens a `Delete Lodgement Document?` alert dialog showing the filename with Cancel and a destructive Delete button; the delete API call fires only on confirmation and the dialog dismisses only after a successful response

### Fixed
- **CoA account balances now include split lines and journal entries, all amounts ex-GST** � the `/api/admin/accounting/accounts/balances` endpoint previously accumulated bank transaction amounts from an inc-GST `groupBy` total and omitted split lines and journal entries entirely; it now fetches all three record types individually, strips GST from each row using its own tax code via `amountExcludingGst`, and accumulates the correct ex-GST contribution for each account

## [1.5.8] - 2026-04-19

### Changed
- **BAS payment dialog pre-fills truncated GST net** � the "Record BAS Payment" dialog now pre-fills the GST amount field using `truncateBasCents(1A) - truncateBasCents(1B)` instead of the raw `netGstCents` value, so the suggested payment amount always matches the whole-dollar figures the ATO expects (consistent with how `8A`, `8B`, and `9` are computed)
- **Lodgement Documents card moved above Calculation Results** � the attachment panel for ATO portal confirmations now appears directly below the payment card, before the BAS form layout and records drill-down tables, giving it more prominence in the lodgement workflow
- **BAS drill-down locked when period is lodged** � rows in the Sales and Expenses/Journal/Bank drill-down tables no longer show hover highlighting or a pointer cursor on a lodged BAS period; row click handlers are suppressed; the `ExpenseFormModal`, `LinkedBankTransactionDialog`, and journal-entry edit `Dialog` are all conditionally rendered only when `!isLodged`, preventing accidental data edits after a period has been submitted to the ATO

## [1.5.7] - 2026-04-19

### Changed
- **BAS amounts truncated to whole dollars before summing** � `8A`, `8B`, and `9` net amounts are now computed by first truncating each component (`1A`, `1B`, `W2`, `T7`) to whole dollars individually (using floor of absolute value, sign-preserved) before addition, matching the ATO's requirement that BAS amounts are reported in whole dollars; previously the raw cent-precision values were summed first and the display format alone truncated, which could produce a displayed net that differed from the ATO-expected result
- **New `truncateBasCents` helper** � extracted the whole-dollar truncation logic into a reusable `truncateBasCents(cents)` function used consistently across the CSV export, PDF export, and on-screen summary table
- **New `fmtBasCsvAmount` helper** � BAS CSV export now uses a dedicated formatter that produces plain number strings (e.g. `1234.00` / `-1234.00`, no `$` prefix) from truncated cent values, matching the format expected by ATO lodgement tools
- **BAS CSV and PDF export streamlined to key lines only** � the CSV and PDF exports previously included informational sub-items `G2` (export sales), `G3` (other GST-free sales), `G4` (input taxed sales), `G10` (capital purchases), and `G11` (non-capital purchases); these rows are removed, leaving only the lodgement-critical lines: `G1`, `1A`, `1B`, `W2` (if non-zero), `T7` (if non-zero), `8A`, `8B`, and `9`
- **BAS on-screen summary table streamlined to key lines** � the GST section of the BAS detail page table similarly removes `G2`, `G3`, `G4`, `G10`, and `G11` rows, showing only `G1`, `1A`, and `1B` alongside the PAYG and totals sections
- **BAS line descriptions updated to ATO plain-language wording** � `"GST on sales"` ? `"GST you collected on sales"` and `"GST on purchases"` ? `"GST you paid on purchases"` across the screen table, PDF export, and CSV export

## [1.5.6] - 2026-04-19

### Added
- **BAS calculation includes all four ledger sources** � the BAS engine now queries the same four data sources used by the Chart of Accounts ledger and P&L reports: `Expense` records, MANUAL-matched `BankTransaction` records, `JournalEntry` records, and `SplitLine` records, all filtered to EXPENSE/COGS account types; previously only `Expense` records were included, causing refund bank transactions (e.g. equipment refunds recorded as Deposit/ReceivePayment) to be silently omitted from G10/G11/1B
- **GET `/api/admin/accounting/journal-entries/[id]`** � new authenticated, rate-limited endpoint that returns a single journal entry by ID via the shared `journalEntryFromDb` mapper; used by the BAS drill-down to pre-populate the edit dialog when clicking a journal row
- **BAS drill-down row click dispatches by record kind** � clicking a row in the BAS expenses drill-down now opens the correct modal for the record type: `expense` rows open `ExpenseFormModal`, `journal` rows open an inline edit journal-entry dialog (fetches current values, saves via PUT, re-runs calculation on save), and `bankTransaction`/`splitLine` rows open `LinkedBankTransactionDialog` pointing to the parent bank transaction

### Changed
- **`BasExpenseRecord` extended with `kind` and `bankTransactionId`** � the shared type now carries a `kind` discriminator (`'expense' | 'bankTransaction' | 'journal' | 'splitLine'`) and an optional `bankTransactionId` (set on `bankTransaction` and `splitLine` rows) so the UI can dispatch row clicks to the appropriate viewer/editor without guessing

### Fixed
- **BAS missing refund/credit bank transactions** � MANUAL-matched bank transactions on EXPENSE/COGS accounts (e.g. equipment refunds, supplier credits processed as Deposit) were not included in BAS G10/G11/1B totals or the drill-down expenses table; they now appear correctly with sign-corrected GST amounts

## [1.5.5] - 2026-04-19

### Added
- **`generateReportPdf` � structured PDF export engine** � replaces the old `window.print()`-the-current-page approach with a dedicated PDF renderer that builds a self-contained A4 HTML document (title, subtitle, sections, typed columns with optional `nowrap`/alignment, rows with bold/separator/double-separator/indent/colour options) and prints it through a hidden iframe; the old `downloadPdf` helper is retained but deprecated
- **`gst-amounts.ts` shared utility** � the `amountExcludingGst(amountCents, taxCode, taxRatePercent)` helper previously private to `reports.ts` is extracted into its own module and re-exported so it can be used consistently across the API route layer and the client account ledger

### Changed
- **All accounting PDF exports use `generateReportPdf`** � Chart of Accounts, Account Ledger, Expenses, BAS Periods list, BAS Detail, Bank Transactions, and all four Financial Reports tabs (P&L, Balance Sheet, Trial Balance, Aged Receivables) now produce clean, properly formatted A4 reports with labelled sections and aligned columns instead of printing the live page view; the Expenses and Bank Transactions pages also drop the old `printRows` state + `useEffect` print-trigger pattern in favour of a direct synchronous call
- **Financial Reports PDF export is data-driven per tab** � the P&L export renders Income / COGS / Gross Profit / Expenses / Net Profit sections with hierarchy-indent support and green/red Net Profit colouring; the Balance Sheet export includes Assets, Liabilities, Equity, and Net Assets sections; the Trial Balance includes a totals footer row; the Aged Receivables export includes a Summary aging-bucket section followed by a full Detail section
- **Account ledger amounts now consistently ex-GST** � journal entry and split line rows in the account ledger were previously displayed at their raw (inc-GST) `amountCents`; they now pass through `amountExcludingGst` using the account's configured tax rate (fetched from `SalesSettings.taxRatePercent` and returned by the entries API), matching the existing behaviour for expenses and bank transactions; sorting, CSV export, PDF export, and the `periodTotalCents` running total are all updated accordingly
- **Entries API returns `taxRatePercent`** � `GET /api/admin/accounting/accounts/[id]/entries` now fetches `SalesSettings.taxRatePercent` in the same parallel query batch and includes it in the response payload; clients use this value for all ex-GST display calculations so amounts match the configured rate rather than a hardcoded 10%
- **New journal entry form pre-fills tax code from account default** � opening the "New Journal Entry" dialog from the account ledger now seeds the tax code selector with the account's own default tax code (`account.taxCode`) instead of always defaulting to `BAS_EXCLUDED`; the amount field label is updated to "Amount (inc. GST)" to clarify expected input
- **Sales Overview chart uses cents-based arithmetic** � revenue bar chart data now carries a `revenueCents` integer field to avoid floating-point precision loss; total, avg/month, and projected labels are all derived from the integer value and formatted via a new `formatCurrencyCents` helper that always renders two decimal places and a proper `-` sign for negative values

### Fixed
- **Account ledger `periodTotalCents` incorrectly included GST for journal and split entries** � the server-side running total aggregation treated journal entries and split lines as full inc-GST amounts; it now strips GST from these entry kinds using `amountExcludingGst`, so the period balance shown in the ledger header matches the sum of the displayed ex-GST amounts

## [1.5.4] - 2026-04-19

### Added
- **Edit journal entries from account ledger** � own journal entries in the account ledger now have an edit (pencil) button alongside the existing delete button; clicking it opens the journal entry dialog pre-populated with the entry's date, description, amount, debit/credit type, tax code, reference, and notes; the dialog title updates to "Edit Journal Entry" and the submit button reads "Save Changes"
- **PUT `/api/admin/accounting/journal-entries/[id]`** � new authenticated, rate-limited API route that validates and updates an existing journal entry's date, description, amount, tax code, reference, and notes; returns the updated entry via the shared `journalEntryFromDb` mapper

### Changed
- **Sales rollup Stripe totals now sourced from `SalesPayment` mirrors** � the per-invoice Stripe paid totals in the sales rollup were previously aggregated from `SalesInvoiceStripePayment`; they now aggregate from `SalesPayment` rows where `source = STRIPE`, ensuring deleted test payments are automatically excluded and totals stay consistent with the accounting cash-receipts view
- **Sales rollup payments list filters out deleted Stripe payments** � `SalesInvoiceStripePayment` rows are now filtered against the set of active `SalesPayment` source=STRIPE mirrors before being included in the dashboard payments list; payments whose corresponding mirror record has been deleted (e.g. test checkouts) are silently excluded
- **Copy-to-version physically copies asset files** � the copy-assets-to-version endpoint previously used a metadata-only approach (new DB records pointing to the same storage path as the source); it now physically copies each file to the target version's assets folder at the correct path (`<projectStoragePath>/<videoFolder>/<versionLabel>/<fileName>`), creates the destination directory if needed, and recalculates project total bytes after the operation
- **Copy-to-version supports Dropbox** � when the target video has Dropbox enabled and Dropbox storage is configured, copied assets receive a `dropbox:` storage path, a human-friendly Dropbox path, and are queued for upload to Dropbox immediately after the local copy

## [1.5.3] - 2026-04-18

### Added
- **BAS payment split into GST and PAYG components** � the "Record BAS Payment" dialog now has separate sections for the GST net (1A - 1B) and the PAYG Income Tax Instalment (T7); each component is recorded as its own `BAS_EXCLUDED` expense against a separately chosen account; the PAYG section only appears when the BAS period has a non-zero T7 amount; the dialog footer shows a live total of both amounts
- **BAS payment default accounts in Accounting Settings** � a new "BAS Payment Defaults" card on the Accounting Settings page lets you pre-configure the default Chart of Accounts entries for the GST Payable and PAYG Instalment components; these defaults pre-fill the payment dialog and can be overridden per payment; stored as `basGstAccountId` and `basPaygAccountId` on `AccountingSettings`
- **Accounting Settings accessible from nav menu** � the Accounting sub-menu now includes a direct "Settings" link so the settings page is reachable without navigating away from any accounting section

### Changed
- **BAS expense table columns show Subtotal / GST / Total** � the expenses breakdown on the BAS detail page previously had a single "Inc GST" column; it now has separate "Subtotal" (ex-GST), "GST", and "Total" columns with correct per-row and footer subtotals
- **BAS date columns formatted via `formatDate`** � the sales records and expenses tables in the BAS drill-down now render dates through the shared `formatDate` utility instead of the raw `YYYY-MM-DD` string
- **Accounting Settings save button moved to page header** � the save button is now a prominent "Save Changes" button in the page header (visible alongside the title) rather than a small button buried inside the Reporting card; success and error feedback banners appear at the top of the page
- **Dialog/alert-dialog backdrop blur reduced** � overlay blur on all dialogs and alert dialogs changed from `backdrop-blur-sm` to `backdrop-blur-[2px]` for a subtler background blur effect

### Fixed
- **BAS payment deletion clears PAYG expense** � the `DELETE /api/admin/accounting/bas/[id]/payment` route now also deletes the linked PAYG instalment expense record (if one exists) and clears the new `paymentPaygExpenseId` field, so no orphaned expense records are left behind
- **Orphan file scan no longer false-positives on `thumbnail.jpg`** � the weekly dry-run scan was incorrectly flagging video thumbnail files as orphaned when the `thumbnailPath` column on the `Video` record was `null` or stale; the scan now also derives and protects the canonical thumbnail path from `project.storagePath` + `video.storageFolderName` + `video.versionLabel`, mirroring the same fallback logic used by the content-delivery API

## [1.5.2] - 2026-04-18

### Added
- **Edit expense directly from BAS drill-down** � clicking any row in the Expenses tab of the BAS records drill-down now opens the Edit Expense modal; after saving, the BAS calculation automatically re-runs so the updated figures are reflected immediately without navigating away

### Changed
- **BAS expense records grouped by tax code** � the flat expenses table in the BAS drill-down is replaced with separate sub-tables per tax code (GST ? GST Free ? BAS Excluded ? Input Taxed), each with its own subtotal row; the Tax Code column is removed from each sub-table since it is now the group heading
- **Sales rollup excludes STRIPE-source `SalesPayment` mirror rows** � `SalesPayment` records with `source = STRIPE` (internal mirror rows created for BAS cash-basis queries) are now filtered out of the unified payments list in the sales rollup, preventing duplicate entries alongside the authoritative `SalesInvoiceStripePayment`-derived rows; orphaned Stripe payment entries whose invoice has since been deleted are also excluded

### Fixed
- **Account attachment migration includes expense-matched bank transactions** � `migrateAccountFolderFiles` previously missed attachments on bank transactions whose account assignment comes from a linked `Expense` record (i.e. `bankTransaction.accountId = null`); the query now also matches transactions whose linked expense belongs to the account being migrated, so all attachment files are correctly moved when an account is renamed

## [1.5.1] - 2026-04-18

### Added
- **BAS lodgement documents** � a new "Lodgement Documents" card on the BAS period detail page lets you upload, download, and delete file attachments (e.g. ATO lodgement confirmation PDFs) directly against a BAS period; files are stored under the accounting storage volume at `<FY>/BAS/`; a new API route `POST /api/admin/accounting/bas/[id]/attachments` handles uploads and the existing shared attachment download/delete routes serve the files
- **Stripe payments backfilled into SalesPayment table** � existing `SalesInvoiceStripePayment` records are backfilled into the `SalesPayment` table (source `STRIPE`, `excludeFromInvoiceBalance = true`) via a new migration; going forward the Stripe webhook creates a `SalesPayment` record on each successful checkout so that Stripe income is visible in BAS cash-basis calculations and cash-receipts reports through a single, consistent query path

### Changed
- **BAS/GST amounts now round down to whole dollars** � all BAS figures displayed on the BAS detail page and exported to CSV are now truncated (floor) to the nearest whole dollar rather than rounded to nearest; this ensures amounts are never overstated, which is the conservative approach required for ATO reporting
- **Cash-basis BAS and sales-receipts queries unified** � `listSalesCashReceiptsInRange`, `listSalesCashReceiptsUpTo`, and the BAS `calculateBas` cash-basis path now query only the `SalesPayment` table (matching rows where `excludeFromInvoiceBalance = false` OR `source = STRIPE`), removing the separate `SalesInvoiceStripePayment` fan-out queries and eliminating a class of double-count bugs
- **Account attachment files migrated when account is renamed** � renaming an account via `PUT /api/admin/accounting/accounts/[id]` now moves all existing receipt files for that account (and its direct children, whose path includes the parent name segment) into the updated folder path on the accounting storage volume

## [1.5.0] - 2026-04-18

### Added
- **BAS detail page redesigned to match ATO form layout** � the BAS Calculation card is replaced with a structured table that mirrors the official ATO Business Activity Statement form; rows are grouped into labelled sections (GST, PAYG Withholding, Income Tax Instalment, Summary) with a "Line Description", "Line Code" badge, and "Amount" column per row; the PAYG Amounts card that previously appeared only after lodgement is removed and its figures are incorporated directly in the table; the Summary section replaces the old "Net GST Payable / Refund" row with the ATO's own labels � **8A** Amount you owe the ATO, **8B** Amount the ATO owes you, and **9** Your payment amount
- **G4 Input Taxed Sales line on BAS** � the BAS table and CSV export now include the **G4 � Input taxed sales** line sourced from `g4InputTaxedSalesCents` on the stored calculation snapshot
- **BAS CSV export matches ATO form columns** � the exported CSV now has three columns (Line Description, Line Code, Amount) and includes all rows visible on the BAS table � G1�G4, G10�G11, 1A, 1B, W2 (if non-zero), T7 (if non-zero), 8A, 8B, and 9 � with amounts rounded to whole dollars per ATO requirements

### Changed
- **BAS amounts rounded to whole dollars** � all amounts shown on the BAS detail page and exported to CSV are now rounded to the nearest whole dollar, removing cents; this matches the ATO's requirement that BAS figures be reported in whole dollars
- **PAYG Instalment field relabelled from T4 to T7** � the income tax instalment input on the BAS detail page is corrected from *"T4 � PAYG Instalment"* to *"T7 � Instalment Amount"* to match the ATO's current BAS form field code
- **P&L report COGS and Expense sections now include bank transactions, journal entries, and split lines** � previously the Cost of Goods Sold and Expenses sections of the Profit & Loss report only aggregated `Expense` records; matched bank transactions posted to COGS or Expense accounts, manually entered journal entries, and their split line components are now also included in the relevant P&L sections, ensuring the report reflects the full double-entry picture for any posting method

## [1.4.9] - 2026-04-18

### Fixed
- **Account ledger "Account" column now shows `� ChildName` for all entry kinds** � when viewing a parent account's ledger, Sales Invoice and Split entries from child accounts were missing the `� AccountName` prefix that Expense, Bank Transaction, and Journal entries already showed; both entry kinds now compare their `accountCode` against the current account's code and render the dash indicator when the entry belongs to a sub-account
- **P&L report parent account rows no longer styled differently** � group-header (parent account) rows on the Profit & Loss report were rendered in full foreground colour and bold, making them visually distinct from child account rows; they are now styled identically to other account rows (muted colour, same font weight); child accounts continue to be indented with extra left padding to maintain the hierarchy
- **Bank Transactions and Expenses CSV/PDF export now includes all records in the date range** � exporting from Bank Transactions or Expenses previously exported only the current visible page; both pages now fetch all matching records (up to 10 000) from the API before building the CSV or triggering the print dialog; the API routes accept a `download=true` parameter that raises the per-request page-size cap accordingly

## [1.4.8] - 2026-04-18

### Added
- **Clickable P&L amounts drill through to account ledger** � each line-item amount on the Profit & Loss report is now a link that opens the corresponding account's ledger page pre-filtered to the same date range that was used to run the report; the `from` and `to` values are passed as query parameters and the account ledger initialises its date range from them on load
- **Edit reconciled expense account and tax code** � reconciled expenses can now have their Account and Tax Code changed from the Edit Expense modal; Date and Amount remain locked; saving a reconciled expense with a changed account or tax code also propagates the change to the linked bank transaction's `accountId` / `taxCode` fields; attachments belonging to the expense are moved to the correct account folder on disk when the account changes

### Changed
- **Chart of Accounts balance column shows ex-GST amounts** � the Balance column on the Chart of Accounts list and the Period Total / per-row amounts on the individual account ledger now show expense amounts excluding GST, consistent with the P&L report; the column header is labelled "Balance (ex-GST)" and the ledger column is labelled "Amount (ex-GST)"
- **Edit Expense info text updated for reconciled lock** � the informational note shown at the top of the Edit Expense modal for reconciled expenses now reads: *"Date and amount are locked for reconciled expenses. You can still update account, tax code, supplier, description, notes, and attachments."*
- **P&L and account ledger clickable amounts use default text colour** � the linked/clickable amounts in the P&L report and the account ledger rows no longer use the primary accent colour; they render in the default foreground colour and only underline on hover

## [1.4.7] - 2026-04-18

### Added
- **GST column on Matched bank transactions** � the Matched tab in Bank Accounts now shows a "GST" column displaying the tax code/rate name (e.g. "GST 10%", "GST Free") for each posted transaction row, giving a quick visual audit trail without expanding the transaction
- **Amount search on Bank Transactions and Expenses** � the description/reference search fields on both the Bank Accounts page and the Expenses list now also match by dollar amount; entering a whole number (e.g. `132`) matches all transactions or expenses whose amount starts with those digits across multiple magnitudes ($132.xx, $1,320.xx, $13,200.xx etc.); entering a decimal (e.g. `132.50`) matches exactly; both credit and debit amounts are matched on the transactions list
- **Bank Transactions search input** � a search box is added next to the tab bar on the Bank Accounts transactions table, allowing free-text filtering by description, reference, or amount across the active tab; the search field clears automatically when switching tabs

### Changed
- **Profit & Loss report shows ex-GST amounts** � all income, COGS, and expense figures on the P&L report are now reported excluding GST; a `"All figures shown ex GST"` note is shown at the top of the report card; bank transaction income lines, journal entry lines, and split lines all pass through a new `amountExcludingGst()` helper that strips the GST component before accumulation; the CSV export column header is updated to `"Amount (ex GST)"`; the Balance Sheet equity calculation likewise switches from `amountIncGst` to `amountExGst` for expense accumulation
- **Profit & Loss report groups lines by parent/child account hierarchy** � income, COGS, and expense rows are now structured hierarchically: parent accounts appear as bold group headers with no amount, and their child accounts are listed below indented; accounts with no activity are hidden; any accounts not belonging to a known parent are appended flat at the end as before; the CSV export preserves the same structure with account codes prefixed to names
- **Profit & Loss report adds COGS and Expenses subtotals** � the Cost of Goods Sold section now shows a "Total Cost of Goods Sold" subtotal row and the Expenses section shows a "Total Expenses" subtotal row; `totalCogsCents` and `totalExpenseCents` are added as explicit fields on the `ProfitLossReport` type
- **Expenses list status filter removed** � the "All statuses" dropdown filter on the Expenses list is removed; filtering by status is handled via the existing search and date range controls; the search input is widened and its placeholder updated to `"Search supplier, description, amount�"`
- **Chart of Accounts type filter removed** � the "All types" account-type dropdown on the Chart of Accounts page is removed; the search input already filters across code and name and the hierarchical grouping makes per-type filtering redundant
- **BAS detail page uses full-width layout** � the `max-w-3xl` container constraint is removed from the BAS period detail page so the form and lodgement cards use the full available width consistent with the rest of the accounting section

### Fixed
- **`NewExpenseDropZone` file-input click did nothing** � the hidden `<input type="file">` was wired with a `useState<HTMLInputElement | null>` pair and a manual `useCallback` ref-setter instead of a plain `useRef`; `fileInputRef[0]` was always `null` so clicking the drop zone never opened the file picker; fixed by replacing the pattern with `useRef<HTMLInputElement | null>(null)` and calling `fileInputRef.current?.click()`

## [1.4.6] - 2026-04-18

### Added
- **Drag-and-drop file attachment on bank transaction posting form** � the "Attach receipt or tax invoice" link on the Pending transactions posting form is replaced with a dashed drop zone that accepts dragged files or a click-to-browse interaction; the zone highlights with a primary-colour tint when a file is dragged over it; queued files are listed with white text and per-file remove buttons consistent with the rest of the attachment UI
- **Drag-and-drop file attachment on `AttachmentsPanel`** � the plain "Add files" button on the shared `AttachmentsPanel` component (used on Posted transaction detail panels and the Edit Expense modal) is replaced with the same dashed drop-zone used on the posting form; drag-over highlighting, disabled-state handling, and error display are all managed internally so every upload surface is consistent without changes to callers
- **Drag-and-drop file attachment on New Expense modal** � the New Expense form's bespoke file `<label>` picker is replaced with a `NewExpenseDropZone` component using the same dashed zone; staged files are shown above the zone with white text and per-file remove buttons matching the posting-form style
- **Expenses list paperclip badge reflects linked bank transaction attachments** � the paperclip icon on each row of the Expenses list now appears when either the expense has its own direct attachments **or** its linked bank transaction has attachments; the list API query is extended with a `_count` sub-select on the bank transaction's `accountingAttachments` relation so no extra round trip is needed, and the `Expense` type gains an optional `linkedTransactionAttachmentCount` field propagated through the DB mapper

### Fixed
- **Accounting file volume `EACCES` errors on all attachment upload routes** � the `accounting-data` Docker named volume was initialised with root ownership before the Dockerfile established `/app/accounting` as `app:app`, causing every `mkdir` call under that path to fail with `EACCES: permission denied`; fixed by re-owning the existing volume contents to UID/GID 911 (`docker run --rm -v vitransfer-tvp_accounting-data:/data alpine chown -R 911:911 /data`); no Dockerfile or Compose changes are required for fresh installs because the image already creates the directory with correct ownership at build time
- **Attachment upload failures on transaction post and expense save were silently ignored** � the `handlePost` loop in the bank-accounts page and the `handleSave` receipt-upload loop in `ExpenseFormModal` both awaited attachment uploads without checking the response status; a server error (such as the `EACCES` above) would complete the post/save action and discard the file silently; both paths now inspect the response, surface the server error message to the user, and halt further uploads on the first failure; the `handleUploadAttachments` path in `ExpenseFormModal` likewise now propagates the error into the visible error state instead of silently skipping failed files

## [1.4.5] - 2026-04-18

### Fixed
- **Bank transaction suggested-account matching now prefers real merchant matches over generic card-feed text** � the previous `GET /api/admin/accounting/transactions/suggest-account` logic still relied on broad raw-description token matching, so boilerplate terms such as location names, `card`, `value`, `date`, and masked card fragments could cause unrelated historical expenses to dominate by frequency; the route now normalizes descriptions, ignores generic bank-feed tokens, extracts a small set of meaningful merchant-like terms, scores recent matched transactions by description similarity, and then ranks accounts by aggregated score instead of simple count; this keeps the lookup lightweight while allowing recurring merchants such as Adobe to resolve to the correct child expense account instead of falling back to a more common but unrelated account like Website

## [1.4.4] - 2026-04-18

### Fixed
- **Suggest-account endpoint now returns correct account for expense-type postings** � when a bank transaction is matched via an `Expense` record the `accountId` lives on the linked expense row, not on `BankTransaction.accountId` (which is `null` for those postings); the `GET /api/admin/accounting/transactions/suggest-account` route was therefore ignoring all expense-matched transactions when building the frequency table; it now expands the match filter to include rows where `expense.isNot: null`, reads the account from `expense.accountId` when present, and constructs the description filter as an `AND` clause to avoid interfering with the new `OR` broadened match; the suggested account is now drawn from the full history of expense and non-expense postings rather than only non-expense ones
- **Running Jobs panel shows version label for Dropbox upload entries** � completed and errored Dropbox upload entries in the Running Jobs panel were labelled with only the video file name; the `versionLabel` field is now fetched alongside the other video fields and appended to the label (e.g. "clip.mp4 v2") so version uploads are distinguishable from the original at a glance

### Security
- **Upgraded `dompurify` to `^3.4.0`** � resolves GHSA-39q2-94rc-95cp (moderate): `ADD_TAGS` form bypass of `FORBID_TAGS` due to short-circuit evaluation in versions = 3.3.3

## [1.4.3] - 2026-04-14

### Changed
- **Docker containers now drop all Linux capabilities** � both the `app` and `worker` services include `cap_drop: ALL` in both Compose files, eliminating the ambient capability set that containers inherit by default; neither service requires any elevated capability at runtime, so removing them reduces the blast radius of any container compromise
- **Docker containers use an init process for correct signal handling** � both `app` and `worker` services now set `init: true`, which injects a minimal init (tini) as PID 1; this ensures SIGTERM is forwarded correctly on `docker compose stop` and that zombie child processes (e.g. spawned ffmpeg or shell subprocesses) are reaped properly
- **Structured log rotation on all services** � all four services (`postgres`, `redis`, `app`, `worker`) now configure the `json-file` logging driver with `max-size: "10m"` and `max-file: "3"`, capping the total log footprint to 30 MB per service and preventing unbounded log growth on long-running hosts

### Fixed
- **Rate limiter key collisions between API endpoints** � the `rateLimit()` calls on `GET /api/client-activity`, `GET /api/running-jobs`, `POST /api/settings/delete-closed-project-previews`, `POST /api/settings/purge-bullmq-jobs`, and `POST /api/settings/purge-notification-backlog` were not passing an explicit key name; without a per-route key, distinct endpoints can share the same Redis counter and trigger each other's limits under concurrent polling; each call now passes a unique string key so rate limit windows are tracked independently per endpoint

## [1.4.2] - 2026-04-14

### Changed
- **Removed `node_modules` from Dockerfile `chmod -R` in both app and worker images** � the production containers run as a non-root UID from Docker Compose and only need read and traverse access to dependency files; `npm ci` installs package files and directories with the normal read and execute bits needed at runtime, so recursively re-granting `a+rX` across the entire `node_modules` tree was redundant in practice and was adding significant time to every image build; writable runtime paths remain handled separately, while the smaller read-only runtime targets (`.next`, `public`, `prisma`, `src`) continue to receive explicit permission normalization
- **Docker images now default to non-root execution** � both app and worker images set `USER app` (UID 911) so containers run unprivileged even without a Compose-level `user:` override; the repository Compose files also explicitly set `user: "911:911"` for consistency
- **Removed legacy `PUID`/`PGID` environment variables** � these were passed into the container but never consumed by the entrypoint or application; removed from Compose files, `.env.example`, setup scripts, and docs; use Compose `user:` to control the runtime UID/GID instead
- **Removed `openssl-dev` from runtime images** � only the `openssl` library is needed at runtime; the development headers added unnecessary attack surface and image size

### Security
- **Upgraded `next` to `^16.2.3`** � addresses known CVEs patched in recent Next.js releases
- **Upgraded `mailparser` to `^3.9.8`** � picks up security and correctness fixes in the mail parsing library
- **Upgraded `nodemailer` to `^8.0.5`** � resolves vulnerabilities identified in the previous minor version

## [1.4.1] - 2026-04-13

### Added
- **Linked bank transaction viewer across accounting tables** � an eye icon button now appears on relevant rows throughout the Accounting section to open a modal showing the full linked bank transaction without leaving the page; the icon appears on expense rows and split-line rows in the account ledger, on sales invoice rows (with a chooser dialog when multiple matched payments exist), and in the Expenses list between the edit and delete actions
- **Edit Expense modal shows linked bank transaction attachments** � when an expense is linked to a bank transaction, a read-only "Linked Bank Transaction" section appears in the Edit Expense modal with a link to view the transaction and a list of the bank transaction's attachments; files in that section can be downloaded in place
- **Accounting Dashboard shows current balance and pending transaction count** � the bank account cards on the Accounting Dashboard now display the live current balance and a count of pending (unmatched) transactions instead of the static opening balance

### Changed
- **Unified accounting table action buttons** � row action buttons across the entire Accounting section (Expenses, Chart of Accounts, BAS, Settings, Bank Transactions) are now styled consistently with the Sales/Invoices pattern: circular outline, icon-only, red trash can for destructive actions
- **Ignored bank transactions desktop view simplified** � the Ignored tab no longer shows Type or Account columns (which are always empty for excluded transactions) and replaces the expand chevron with direct icon-only Undo and Delete action buttons in the row
- **Confirmation required before deleting an expense attachment** � deleting an attachment from the Edit Expense modal now shows a confirmation prompt matching the safeguard already present on Bank Transaction attachments

### Fixed
- **Expenses list paperclip icon updates immediately after editing attachments** � adding or deleting an attachment inside the Edit Expense modal now updates the row's attachment indicator in the list without requiring a full page refresh
- **Project-page Add Task flow now opens and saves reliably** � the Project detail page was passing a prefilled stub task object into the shared Kanban card dialog, which caused the dialog to think it was editing an existing task; the create action therefore mislabeled the modal, omitted the required `columnId` on save, and could also abort silently if optional preload requests failed; new tasks from the Project page now stay in true add-mode, include the correct status column in the POST body, tolerate partial preload failures, and show any create error message instead of failing silently
- **Accounting transaction table sorting now matches the active sort controls** � the Bank Accounts and Expenses pages were re-sorting only the current client-side page after the API returned date-ordered results, which produced inconsistent ordering across pages and incorrect pagination when switching sort columns; both tables now pass the active sort key and direction to their list APIs so sorting happens server-side before pagination
- **Ignored bank transactions immediately shed attachment support** � when a transaction is marked ignored, any existing `AccountingAttachment` records are deleted and their files are removed from disk, the transaction detail panel stops showing an upload control for ignored rows, and the attachment upload API now rejects attempts to attach files to ignored transactions with a conflict response

## [1.4.0] - 2026-04-08

### Fixed
- **Guest share-page videos could stay stuck on loading** � the public share API fix for preview availability was only applied to the authenticated payload shape; the guest-mode serialization path still omitted `preview480Path`, `preview720Path`, and `preview1080Path`, so guest viewers could see videos in the sidebar but never request playback tokens; guest responses now include the same boolean preview-availability flags as the normal share payload
- **Original Videos missing from Project Data storage breakdown when Dropbox is enabled** � when a video is stored on Dropbox, its `originalStoragePath` (and video asset `storagePath`) is saved in the database with a `dropbox:` prefix; the disk-size helper `computeStorageEntrySizeBytes` passed this prefixed path directly to `getFilePath`, which does not understand the `dropbox:` scheme and resolved to a non-existent path, returning 0 bytes; those bytes then surfaced as unaccounted "Other files" instead of "Original Videos"; the helper now strips the `dropbox:` prefix before resolving the local file path so original video and asset sizes are correctly attributed in the Project Data panel

## [1.3.9] - 2026-04-08

### Added
- **Multi-file attachments on Expenses and Bank Transactions** � the previous single-file `receiptPath` / `attachmentPath` columns on `Expense` and `BankTransaction` are replaced by a new `AccountingAttachment` model that supports an unlimited number of files per record; each `AccountingAttachment` row holds a relative `storagePath`, the `originalName`, and a foreign-key to either a bank transaction or an expense (with `ON DELETE CASCADE`); files continue to be stored in `ACCOUNTING_STORAGE_ROOT` using the existing `FY{year}-{year}/<AccountName>/` layout; backed by migration `20260408000000_add_accounting_attachments` (creates the table and indices) and `20260408000002_remove_legacy_attachment_fields` (drops the legacy `receiptPath`, `receiptOriginalName`, `attachmentPath`, and `attachmentOriginalName` columns)
- **`AttachmentsPanel` shared UI component** � a new reusable `<AttachmentsPanel>` component in `src/components/admin/accounting/AttachmentsPanel.tsx` provides a consistent list / download / upload / delete UI for `AccountingAttachment` items; it accepts an `items` array, an optional `canUpload` flag, and async `onUpload` / `onDownload` / `onDelete` callbacks; used in both the new `ExpenseFormModal` and the Bank Accounts transaction detail panel
- **Expense form converted to an inline modal** � the standalone `/admin/accounting/expenses/new` and `/admin/accounting/expenses/[id]` pages are replaced by a new `<ExpenseFormModal>` dialog that opens directly on the Expenses list page without a navigation; both pages now immediately redirect to the list with `?new=1` or `?edit=<id>` query params respectively; the list page reads those params on mount and opens the modal automatically, preserving deep-link compatibility; the modal includes the full form, status badge, Approve and Delete actions, and the multi-file `AttachmentsPanel`
- **Expense entries in the account ledger are clickable to open the edit modal** � on the Chart of Accounts ledger page, clicking the amount cell of an Expense row now opens `ExpenseFormModal` inline (triggering reload of ledger entries on save) rather than navigating to a separate page
- **Browser push notifications for pinned system alert events** � `RATE_LIMIT_ALERT`, `QUICKBOOKS_DAILY_PULL_FAILURE`, `ORPHAN_PROJECT_FILES_SCAN`, and `DROPBOX_STORAGE_INCONSISTENCY` notifications now call `sendBrowserPushToEligibleUsers` when the in-app bell entry is upserted; the four new payload types are added to the `PushNotificationPayload` union; previously these pinned alerts were only visible in the notification bell and did not trigger a browser push

### Changed
- **Bank Accounts post form supports multiple file attachments** � the single-file "Attach receipt or tax invoice" control in the transaction posting form is replaced with a multi-file picker; selected files are listed individually with per-file remove buttons; files are uploaded sequentially to the new `POST /api/admin/accounting/transactions/[id]/attachments` endpoint after posting; the form state field changes from `file: File | null` to `files: File[]`
- **Paperclip badge shown on transaction rows that have attachments** � a `Paperclip` icon appears next to the date in the collapsed transaction row header whenever the transaction has one or more `AccountingAttachment` records, giving a quick visual indicator without expanding the row
- **Account ledger page uses full-width layout** � the page container switches from `max-w-7xl` to `max-w-(--breakpoint-2xl)` and gains responsive horizontal padding (`px-3 sm:px-4 lg:px-6 py-3 sm:py-6`) so wider ledgers on large screens use more of the available space; the `Date` and `Type` table columns are given `whitespace-nowrap` so they do not wrap on smaller viewports

### Fixed
- **Unmatch and undo operations clean up all attachment files** � the unmatch route and the account-ledger delete-entry route previously cleaned up only the single legacy `attachmentPath` / `receiptPath` field; they now query `accountingAttachments` on the transaction and linked expense, collect all `storagePath` values, and delete every file via `deleteAccountingFile` after the database transaction completes
- **Match operation relocates all attachment files into the correct folder** � when a bank transaction that already has `AccountingAttachment` records is matched to an expense, every file is moved from its original upload path into the `FY{year}-{year}/<AccountName>/` folder corresponding to the transaction date and posting account, and the `storagePath` on each `AccountingAttachment` row is updated accordingly; previously only the single legacy `attachmentPath` column was moved

## [1.3.8] - 2026-04-08

### Added
- **PAYG fields on BAS periods** � the BAS detail form gains two new optional dollar fields: **W2 � PAYG Withholding** and **T4 � PAYG Instalment**; when a period is lodged, a summary card displays both values alongside a calculated **Total Amount Payable to ATO** (net GST + W2 + T4); values are stored in the new `paygWithholdingCents` and `paygInstalmentCents` columns on `BasPeriod` (migration `20260407000004_add_bas_payg_payment`)
- **BAS payment recording** � a new **BAS Payment** card on lodged periods allows recording the date, amount, and chart-of-accounts posting account for the ATO payment; saving creates an `APPROVED` `Expense` record (tax code `BAS_EXCLUDED`) linked back to the period via `paymentExpenseId`; the payment can be deleted to reverse the entry; backed by a new `POST/DELETE /api/admin/accounting/bas/[id]/payment` route and four new `BasPeriod` columns (`paymentDate`, `paymentAmountCents`, `paymentNotes`, `paymentExpenseId`)
- **"Match Expense" on Bank Account transactions** � debit transactions in the Pending list now have a **Match Expense** button that opens a search dialog listing all unmatched expenses (DRAFT or APPROVED, not yet linked to a bank transaction); selecting one and confirming links the expense to the transaction and marks it MATCHED; backed by a new `GET /api/admin/accounting/unmatched-expenses` endpoint
- **Quick-match badges for exact-amount invoice and expense matches** � when the Pending tab is active the page eagerly loads all open invoices and unmatched expenses; any transaction whose amount exactly matches a single open invoice (credit) or a single unmatched expense (debit) shows a one-click badge directly on the transaction row; clicking the badge matches without expanding the row; the badge list refreshes after each match
- **Dedicated accounting file storage volume** � expense receipts and bank transaction attachments are now stored under a separate `accounting-data` Docker volume (`ACCOUNTING_STORAGE_ROOT`) rather than the shared uploads volume; files are organized as `FY{year}-{year}/<AccountName>/filename.ext` (or `FY{year}-{year}/<ParentAccount>/<ChildAccount>/filename.ext` for sub-accounts), making it straightforward to audit or archive documents by fiscal year; a new `file-storage.ts` module handles path building with path-traversal protection, FY resolution from `SalesSettings.fiscalYearStartMonth`, filename sanitisation, and automatic deduplication
- **"This financial year" and "All time" presets in DateRangePreset** � the date-range selector used across Accounting pages gains two new options: **This financial year** (full FY, not truncated to today) and **All time** (no date bounds); a new exported helper `getThisFinancialYearDates()` is used to initialise the Bank Accounts transaction filter and the Expenses list filter so both pages open showing the current FY by default instead of an empty date range; the component also now infers its active preset from externally controlled `from`/`to` values so the selector stays in sync when dates are set programmatically

### Fixed
- **Account balance sign incorrect for debit-normal accounts** � the `/api/admin/accounting/accounts/balances` endpoint was accumulating bank-transaction `amountCents` with the same sign for every account regardless of normal balance; credits (positive `amountCents`, money in) were therefore inflating debit-normal account balances (ASSET, EXPENSE, COGS) rather than reducing them; the endpoint now fetches account types, builds a debit-normal set, and negates contributions for those accounts so the balance reflects the correct accounting sign; the same sign fix is applied in the POST transaction route, which now uses `-txn.amountCents` instead of `Math.abs` so debit transactions (money out) produce positive expense amounts
- **Account ledger page did not show entries from child accounts** � viewing a parent account's ledger page (`/admin/accounting/chart-of-accounts/[id]`) only returned entries posted directly to that account ID; all child-account entries were silently omitted; the entries API now resolves all direct children, expands all five data sources (expenses, bank transactions, journal entries, split lines, sales invoice income) to the full account ID list, and returns a `hasChildAccounts` flag; an **"Includes sub-accounts"** badge appears on the account header when child entries are included; an **Account** column is added to the ledger table and CSV export showing the specific sub-account each entry was posted to; a `periodTotalCents` rolling total for the full period (not just the current page) is also returned and shown
- **Deleting a payment linked to a bank transaction now returns the transaction to Pending** � when a `SalesPayment` was deleted from the Sales � Payments page, the associated `BankTransaction` (if any) was left in `MATCHED` state with a dangling null `invoicePaymentId`, hiding it from the Pending list in Bank Accounts; the DELETE route now wraps the operation in a transaction that resets the bank transaction to `UNMATCHED` (clearing `matchType` and `transactionType`) before deleting the payment, so the transaction reappears in the Pending list ready to be re-matched
- **Deleting an expense or bank transaction now removes its on-disk file** � the expense DELETE route and transaction DELETE route previously removed the database row but left the receipt / attachment file on disk; both routes now read the stored file path before deletion and call `deleteAccountingFile` to clean up the physical file
- **Attachments organised into the correct FY/account folder on post and match** � when a bank transaction that already has an attachment is then posted as an expense or matched to an existing expense, the attachment file is now relocated from its original upload path into the `FY{year}-{year}/<AccountName>/` folder that corresponds to the transaction date and posting account, keeping the storage layout consistent across all document types
- **Bank Accounts pending-tab actions no longer reload the full transaction list** � posting, ignoring, undoing, splitting, and invoice-matching operations previously called `loadTransactions()` after completion, triggering a full server fetch and resetting scroll position; each action now removes the affected transaction from local state immediately, decrements the total, and collapses any expanded row, giving instant feedback without a round-trip
- **Unit price field cursor jumps to end while typing on Quote and Invoice pages** � the Unit `(${currency})` input on the New and Edit pages for both Quotes and Invoices stored `unitPriceCents` as the source of truth and re-derived the display string via `centsToDollars` (which formats with comma separators and always two decimal places) on every keystroke; any intermediate value that did not round-trip identically caused React to replace the `value` attribute, resetting the cursor to the end of the field; the input now tracks a raw string in `unitPriceInputs` state while the field is focused � the raw string is displayed during editing and `centsToDollars` is only used as the fallback display when the field is not being actively edited; on blur the raw entry is discarded and the canonical formatted value is shown

### Changed
- **Account search pickers now show hierarchical labels and search across the full name path** � all account typeahead inputs across Bank Accounts (posting form and split lines) and Expense forms previously displayed a flat `Type � Name` label and only matched against the account name and type string individually; a new `buildAccountOptions()` helper pre-computes a `label` field that includes the parent account name for child accounts (e.g. "Expense � Motor Vehicle � Fuel"), a `searchText` index combining code, name, full path, type label, and label, and sorts the list alphabetically; all pickers now use this pre-built index, eliminating repeated inline sort and filter operations

## [1.3.7] - 2026-04-07

### Fixed
- **Video quality options not loading on client share page** � the share API route was returning `undefined` for `preview480Path`, `preview720Path`, and `preview1080Path` instead of boolean availability flags; the player therefore could not detect which quality levels were available and failed to load; the route now returns the correct boolean values so quality selection works as expected
- **Archived task list not refreshing after deleting an archived task** � deleting a card from the archived view did not re-fetch the archived list; a `key` prop driven by a counter (`archivedViewKey`) is now incremented after each delete, forcing the archived panel to remount and reload its data

## [1.3.6] - 2026-04-07

### Added
- **Reporting settings** � Accounting � Settings gains a global **Reporting Basis** preference (Cash vs Accrual) stored in the new `AccountingSettings` table; the Sales Dashboard independently respects a `dashboardReportingBasis` and `dashboardAmountsIncludeGst` override (new columns on `SalesSettings`) so the dashboard totals can differ from the full accounting reports
- **Sales Labels** � a new `SalesLabel` model provides colour-coded labels (hex colour, optional Chart of Accounts account mapping, sort order, active flag) that can be assigned to Sales Library Items; labels bridge the sales and accounting modules by linking a line-item category to a default posting account; backed by the `SalesLabel` table with a `labelId` foreign key added to `SalesItem`
- **Default income account in Sales Settings** � a default Chart of Accounts `Account` can now be selected in Sales Settings (`defaultIncomeAccountId`); used as the fallback posting account when sales transactions are surfaced in the accounting module

## [1.3.5] - 2026-04-06

> **? Upgrade note � migration squash:** The 67+ individual Prisma migrations accumulated since v0.1 have been collapsed into a single baseline snapshot (`20260405000000_baseline`). **Fresh installs are unaffected.** If you are upgrading an existing instance, the baseline migration will appear as "pending" to Prisma even though your database already has all the tables � running `migrate deploy` without preparation would fail. Before pulling this release and running `docker compose up -d --build`, mark the baseline as already applied against your running database:
> ```bash
> # 1. Build the new image first (does not start the container)
> docker compose build
> # 2. Mark the baseline migration as already applied (no SQL runs � Prisma just records it)
> docker compose run --rm --no-deps app npx prisma migrate resolve --applied "20260405000000_baseline"
> # 3. Start normally � only the 3 new accounting migrations will be applied
> docker compose up -d
> ```
> **Why the squash was necessary:** Over 5+ months of development the migration folder had grown to 67+ files, many with timestamp collisions and implicit ordering dependencies. This caused unreliable first-run installs and made Prisma's migration history difficult to audit. The squash replaces all prior migrations with a single authoritative schema snapshot and resets the history cleanly.

### Added
- **Accounting module** � a new Accounting section (still under development) is available from the admin header navigation (sub-menu: Dashboard, Bank Accounts, Expenses, Chart of Accounts, BAS / GST, Reports); the module introduces Chart of Accounts management, bank account and transaction import, expense tracking with receipt upload, and transaction posting/matching workflows; three new database migrations introduce the accounting schema (`add_accounting_module`, `add_accounting_settings`, `make_expense_supplier_optional`)

### Fixed
- **Avatar endpoint rate limit raised to prevent false lockouts** � `GET /api/users/[id]/avatar` had a limit of 120 requests per minute; pages that render many users simultaneously (Kanban board, project member lists, etc.) fire one avatar request per visible user, making the old limit trivially easy to hit during normal navigation; the limit is raised to 600 requests per minute and `force-dynamic` is removed so that browser and CDN cache headers can reduce repeat requests over a session
- **Project storage panel now shows "Other files" as a separate row** � unaccounted on-disk bytes (`diskOtherBytes`) were previously surfaced only as inline text ("On disk � X other") in the Source tooltip row; they are now displayed as a dedicated "Other files" row in the storage breakdown alongside Videos, Photos, ZIP files, and Project Files, making the total more transparent and consistent; additionally a `else if` bug in the storage calculation prevented `timelinePreviewVttPath` from being counted when a video also had a `timelinePreviewSpritesPath` � both paths are now always included in the preview storage total
- **"No open invoices found" after manually deleting a payment** � the payment DELETE route removed the `SalesPayment` record but never called `recomputeInvoiceStoredStatus`, leaving the invoice's stored status as `PAID` even after the payment was gone; the route now reads the `invoiceId` before deletion and recomputes the invoice status afterward so the invoice correctly returns to `OPEN` / `SENT` / `OVERDUE` and appears in the invoice-matching dialog in Bank Accounts

## [1.3.4] - 2026-04-04

### Added
- **Client association on Kanban tasks** � each task now has an optional "Client (Optional)" field in the Add and Edit Task modals; the field uses the same client typeahead search as quotes and invoices; selecting a client dynamically narrows the "Project (Optional)" dropdown to projects belonging to that client only; the client name is shown on task board cards beneath the description; a new `clientId` column is added to the `KanbanCard` table with a foreign-key relation to `Client`
- **Archive view Client column** � the archived tasks view gains a "Client" column between the title and Comments columns; the divider line below the archive header is removed and the Title/Status and Client columns share equal width
- **Tasks section on Project pages visible by default and in Show/Hide Sections toggle** � the Tasks panel on each project detail page is now included in the "Show/Hide Sections" dropdown; in defaults to visible (`tasks: true`); existing saved section-visibility settings are merged with the new default so upgrading users see the section automatically; the `tasks` key is validated server-side on save
- **"Add Task" button on Project pages** � a `+ Add Task` button (matching the style of the Key Dates "+ Add Date" button) appears in the Tasks panel header for users with change-project-settings permission; clicking it opens the full Add Task dialog with Client and Project pre-filled from the current project, so tasks can be created directly from the project page without navigating to the Kanban board

### Changed
- **"Link to Project" renamed to "Project (Optional)"** � the project picker in the Add/Edit Task modal is renamed and is now disabled until a client is selected first; when no client is selected the placeholder reads "Select a client first"; clearing the client also clears the selected project
- **Gotify/Ntfy webhook notifications removed** � the Gotify or Ntfy delivery channel is removed from Push Notifications; all webhook-related settings (Enable Gotify or Ntfy toggle, Webhook URL field) are removed from the Push Notifications settings card; push delivery now relies solely on Browser Push (PWA) and the in-app notification bell; the now-unused `provider`, `webhookUrl`, and deprecated `title` columns are dropped from `PushNotificationSettings`

## [1.3.3] - 2026-04-04

### Added
- **Kanban task board on Projects dashboard** � a fully-featured Kanban board lives below the project list on the Projects dashboard; columns can be created, renamed, given a hex colour, reordered by drag (with a column-lock toggle), and deleted; cards can be created in any column, dragged between columns and within columns to change position, assigned a title, rich-text description, optional due date, and an optional project link; the board automatically refreshes the key-dates calendar when a change is saved
- **Card member allocation with per-member notification toggle** � users can be added to or removed from any Kanban card; each member has an individual "Receive notifications" bell toggle that controls whether they receive in-app and browser push notifications for new comments on that card; system admins see all cards, non-admins see only cards on which they are a member or that are linked to a project they are assigned to
- **Comments on Kanban cards** � each card has a threaded comment section with support for top-level replies and nested replies; comments display the author's avatar (or initials fallback), name, timestamp, and content; authors can delete their own comments; admin users can delete any comment; new comments on a card enqueue a `TASK_COMMENT` notification in the existing scheduled notification queue, delivered to card members who have their notification bell enabled
- **Email digest for Kanban task comments** � the worker's scheduled notification pass now includes a `processTaskCommentNotifications` step that batches unsent `TASK_COMMENT` queue entries, groups them by card, and sends a summary email to each card member with notifications enabled; the email lists every new comment per task with author name, email, and content, and includes a direct link to the Projects dashboard; the `Settings` table gains a `lastTaskCommentNotificationSent` column for schedule-tracking
- **Kanban card history log** � every significant action on a card (created, moved between columns, member added/removed, due date set/removed, project linked/removed, title or description edited) is recorded as a `KanbanCardHistory` row with the actor's name snapshot and a JSON payload; the history timeline is displayed inside the card dialog in chronological order with human-readable descriptions and relative timestamps
- **Archive and restore Kanban cards** � an admin-only "Archive" option on each card sets `archivedAt` and removes the card from the board view; a separate "Archived" panel shows all archived cards newest-first with full member and project context; each archived card has an "Unarchive" button that returns it to its original column (or the leftmost column if that column was deleted)
- **Project Tasks panel on the Project detail page** � each project detail page includes a "Tasks" section listing all active Kanban cards linked to that project, showing the card title, column, due date, member avatars, and comment count; clicking a task opens the full card dialog inline; the Projects dashboard handles an `?openTask=` query parameter so clicking a task from the project page navigates to the board and opens the correct card
- **Kanban task due dates in the Projects calendar widget** � tasks with a due date appear on the key-dates calendar as cyan pill entries alongside project key dates; clicking a task pill opens the card dialog on the board; the calendar legend gains a "Task" entry; the calendar refreshes whenever the board changes
- **Task due dates in the ICS calendar export** � the `/api/calendar/key-dates` ICS feed now includes `VEVENT` entries for all Kanban cards with a due date that fall within the calendar window and are visible to the requesting user (admin sees all; non-admin sees only member/project-linked cards), complete with `LAST-MODIFIED` stamps
- **Sales Line Item Library** � a global "Items" library (`SalesItem`) lets teams define reusable line items (description, optional detail text, quantity, unit price, tax rate) once and import them into any quote or invoice; items persist independently of any preset and can be created, deleted, and browsed from the new "Add items" modal
- **Sales Line Item Presets** � named presets (`SalesPreset`) bundle a selection of library items with a defined sort order; presets are saved, listed, and deleted from the same modal; applying a preset auto-checks its items for one-click import; saving a preset with an existing name replaces its item selection (upsert)
- **"Add items" modal on Quotes and Invoices** � both the New and Edit pages for Quotes and Invoices gain an "Add items" button that opens the `SalesLineItemPresetsModal`; the modal lists all library items with checkboxes, a preset selector to pre-check a bundle, a form to add a new item to the library, and a preset save/delete UI; clicking "Import selected" appends the chosen items as line items; blank placeholder rows are removed before appending when using the New page
- **Drag-to-reorder line items on Quotes and Invoices** � every line item row on the New and Edit pages for both Quotes and Invoices now has a grip-handle on the left; holding the handle activates HTML drag-and-drop reordering; the drop target is highlighted with a ring; reordering is reflected immediately in the saved document
- **Duplicate Quote / Duplicate Invoice** � a Copy icon button on the Quote and Invoice edit pages serialises the current notes, terms, and line items into `sessionStorage` and redirects to the New page, which reads and clears the prefill on mount so the duplicated document opens ready to save
- **Notification log entries automatically purged after 45 days** � a daily worker job (02:30 server/container time) deletes `PushNotificationLog` rows with a `sentAt` older than 45 days; pinned system notification types (Dropbox inconsistency, orphan files, QuickBooks pull failure, rate limit alert) are excluded from the purge and continue to persist until manually cleared
- **"None" option replaces "Weekly" in Admin and Client Notification Schedules** � the `WEEKLY` schedule option is removed from both the global Admin Notification Schedule and per-project Client Notification Schedule; a new `NONE` option ("Do not send comment notification emails") is available in its place; all schedule pickers, API validation, and worker logic are updated accordingly; existing `WEEKLY` database values are migrated to `NONE`
- **Per-type toggles for automated admin system emails** � the Email / SMTP & Notifications settings card gains an "Admin System Emails" section with individual on/off switches for each category of automated email sent to internal users: project approved by client, internal comment digests, task comment digests, invoice paid (Stripe), quote accepted by client, project key date reminders, and personal key date reminders; all toggles default to enabled; the corresponding workers and webhook handlers respect the toggle before sending
- **Default Client Notification Schedule in Default Project Settings** � the Default Project Settings card now includes a Client Notification Schedule selector (Immediate / Hourly / Daily / None) and a "Client System Emails" section; newly created projects inherit the chosen schedule; a "Project approval confirmation" toggle controls whether the automated approval email is sent to the client when they approve a project; the existing per-project schedule selector continues to override the default for individual projects

### Changed
- **"Gotify Notifications" and "Browser Push (Admin)" settings merged into a single "Push Notifications" section** � the two separate Global Settings cards are replaced by one unified card; the section contains a master enable/disable toggle, a Gotify or Ntfy sub-toggle (with the webhook URL field shown only when enabled), and the browser push device management panel embedded inline; the sidebar navigation item count reduces from twelve to eleven sections
- **Push notification master toggle now gates all delivery channels** � previously the master toggle only controlled Gotify/webhook delivery while browser push always fired regardless; the master toggle now applies to both browser push and webhook delivery so disabling push notifications stops all outbound push across every channel while still logging events for the in-app notification bell
- **Per-event toggles now apply to browser push as well as webhook delivery** � the "Enable Notifications For" toggles previously only controlled Gotify delivery; they now control all push channels (browser push, Gotify, Ntfy) simultaneously; disabling an event type suppresses delivery on every channel
- **Gotify or Ntfy webhook label and description updated** � the "Enable Gotify Notifications" toggle is renamed to "Enable Gotify or Ntfy Notifications" with a description clarifying that either service works; the webhook URL placeholder shows both formats (`https://gotify.example.com/message?token=TOKEN` and `https://ntfy.example.com/topic`)
- **Gotify/Ntfy webhook notifications now use the same content templates as browser push** � the webhook sender previously built a raw key/value message from the payload details map; it now calls `buildAdminWebPushNotification` (the PWA template layer) for consistent, human-readable titles and bodies across all push channels
- **"Notification Title Prefix" field removed** � the optional free-text prefix that prepended `[prefix]` to Gotify notification titles is removed from the settings UI and the save path; the `title` column is retained in the database for backward compatibility but is no longer written
- **"Enable Notifications For" list updated with four additional event categories** � the toggle list gains: **Internal Comments** (admin project comments not visible to clients, previously lumped with Client Comments), **Task Comments** (Kanban board card comments, previously lumped with Client Comments), **User Assignments** (project and Kanban task assignments), and **Sales Reminders** (overdue invoice and expiring quote worker reminders); `INTERNAL_COMMENT`, `TASK_COMMENT`, `PROJECT_USER_ASSIGNED`, `TASK_USER_ASSIGNED`, `SALES_REMINDER_INVOICE_OVERDUE`, and `SALES_REMINDER_QUOTE_EXPIRING` payload types are all now mapped to their respective toggles and respected across every push channel; backed by a migration adding `notifyInternalComments`, `notifyTaskComments`, `notifyUserAssignments`, and `notifySalesReminders` columns to `PushNotificationSettings`
- **PWA notification templates extended for task and assignment events** � `buildAdminWebPushNotification` now has explicit cases for `TASK_COMMENT` (showing task title, author, and comment excerpt), `PROJECT_USER_ASSIGNED` (showing project and assigning user), and `TASK_USER_ASSIGNED` (showing task, project, and assigning user); these event types previously fell through to the generic fallback
- **Schema: `Comment.videoId` formalised as a foreign key** � a proper `FOREIGN KEY` constraint with `ON DELETE CASCADE` is added from `Comment.videoId` to `Video.id`, plus a composite index on `(projectId, videoId)` for efficient video-scoped comment queries; this closes a latent data-integrity gap where deleting a video via raw SQL would have left orphaned comment rows
- **Schema: `NotificationQueue.type` converted from plain string to enum** � the column is now typed as the Postgres enum `NotificationQueueType` (`CLIENT_COMMENT | ADMIN_REPLY | INTERNAL_COMMENT | TASK_COMMENT`); the migration casts existing values to the enum in place; new `TASK_COMMENT` type supports Kanban comment notifications alongside the existing project-comment types
- **Schema: redundant `User.role` column and `UserRole` enum removed** � the legacy `role VARCHAR` column on `User` and the single-value `UserRole` enum (`ADMIN`) are dropped; all session tokens, API routes, auth helpers, and the `setDatabaseUserContext` function now read the role name from the RBAC `AppRole` relation (`appRoleName`); the passkey login flow is updated accordingly

### Fixed
- **Video delete now uses database cascade for comment cleanup** � `Comment.videoId` previously had no foreign-key constraint to `Video`, so comments had to be deleted in a manual Prisma transaction before the video could be deleted; the new FK (`ON DELETE CASCADE`) lets the database handle comment removal automatically; the manual transaction is removed

## [1.3.2] - 2026-04-02

### Fixed
- **Client detail Quotes and Invoices tables no longer wrap columns on mobile** � the Quote/Invoice number, Issue date, Amount, and Status columns now have minimum fixed widths so they cannot shrink below a readable size on narrow screens; the Project column has a 200 px minimum width so longer project names have more room; the Payments table Date, Amount, and Invoice columns likewise have minimum widths; the overflow-x-scroll wrapper on each table allows horizontal scrolling when the viewport is narrower than the total table width

### Added
- **Photos count on the Client detail project table** � the project table on the Client detail page now includes a "Photos" column showing the total number of photos across all albums in that project; the "Versions" and "Comments" columns have been removed; the `/api/clients/[id]/projects` endpoint now queries each project's albums and sums the photo count, returning a `photoCount` field per project row
- **Skip preview transcoding when uploading to a closed project** � when "Auto-delete video previews and timeline sprites when project is closed" is enabled, uploading a video (or version) to a project that is already CLOSED no longer queues a full transcode job; a thumbnail-only job is queued instead so the video enters READY status with a poster image but without generating preview files that would be immediately redundant

### Fixed
- **Share-page quality selector correctly reflects available preview resolutions** � the Admin and public Share pages now only fetch stream tokens for resolutions that have an actual preview file stored; previously the fallback logic populated all resolution tokens with the original file, causing the quality selector to show "Auto / 480p / 720p / 1080p" even when no previews existed; a dedicated `streamUrlOriginal` field is now passed to `VideoPlayer`, which displays a non-interactive "Original" quality button on both desktop and mobile when no preview resolutions are available and streams the original file directly
- **Client detail Quotes, Invoices, and Payments sorted by document date** � the Quotes and Invoices sections on the client detail page now sort by `issueDate` descending instead of `updatedAt`; the Payments section sorts by `paymentDate` descending instead of `createdAt`, matching the natural document ordering expected when reviewing a client's billing history
- **Invoice paid-on date uses consistent date formatting** � the "Paid on" display and the payment detail summary lines on Invoice detail pages now use the shared `formatDate` utility rather than raw YYYY-MM-DD string replacement

## [1.3.1] - 2026-04-02

### Added
- **Search on Invoices and Quotes list pages** � a text input above each table allows real-time filtering by document number, client name, or linked project title; the search resets the current page to 1 so results are always shown from the start; both lists also reset to page 1 when the search query changes alongside the existing status filter and sort controls
- **Rate limit lockouts logged as Security Events** � when a rate limit lockout is triggered, a `RATE_LIMIT_HIT` security event is written at WARNING severity with `wasBlocked: true`, recording the rate limit type and the client IP address so lockout activity is fully auditable on the Security Events page
- **Rate limit lockouts surface as pinned notifications** � alongside the security event, a pinned `RATE_LIMIT_ALERT` notification is upserted in the notification bell; the notification includes the rate limit type, IP address, and retry-after window; it persists until manually cleared and links directly to the Security Events page; duplicate lockout events on the same limit type update the existing notification rather than creating additional entries
- **Export client emails as CSV** � a download button on the Clients list page generates a `client-emails.csv` file containing all contacts (not just the primary) across all clients that match the current active filter; each row includes the contact name, email address, company name, and a "Primary" flag indicating whether the contact is the primary recipient; contacts without an email address are omitted
- **Sales Projects Overview and Clients Leaderboard now use Project Start Date** � the Projects Overview chart and Clients Leaderboard on the Sales Dashboard now bucket closed projects by their `startDate` (falling back to `createdAt` when unset), consistent with how Start Date is used elsewhere in the app; the projects-chart API endpoint was updated accordingly
- **"All time" period option on the Clients Leaderboard** � the Clients Leaderboard chart gains an "All time" option in its period selector that shows every client with at least one closed project regardless of date, bypassing the month-bucketing filter used by the other period options
- **Admin can now delete any internal comments** � users can still delete their own comments, but now Admin can delete all internal comments

### Fixed
- **QuickBooks pull no longer creates duplicate contacts on matched clients** � the `ensurePrimaryRecipient` helper was being called even when a QB customer record was matched to an existing client (both the "matched by QB ID" and "matched by name" update paths), potentially creating a duplicate recipient row on every scheduled pull; the call is now removed from both update branches in the manual pull API route and the daily pull runner; new-client creation is unaffected and still assigns a contact
- **New Project page shows the server error reason on failure** � the error alert now reads "Failed to create project: \<reason\>" instead of the uninformative static message

### Changed
- **Pinned system notification helpers extracted to a shared module** � `isPinnedSystemNotificationType`, `isPinnedSystemNotificationDetails`, `isClearablePinnedNotificationDetails`, and all pinned notification type constants have been moved from `dropbox-storage-inconsistency-notification.ts` into a new `pinned-system-notifications.ts` module; the old file is removed; all import sites updated; this consolidates the `RATE_LIMIT_ALERT` type alongside the existing Dropbox, orphan-scan, and QuickBooks constants
- **Zero-quantity line items now supported on quotes and invoices** � the Qty field minimum is now 0 (was 1) so descriptive or informational line items with no chargeable quantity can be entered; the quantity normalizer on save now preserves 0 instead of substituting 1; the QuickBooks pull line-item normalizer (`normalizeEstimateLines` / `normalizeInvoiceLines`) likewise preserves a `qty` of 0 from QuickBooks rather than coercing it to 1, and the unit-price calculation guards against division-by-zero when `qty` is 0
- **Pagination controls replaced with icon buttons throughout the app** � every paginated table that previously showed "Previous" and "Next" text buttons now shows a four-button row of icon-only controls (first page, previous, next, last page) using `ChevronsLeft` / `ChevronLeft` / `ChevronRight` / `ChevronsRight`; affected areas: Projects dashboard, Security Events, Project Email table, Project Activity log, Project Analytics client list, Sales doc views and email-open tracking, Client detail quotes/invoices/payments tables, Invoices list, Quotes list, and Payments list
- **Client detail sales tables paginated instead of truncated** � the Quotes, Invoices, and Payments sections on the client detail page previously displayed only the first 10 records with a "View all" link; they now show a full paginated view (10 per page) with first/prev/next/last controls, and the "View all" links have been removed; page cursors reset to 1 when the client changes
- **Rate limiting on project routes scoped per user** � the projects-list (`GET /api/projects`) and create-project (`POST /api/projects`) rate limiters now include the authenticated user's ID in the limit key; previously the limit was shared across all users, so one user's burst could exhaust the quota for others
- **Preview file deletion parallelised when closing a project** � when the "Auto-delete previews on close" setting is enabled, preview file deletions across all videos in the project now run concurrently via a single `Promise.allSettled` call instead of sequentially for each video; the subsequent raw-SQL path-column nulling (introduced in v1.3.0 to avoid bumping `updatedAt`) is unaffected
- **Primary button gradient removed** � the `.btn-primary` CSS utility class no longer applies a `linear-gradient` overlay on top of the primary colour token; buttons render a flat primary colour consistent with the design language introduced in v1.2.6

## [1.3.0] - 2026-04-01

### Added
- **User profile pictures** � admin users can upload, crop, and remove a profile photo from the Edit User page; photos are stored server-side and served through a dedicated avatar endpoint with cache-busting; a canvas-based drag-to-reposition and zoom crop dialog makes it easy to frame the shot; a fallback initials circle using the user's display colour is shown whenever no photo is set
- **Profile pictures shown throughout the app** � uploaded avatars now appear in the Project page assigned-users list (both the search dropdown and added-user cards), the Projects dashboard Users column, and comment bubbles on both the client and admin Share pages
- **My Profile modal in the admin header** � the email+icon display in the top-right header is replaced with a User icon button that opens a profile modal; the modal shows the user's current profile picture (with the ability to upload or remove it), read-only fields for Name, Username, Email, Role, and Phone, and a password-change form (current password, new password, confirm)
- **Self-service password change for all authenticated users** � any signed-in internal user can now update their own password via the My Profile modal regardless of whether they have access to the Users settings page; the `/api/users/[id]` GET endpoint also allows users to fetch their own profile data without requiring the users menu permission
- **Project Start Date** � projects now have an optional Start Date field separate from their creation date; users with Full Control can edit the start date inline on the project detail page; the New Project form includes a Start Date input that defaults to today; the Projects dashboard and Client detail project tables now display a sortable "Start Date" column (replaces the former "Date Created" column); project dropdown lists in Quotes and Invoices sort by start date then creation date; backed by a new database migration adding a nullable `startDate` DateTime column to the Project table
- **Auto-promote projects when Start Date is due** � the worker job that previously auto-started projects only on a SHOOTING key date now also promotes projects from NOT_STARTED ? IN_PROGRESS when their `startDate` is today or earlier; duplicates are deduplicated so a project with both triggers is only promoted once; saving a project's start date via the API also immediately promotes it if the new date is already due and no explicit status change was requested
- **Sales reminder push notifications** � when the sales reminders worker sends an overdue-invoice or expiring-quote email notification, it now also creates an in-app push notification for users with Sales menu access; each notification includes the document number, client name, and amount; clicking a `SALES_REMINDER_INVOICE_OVERDUE` or `SALES_REMINDER_QUOTE_EXPIRING` entry in the notification bell navigates directly to the relevant invoice or quote detail page
- **Share-page-gated notification delivery** � `CLIENT_COMMENT`, `ADMIN_SHARE_COMMENT`, and `VIDEO_APPROVAL` notifications are now only delivered (both in-app and via browser push) to users who have the `accessSharePage` permission in addition to being assigned to the project; `INTERNAL_COMMENT` and `PROJECT_USER_ASSIGNED` notifications remain accessible to any project-assigned user regardless of share-page access
- **QuickBooks pull assigns display colours to new contacts immediately** � when the QB pull-customers job creates a new client recipient it now assigns a random display colour at creation time, so the colour is applied without requiring a manual save from the Edit Client page

### Fixed
- **Closing a project no longer floods Running Jobs with stale completions** � when the "Auto-delete previews on close" setting is enabled, closing a project previously called `prisma.video.update()` for every video to null out preview/timeline paths, which bumped each video's `updatedAt` to the current time; the Running Jobs API uses `updatedAt` within the last 30 minutes as a proxy for "recently completed", so all those videos appeared as brand-new "Processing complete" and "Dropbox upload complete" entries; the preview-path nulling is now done via raw SQL (`UPDATE "Video" � WHERE "id" = ANY(�)`) which skips Prisma's automatic `updatedAt` management, leaving the timestamps untouched
- **Internal Comments scroll position defaults to bottom** � when the Internal Comments panel on the project page loads, the scroll container now correctly positions at the bottom so the most recent comments are immediately visible; previously the auto-scroll guard was being consumed on initial mount (when the comment list was still empty), which prevented the scroll from firing once the comments actually loaded

### Changed
- **Comment avatar size on Share pages increased slightly** � comment author avatars on both the client-facing and admin Share pages are 25 % larger than their default size (up from 24 px to 30 px); reply avatars scale proportionally
- **`Textarea` component gains `autoResize` prop** � passing `autoResize` causes the textarea to automatically grow and shrink to fit its content (no scrollbar, `resize-none`); the project description field in both the New Project form and Project Settings now uses `autoResize` for a cleaner editing experience
- **Admin landing page suppresses spurious PERMISSION_DENIED security events** � security settings are now only fetched during landing-page load if the signed-in user actually has the `security` menu permission; previously the unconditional fetch produced a PERMISSION_DENIED security event on every page load for users without security access
- **RBAC enforcement distinguishes menu access denials from action access denials** � `requireMenuAccess` no longer writes a `PERMISSION_DENIED` security event when a user lacks menu access (this is expected, routine RBAC enforcement and was generating noise); `requireActionAccess` continues to log a PERMISSION_DENIED event at INFO severity so deliberate permission bypass attempts remain auditable

## [1.2.9] - 2026-03-30

### Added
- **Sales Dashboard � Sales Overview chart** � a monthly column chart displays invoice revenue for the selected period, positioned immediately above the QuickBooks Actions section; the subheader shows the period total, average revenue per month, and (for Financial Year to Date and Year to Date periods) a projected full-year figure extrapolated from the current run-rate; the projection accounts for partial-month progress by weighting the current month proportionally to the number of elapsed days, avoiding inflated projections early in a month
- **Sales Dashboard � Quotes Overview chart** � a dual line chart plots total quotes issued and accepted quotes per month side-by-side; "Total" counts every quote for the month by issue date regardless of status, while "Accepted" counts only quotes that reached accepted status; the subheader displays totals and a win-rate percentage; both lines share the same period selector
- **Sales Dashboard � Projects Overview chart** � a composite chart combines a bar series (closed project count per month, left axis) with a line series (average invoiced value per project, right axis), giving simultaneous visibility of volume and deal size; only projects with `CLOSED` status are included; projects are bucketed by creation date; a new `/api/admin/sales/projects-chart` endpoint serves the data, computing each project's total invoiced amount by summing all linked invoice line items including tax
- **Sales Dashboard � Clients Overview leaderboard** � a ranked list beneath the Projects Overview chart shows all clients who have closed projects in the selected period, ordered by total invoiced revenue descending; each row displays a gold/silver/bronze rank badge for the top three, a relative progress bar scaled to the highest-revenue client, the client name (linked to the client detail page), total revenue, project count, and average project value; the list is scrollable when there are many clients
- **Period selector on all four charts** � each chart carries an independent dropdown offering Financial Year to Date (default), Last Financial Year, Year to Date, and Last 12 Months; all periods respect the `fiscalYearStartMonth` configured in Sales Settings

### Changed
- **QuickBooks Actions card layout redesigned** � the card header is removed and replaced with an inline title; on desktop the title and all four buttons sit on a single centred row; on mobile the title is centred above a 2 � 2 button grid (Pull Clients / Pull Quotes on the first row, Pull Invoices / Pull Payments on the second); each button now carries a matching icon � `Building2` for Pull Clients, `FileText` for Pull Quotes, `Receipt` for Pull Invoices, and `DollarSign` for Pull Payments, consistent with the icons used in the stat-card strip at the top of the dashboard

## [1.2.8] - 2026-03-30

### Added
- **Admin and internal users can now upload attachments when leaving comments on the Share Page** � previously only possible by Clients / project recipients.
- **`projectExternalCommunication` RBAC permission** � a new granular permission "External Communication" is added to the Projects permission group on the Users page; it controls access to email upload, email list/delete, and email attachment download routes; enabling Full Control automatically grants it, and disabling it (or Photo & Video Uploads) clears Full Control to avoid a misleading partial state
- **Comment Attachments section on the Project page** � when a project has one or more comment attachment files a dedicated "Comment Attachments" read-only list appears in the project files area, visible to users with the `accessSharePage` permission; the list refreshes automatically when uploads or file changes occur
- **Email Attachments section on the Project page** � when a project has non-inline email attachments a dedicated "Email Attachments" read-only list appears, visible to users with the new `projectExternalCommunication` permission; it refreshes in sync with email and storage changes
- **`commentAttachmentsCount` and `emailAttachmentsCount` in project API** � the project GET endpoint now fetches both counts in parallel via `Promise.all` alongside the main project query, and includes them in the serialised response; counts are zeroed for callers that lack the corresponding permission
- **Unsaved comment guard on Admin Share Page** � switching away from a video while a comment draft or attachment is in flight now shows a native confirmation prompt ("You have an unsent comment. Are you sure you want to leave?"); confirming automatically resets the draft; the guard is hooked into both the video selector and the album selector
- **Unsaved comment guard on Internal Comments** � `ProjectInternalComments` now registers `useUnsavedChanges` so navigating away while a draft is typed triggers a browser confirmation; the draft is discarded if the user confirms

### Changed
- **External communication routes gated by dedicated permission** � the email list, email detail, email attachment download, and email delete/post endpoints previously required `accessProjectSettings` or `projectsFullControl`; they now require the new `projectExternalCommunication` permission, making it possible to grant email access without granting full project control or settings access
- **Email attachments removed from the internal project files list** � `ProjectFileList` no longer requests `includeEmailAttachments=1`; email attachments are presented via the dedicated "Email Attachments" section added above; the corresponding query-param branch is removed from the files API route; the "Email Attachment" source-type label that previously appeared inline in the file list is also removed
- **Storage breakdown splits External Communication into its own row** � `communicationsBytes` (raw email bodies + email attachments) is now exposed as a separate field from `projectFilesBytes` in both the per-project storage API and the global Storage Overview API; `ProjectStorageUsage` and `StorageOverviewSection` each show a new "External Communication" row; empty rows are filtered out automatically so the breakdown stays uncluttered
- **Project Storage Usage card hides itself when there is nothing to show** � `ProjectStorageUsage` returns `null` when the project reports zero tracked bytes, preventing an empty card from appearing on projects that have no files yet
- **`externalCommunication` section on Project page gated by new permission** � the section was previously rendered for any user with Full Control (`canDeleteInternalFiles`); it now checks `canAccessExternalCommunication` so operators who manage emails but do not have full control can still see the section, and users without the permission no longer see it regardless of their other grants
- **Project page refreshes project data after file and email changes** � upload-complete and file-changed callbacks throughout the project page now call `void fetchProject()` in addition to bumping the storage refresh counter, so `commentAttachmentsCount` and `emailAttachmentsCount` update live without a page reload
- **Project Settings upload allocation label renamed** � "Max allowed data allocation for client uploads" is renamed to "Max allowed data allocation for comment attachments" in both the primary and default-settings dialogs to accurately reflect that the quota applies to comment file uploads, not all client uploads
- **`useUnsavedChanges` hook extended with message and discard options** � the hook now accepts an optional second argument `{ message?, onDiscard? }`; `message` overrides the default "You have unsaved changes" browser prompt text; `onDiscard` is called automatically when the user confirms leaving (browser unload and programmatic `confirmNavigation()` paths both trigger it); a same-document navigation guard prevents false positives when hash or query-string changes occur within the same page; the hook also exposes `confirmNavigation()` to consumers that need to intercept programmatic navigation
- **`useCommentManagement` adds `hasUnsentComment` and `resetDraft()`** � `hasUnsentComment` is `true` when the comment text or any attachment is pending; `resetDraft()` clears the text, timestamp, reply target, attachments, and upload progress in one call; both are returned from the hook; existing call sites in the submit and delete-all paths are updated to use `resetDraft()`; the hook also resets the reply state when the selected video changes; admin comment fetches now pass `cache: 'no-store'` to prevent stale data
- **`CommentSection` gains an `allowCommentFileUpload` prop** � the new prop decouples the file-attachment capability from the `allowClientUploadFiles` flag so the admin share page can allow admins to attach files to their comments independently of whether clients can upload; it defaults to `allowClientUploadFiles || isAdminView` to preserve existing behaviour
- **CPU utilization summary styling unified for high and full allocation** � `highAllocation` and `fullUtilization` states both now render the warning colour and border style; the orange-coloured variant for `highAllocation` is removed in favour of the consistent warning token used for `fullUtilization`
- **"View Share Page" action button uses primary button styling and repositioned** � the button in the `ProjectActions` panel is now `variant="default"` (filled primary colour) instead of `variant="outline"`, making it visually distinct from secondary action buttons; the button is also moved to appear immediately above the Delete Project button so destructive and primary actions are grouped at the bottom of the panel
- **CI actions pinned and upgraded for Node 24 compatibility** � `actions/checkout` pinned to v4.2.2 and `actions/setup-node` to v4.4.0; Node.js version in the CI workflow updated to 24

## [1.2.7] - 2026-03-29

### Added
- **`useUnsavedChanges` hook** � new `src/hooks/useUnsavedChanges.ts` registers a `beforeunload` guard when a form has unsaved changes and exports a `confirmNavigation()` helper for programmatic navigation (e.g. router.push); integrated into Global Settings, Project Settings, Client detail, User edit, Invoice detail, Quote detail, and Sales Settings pages so users are warned before losing work
- **QuickBooks Actions card on Sales Dashboard** � when QuickBooks is configured a new card appears alongside the stats summary with Pull Clients, Pull Quotes, Pull Invoices, and Pull Payments buttons; each button posts to the corresponding pull endpoint with a 7-day lookback, displays a timed success or error banner, and refreshes the rollup totals; buttons are disabled while a pull is in progress
- **Sales sub-navigation in admin header** � the Sales entry in the main nav now expands into a sub-menu listing Dashboard, Quotes, Invoices, Payments, and Settings; on desktop the sub-menu opens as a hover-activated fly-out with individual icons; on mobile the hamburger menu gains an expandable inline sub-list with the same entries and a chevron toggle

### Changed
- **Sales Settings redesigned as a sidebar-nav layout on desktop** � matching the pattern introduced in v1.2.6 for Global Settings and Project Settings, a persistent left sidebar on screens =1024 px lists five sections (Sales Details, Tax, Sales Notifications, Stripe Checkout, QuickBooks Integration) with matching icons; the per-section Save buttons are removed and replaced with a single unified "Save Changes" button at the top of the page that persists all sections concurrently via `Promise.all`; the stacked card layout is retained on mobile
- **Client detail page tracks unsaved changes and shows inline success banner** � form data and recipient list are snapshot on load; a dirty-state comparison drives `useUnsavedChanges`; on successful save a green "Changes saved successfully!" banner appears for 3 seconds; navigating away while the form is dirty triggers a browser confirmation prompt
- **User edit page stays on page after save and warns on dirty navigation** � previously a successful save redirected to `/admin/users`; the page now shows an inline success banner and keeps the user in the edit form; the Cancel button calls `confirmNavigation()` before routing so unsaved changes are not silently discarded
- **Role dialog on Users page warns before closing with unsaved changes** � the role editor dialog intercepts all close paths (overlay click, Escape key, Cancel button) and shows a native confirm prompt when role name or permissions have been modified since the dialog was opened
- **Invoice and quote detail pages replace `alert('Saved')` with success banners** � the blocking `alert` call on both pages is replaced by a timed green "Changes saved successfully!" banner; `useUnsavedChanges` is also wired up using a JSON snapshot of all editable fields so these pages now guard against accidental navigation
- **Sales Dashboard tables use `whitespace-nowrap` on key columns** � quote number, issue date, status, and total columns (and the corresponding invoice columns) no longer wrap on narrow screens; client name columns retain a `min-w-[120px]` constraint
- **Success message copy standardised to "Changes saved successfully!"** � the previous "Settings saved successfully!" label is replaced on Global Settings, Project Settings, Client detail, User edit, Invoice, Quote, and Sales Settings pages

### Fixed
- **Security Events "Blocked" count now reflects all matching events, not just the current page** � the API runs a second scoped `count` query for `wasBlocked: true` under the same active filters and returns it as `blockedTotal`; the stats card displays that server-side total instead of counting only the rows visible on screen; a fourth stat card "Rate Limits" is added to the overview grid (layout changed from 3 to 4 columns)
- **Accent color rendered at the exact lightness the user chose** � `buildAccentOverrideCss` previously forced the CSS `--primary` variable to 50 % lightness in light mode and 60 % in dark mode regardless of the stored hex value; it now reads the actual `l` component of the stored color and applies it unchanged in both themes, so dark, muted, or very light brand colors are rendered faithfully instead of being silently brightened or dimmed
- **ProjectStatusPicker dialog no longer triggers parent-row navigation** � click events originating inside the status-change dialog (overlay background clicks, empty-area clicks within the modal content) were bubbling through the React tree to the surrounding clickable table row and triggering a page navigation; the Dialog is now wrapped in a `<span onClick={stopPropagation}>` portal boundary that absorbs those events before they reach the row handler

## [1.2.6] - 2026-03-28

### Changed
- **Global Settings redesigned as a sidebar-nav layout on desktop** � on screens =1024 px the former stack of collapsible accordion cards is replaced by a persistent left sidebar listing all twelve setting sections (Company Branding, Domain Configuration, Email & SMTP, CPU Configuration, Storage Overview, Dropbox Storage, Default Project Settings, Project Behavior, Developer Tools, Gotify Notifications, Browser Push, Advanced Security), each with a matching icon; clicking a section swaps the right-hand content panel without re-mounting state; the collapsible accordion view is retained unchanged on mobile; all section components gain a `hideCollapse` prop that suppresses the chevron toggle and keeps the card permanently expanded when rendered in the desktop panel
- **Project Settings redesigned as a sidebar-nav layout on desktop** � the same two-column pattern is applied to individual project settings pages; sections are dynamically filtered (Video Processing, Revision Tracking, and Feedback & Client Uploads are hidden when the project has videos disabled) and the desktop sidebar resets to "Project Details" automatically when the active section becomes unavailable; mobile users continue to see the collapsible card layout
- **Design language refreshed across light and dark themes** � card backgrounds in light mode are now pure white against a cooler blue-tinted page background, creating stronger visual lift; dark mode backgrounds gain a consistent blue tint throughout (background, cards, popovers, borders, accents, muted surfaces); corner radii are increased (base `0.875 rem`, large `1.25 rem`); shadows are softer and more layered; status-badge colours are updated to lighter tinted backgrounds with dark text in light mode for all project statuses (REVIEWED, APPROVED, SHARE_ONLY, IN_REVIEW, IN_PROGRESS), removing the high-contrast inverted badges that were hard to read at small sizes; borders on all badges are removed for a cleaner look
- **Inter typeface loaded via next/font** � `Inter` is now loaded through Next.js font optimisation (`next/font/google`) and applied via the `--font-sans` CSS variable on the `<html>` element; this eliminates the previous flash of system font and ensures consistent typography across environments
- **UI primitives updated for the new design language** � `Button` gains an `active:scale-[0.98]` micro-interaction on press; `Card` border radius increased to `rounded-xl` with a lighter shadow (`shadow-elevation-sm`) and a slightly more visible border; `Dialog` overlay darkens to `bg-black/50` with `backdrop-blur-sm` and the content panel gains `rounded-xl` corners and `shadow-elevation-xl`; `Input`, `Select`, and `Textarea` gain softened placeholder opacity (`/70`), consistent `transition-all`, and a focus-ring that also highlights the border; `Select` content uses an `xl` radius and the elevated shadow token
- **Projects dashboard table given more breathing room** � cell padding increased from `px-3 py-2` to `px-4 py-3`; header cells use `font-semibold`; table container gains `rounded-xl`, a subtle drop shadow, and a lighter border; row hover colour switches to `bg-accent/40` for better contrast with the new white-card background
- **Key Dates calendar preloads adjacent months** � when the user navigates to a month the calendar now silently fetches the previous and next months in parallel so forward/back navigation is instant; trailing and leading cells from neighbouring months are filled with real dates (styled in a dimmed inactive colour) rather than blank placeholders, giving the grid a full 6-row � 7-column structure at all times; today's date number is bolded and coloured with the accent colour; the calendar dependency array is corrected to include `monthCursor`
- **Invoices and quotes tables are click-through rows** � each row on the Invoices and Quotes list pages is now an interactive row that navigates to the detail page on click, matching the behaviour of the projects table; individual cells that contain their own interactive links stop click propagation so those elements remain independently clickable
- **Project Analytics activity page size increased** � the activity log now shows 50 entries per page (previously 20), reducing the need to paginate through recent events
- **Dependency updates** � `nodemailer` updated to 8.0.4; `mailparser` updated to 3.9.6; security overrides added for `brace-expansion` (5.0.5), `flatted` (3.4.2), `picomatch` (2.3.2 / 4.0.4 for tinyglobby), `srvx` (0.11.13), and `yaml` (2.8.3) to resolve moderate advisory flags

### Security
- **Proactive JWT refresh eliminates 401 races across browser tabs** � `SessionMonitor` now decodes the `exp` claim from the in-memory access token (without verifying the signature, which is server-only) and schedules a silent refresh 5 minutes before expiry; this means tokens are renewed while they are still valid, preventing the race where multiple tabs all detect the same expired token simultaneously and each attempt a refresh; the timer reschedules itself whenever the token store is updated (e.g. after a successful refresh in another tab)
- **Token-store events no longer broadcast cross-tab logouts after local inactivity expiry** � `apiFetch` and `attemptRefresh` now check `isCurrentWindowSessionTimedOut()` before calling `handleSessionExpired()` or `clearTokens()`; a tab whose inactivity timer has fired will silently skip the global token-clear path, preventing it from wiping the refresh token for all other open browser windows that are still active; the fix complements the single-tab session timeout introduced in v1.2.4 by also closing the gap in the token-refresh error path

## [1.2.5] - 2026-03-25

### Changed
- **Branding settings cached in-process** � a new `getBrandingSettingsSnapshot()` helper in `src/lib/settings.ts` reads branding fields once and caches them for the standard settings TTL; `layout.tsx` previously issued two separate `prisma.settings.findUnique()` calls per page render (one for metadata, one for accent/theme), both of which are now served from the shared cache; `getCompanyName()` also reuses the same snapshot; the cache is invalidated when the company logo, dark logo, or favicon is uploaded
- **Admin landing page parallelizes session and settings fetches** � the `pickLandingPage` effect previously awaited the session check before fetching settings; both requests are now issued concurrently with `Promise.all`, reducing the delay before the redirect to the first permitted menu
- **Settings API GET fetches settings and security settings in parallel** � previously the two records were fetched sequentially; they are now fetched together with `Promise.all` in a single round-trip
- **Comment notification helpers batch database reads** � `resolveCommentAuthor` previously issued sequential awaits for primary recipient, project, and recipient lookups; `handleCommentNotifications` did the same for project, video, and settings; all reads within each function are now batched with `Promise.all`
- **Video streaming session rate limit skips range requests** � byte-range requests (video seeking and scrubbing) are normal browser behaviour already covered by IP rate limiting and hotlink detection; only initial load requests (non-range) are counted against the per-session budget, preventing legitimate scrubbing activity from triggering a 429

### Fixed
- **Running Jobs panel separates failed and completed entries into distinct sections** � the panel previously grouped all finished activity under a single "Recent" label; failed uploads and failed server-side jobs (processing errors, Dropbox upload failures) now appear together under a red-labelled "Failed" section, while successful uploads and successful server jobs appear under the "Completed" section; this makes it immediately obvious when something went wrong without having to scan a mixed list
- **Running Jobs completed and failed entries sorted newest-first by finish time** � uploads now record a `completedAt` timestamp when they succeed or error, and both the completed and failed lists are ordered by that timestamp (falling back to `createdAt`); server-side completed jobs follow the same ordering so the most recent activity always appears at the top of each section
- **Running Jobs server job keys no longer collide across job types** � `CompletedServerJobRow` keys used bare numeric IDs (`done-{id}`), which could collide when a Dropbox job and a processing job happened to share the same database ID; keys now include the job type (`done-{type}-{id}` and `failed-{type}-{id}`), eliminating React reconciliation errors caused by duplicate keys
- **Deleting security events now invalidates the Redis recent-events cache** � bulk-deleting events from the security dashboard left the `security:events:recent` Redis list intact; the delete endpoint now removes that key after the database purge so the panel immediately reflects the cleared state instead of serving stale cached entries
- **Deleting a project now cascades to its security events** � the `SecurityEvent` ? `Project` relation was `onDelete: SetNull`, which left orphaned event rows when a project was deleted; changed to `onDelete: Cascade` so security events are removed along with the project
- **Dropbox cloud icon in Project Analytics no longer clips long description text** � the cloud icon was rendered as a sibling element wrapping `TruncatedText`, breaking the truncation width measurement; the icon is now passed as a `suffix` prop so it renders inside the measured span and the text tooltip fires correctly on truncated entries; fixed in both the table row and the expanded detail view

## [1.2.4] - 2026-03-20

### Added
- **Running Jobs correctly surfaces upload and processing errors** � Dropbox upload failures (video originals, video assets, and album ZIP variants) and video processing failures are now reported as distinct error entries in the Running Jobs panel; each failed job shows a red `XCircle` icon and a descriptive "�failed" label instead of the previous green "�complete" badge; errored jobs are returned directly from the API so they appear immediately rather than relying on disappearance detection
- **Failed jobs in Running Jobs require manual dismissal** � completed jobs that finished with an error are never auto-purged from the Running Jobs panel; they persist until the user explicitly dismisses them, ensuring failures are not silently swept away by the 30-minute cleanup timer that still applies to successful completions
- **"UPLOAD FAILED" badge on video cards** � when any version in a video group has a Dropbox upload error (`dropboxUploadStatus: ERROR`), the collapsed video card header now shows a red "UPLOAD FAILED" badge (with `XCircle` icon) alongside the existing FAILED / PROCESSING / QUEUED badges
- **Error badges on album cards** � the album card header now shows a red "FAILED" badge when the album itself is in `ERROR` status, and a red "UPLOAD FAILED" badge (with `XCircle` icon) when a Dropbox ZIP upload has failed; the Dropbox cloud icon on the album also switches to a red `XCircle` with destructive styling and an "Dropbox upload failed" tooltip when `fullZipDropboxStatus` or `socialZipDropboxStatus` is `ERROR`
- **Running Jobs panel now shows recently completed processing jobs** � video versions that reached `READY` status within the past 30 minutes are now included in the Running Jobs API response and displayed in the panel alongside Dropbox upload completions, giving a unified view of recent activity without requiring a page reload
- **Dropbox cloud icon on Project Analytics download entries** � download-related entries in Project Analytics (Video Download, Asset Download, ZIP Download, Album Download) now show a small cloud icon (?) next to the description when the file was served from Dropbox; album ZIP analytics now record the download source in a new `details` column on `AlbumAnalytics` so the indicator is accurate for both video and album downloads

### Fixed
- **Video processing failures no longer appear as silent completions** � previously, when a video encoding job failed the video would disappear from Running Jobs with no trace, or be detected by the client's disappearance logic and incorrectly shown as "Processing complete"; the `/api/running-jobs` endpoint now queries videos with `status: ERROR` (within the past 30 minutes) and returns them as errored processing entries with `error: true`
- **Running Jobs dismiss buttons now use type-scoped keys** � dismissing a completed or errored job entry now keys on `{type}:{id}` rather than `{id}` alone, preventing a dismissed job from accidentally suppressing a different job type that happened to share the same database ID
- **Dismissing a pinned system notification no longer returns "Notification not found"** � the delete endpoint was filtering candidates by a hardcoded type allow-list before accepting the delete, so any row whose type was valid but not in that exact list returned a 404 and the item reappeared on the next refresh; the endpoint now looks up the record by its ID and validates clearability from `details.__controls` � the same logic used when rendering the dismiss button
- **Session timeout in one tab no longer logs out other open browser tabs** � the inactivity timer now calls `expireCurrentWindowSession()`, which sets a per-window `sessionStorage` flag and clears tokens only for that tab; other tabs retain their in-memory and persisted tokens and continue working; a fresh login in any tab clears the flag so normal navigation resumes

## [1.2.3] - 2026-03-15

### Added
- **Storage Overview section in Admin Settings** � a new "Storage Overview" panel in Admin Settings shows a live breakdown of disk usage across all content types (original videos, video previews, video assets, comment attachments, original photos, photo ZIPs, project files, client files, and user files); when the storage root is on a local filesystem the panel also reports total capacity and available free space; the data is fetched from a new `/api/settings/storage-overview` endpoint and refreshes on demand
- **Auto-delete previews toggle relocated to Storage Overview** � the "Auto-delete video previews and timeline sprites when project is closed" toggle has been moved from the Project Behavior section into the new Storage Overview panel where it sits alongside the breakdown chart for clearer context
- **Recalculate storage totals relocated to Storage Overview** � the "Recalculate totals" action (previously in Developer Tools) is now surfaced inside the Storage Overview panel

### Changed
- **"Original Photos" storage row now counts full-resolution files only** � social-sized photo derivatives are no longer included in the "Original Photos" total; they are now counted under "Photo ZIP files & previews" in both the Project Data panel on project pages and the Storage Overview section in Admin Settings
- **"Video Previews" label simplified** � "Video Previews (inc. timeline previews)" has been shortened to "Video Previews" in both the Project Data panel and the Storage Overview section
- **Storage Overview section header no longer shows an icon** � the hard-drive icon next to the "Storage Overview" card title has been removed for consistency with other settings sections
- **Dropbox token refresh deduplicated** � concurrent calls to `fetchDropboxAccessToken` now share a single in-flight refresh promise; previously rapid parallel requests could trigger multiple simultaneous token refreshes against the Dropbox OAuth endpoint
- **Dropbox API calls retry on transient network errors** � all Dropbox HTTP requests now retry up to 2 times (1 s delay) on fetch-level errors such as `ECONNRESET`, `ETIMEDOUT`, and `fetch failed`; non-retryable errors and HTTP-level failures are surfaced immediately without retrying
- **Notification backlog purge tool shows stale vs. recent breakdown and larger sample** � the dry-run response now separately counts stale (>7 days old) and recent pending entries, returns up to 50 stale sample rows (up from 20) with a truncation flag, and serialises dates as ISO strings for consistent display
- **Worker notification log labels are more specific** � `project-key-date-reminders` and `user-key-date-reminders` jobs now log as "Project Key Date reminders check" and "User Key Date reminders check" respectively (previously both were "Key Date check"); the label logic is extracted into a shared `getNotificationWorkerJobLabel` helper used by both the `completed` and `failed` handlers
- **Worker Dropbox consistency scan logs the full error object** � the error logged when a Dropbox storage consistency scan fails is now the raw caught value rather than `e.message`, preserving stack traces and non-Error objects
- **Deleting an email prunes empty storage directories** � the email DELETE endpoint now removes the raw-email directory and each attachment directory after file deletion, then prunes any empty parent directories up to the project root; Dropbox-prefixed paths are stripped to a local path before pruning so the cleanup works regardless of storage provider

### Removed
- **Migrate project storage tool removed from Developer Tools** � the one-time `migrate-project-storage-yearmonth` API route and its associated UI panel have been removed; the storage migration was completed in v1.2.0 and the tool is no longer needed
- **Regenerate missing thumbnails tool removed from Developer Tools** � the `regenerate-missing-thumbnails` API route and its Developer Tools panel have been removed from the settings UI; thumbnail repair remains available via the worker

## [1.2.2] - 2026-03-14

### Added
- **System Alert notifications** - Added daily scans that check and report on app related issues, such as Dropbox vs local server inconsistencies, daily Quickbooks pull fails; a pinned notification advises users of issues and any affected videos or albums show an alert icon to highlight there is an issue
- **Social media copies toggle on album creation** � albums now have a "Create social media sized copies" checkbox (enabled by default) that controls whether social-sized photo derivatives (long edge scaled to 2048px) and the Social Media Sized ZIP are generated; when disabled, social derivative jobs are skipped, the social ZIP download button is hidden on share pages, and the admin status display reflects that social copies are disabled
- **Dropbox upload toggle on album creation** � albums now have an "Upload to Dropbox" checkbox that controls whether album ZIPs are uploaded to Dropbox; previously Dropbox upload was automatic when configured � this gives users explicit control; when disabled, ZIPs remain on the local server only
- **Social copies toggle on existing albums** � a Layers icon button next to the Dropbox cloud button lets admins enable or disable social-media-sized copies after album creation; enabling queues social derivative generation for all existing READY photos and a social ZIP build; disabling deletes all social derivative files, the social ZIP, and any Dropbox social ZIP copy, and frees the associated storage

### Removed
- **Orphan Comments cleanup developer tool** � removed; the historical missing-video comment bug was fixed in an earlier release and the cleanup tool is no longer required

### Changed
- **Video deletion prunes empty storage folders** � after a version is deleted, the empty version-label folder is removed and, when it was the last remaining version, the now-empty parent video folder is also removed; pruning stops at the project's `videos/` root
- **Deleting a Dropbox-backed video also removes the local server copy** � the storage delete path cleans up both the Dropbox object and the mirrored local file from `STORAGE_ROOT`
- **Dropbox folder cleanup scope limited to the project root** � ordinary file and version deletes no longer prune through `projects/` or the client folder; deleting a project still removes the full project root explicitly while client-root folders are left untouched even when otherwise empty
- **Deleting a client removes the client storage root when safe** � the client delete route removes the full client folder on both local and Dropbox when no projects remain; if projects still exist, the delete is blocked to avoid orphaning project records while removing their files
- **Orphaned files cleanup scans managed storage beyond project roots** � the orphan-file scanner walks the full managed storage root and cross-checks project media, imported emails, comment and project uploads, client files, user files, and stored branding assets while still ignoring temporary upload chunks and redirect metadata
- **Notification backlog tool includes diagnostic sample rows and system-local dates** � the backlog dry run includes a sample of pending queue entries with type, project, pending targets, retry counts, failure flags, and payload; `Oldest entry` uses the shared timezone-aware formatter
- **Delete previews for closed projects tool includes timeline VTT files** � the closed-project preview cleanup detects and removes `timelinePreviewVttPath` files alongside preview MP4s and timeline sprite directories

## [1.2.1] - 2026-03-13

### Added
- **Last Access column on projects dashboard** � the projects table now has a "Last Access" column showing when a client or guest last accessed the share page; the timestamp is written via a raw SQL update so `updatedAt` (Last Activity) is not bumped; falls back to the most recent `SharePageAccess` ACCESS event so projects with visits before this feature was added still show a meaningful value

### Changed
- **Dropbox section description updated to accurately reflect scope** � the Dropbox configuration card in Admin Settings now states that video originals, assets, and album ZIPs can all be offloaded to Dropbox, replacing the previous description that only mentioned approvable video originals

### Fixed
- **Admin IPs excluded from Last Access tracking** � visiting a share page from an admin IP no longer advances the Last Access timestamp when "Exclude internal/admin IPs from analytics" is enabled
- **Enabling Dropbox on a video now also queues existing assets for upload** � toggling Dropbox on a video version now marks all attached assets as `dropboxEnabled` and queues them for Dropbox upload in the same operation; previously only the video original was uploaded and assets were left behind
- **Running Jobs panel now shows recently completed Dropbox uploads** � Dropbox upload completions from the past 30 minutes (for both video originals and assets) are included in the running-jobs API response and surfaced in the Running Jobs panel
- **Asset panel refreshes immediately after Dropbox toggle** � toggling Dropbox on a video version now triggers an asset list refresh so asset Dropbox statuses update without a manual page reload

## [1.2.0] - 2026-03-12

### Added
- **Per-item Dropbox upload toggle for video versions** � Eeach video version has an explicit on/off control; on the Add Video/s popup, a "Store original in Dropbox" checkbox is shown and is only enabled when approval is turned on (since Dropbox is only used for approved download delivery); toggling on queues a background Dropbox upload job; toggling off confirms with a prompt then deletes the file from Dropbox and reverts the storage reference to the local copy; uploaded assets automatically inherit the parent video's Dropbox setting
- **Automatic Dropbox upload for video assets** � when a video version has Dropbox enabled, any new assets uploaded to that version are automatically queued for Dropbox upload; assets follow the parent video: disabling Dropbox on the video cascades to all its assets, and deleting the video or project deletes asset Dropbox copies as well
- **Automatic Dropbox upload for album ZIPs** � newly created albums automatically enable Dropbox when Dropbox storage is configured; both Full and Social ZIP files are uploaded to Dropbox as soon as ZIP generation completes; when photos are added or removed, old Dropbox ZIP copies are deleted and new uploads are queued after ZIP regeneration
- **Delete previews for closed projects tool in Developer Tools** � a new "Delete previews for closed projects" section in Admin Settings ? Developer Tools scans all CLOSED projects that still have preview files (480p, 720p, 1080p), or timeline sprite directories on disk; a dry-run reports how many closed projects, videos, and files would be affected; a "Delete previews" button commits the deletion and clears the corresponding database fields so previews regenerate automatically if the project is ever re-opened
- **Configurable upload and download chunk sizes** � new settings in Developer Tools allow admins to tune TUS upload chunk size (8�512 MB, default 200 MB) and server download chunk size (1�64 MB, default 16 MB); all upload forms (videos, assets, photos, emails, project files, user files) fetch the configured upload chunk size from a lightweight metadata endpoint and adapt automatically; download chunk size controls how much data is read per iteration when streaming files to clients
- **Exclude internal IPs from analytics toggle** � new Developer Tools setting to suppress analytics recording (share page access, video events, album events) for IP addresses that match recent admin login history; enabled by default
- **Expanded security event logging** � 13 new security event types covering admin session lifecycle (logout, token refresh failure), account management (user create, delete, deactivate, reactivate, role change, password change), security configuration changes, blocklist IP/domain modifications, and permission-denied access attempts; all events include IP address, acting user, and resource details
- **Regenerate missing video thumbnails tool in Developer Tools** � a new "Regenerate missing video thumbnails" section in Admin Settings ? Developer Tools scans all READY and ERROR videos for missing or null system thumbnails; a dry-run reports affected counts and a sample list; a "Queue repairs" button queues thumbnail-only regeneration jobs for those videos without touching their previews or timeline sprites; custom asset-based thumbnails and closed project videos are excluded

### Changed
- **File storage reorganized into human-readable client/project paths** � all project files (video originals, previews, timeline sprites, thumbnails, video assets, album photos, and album ZIPs) are now stored under a named folder hierarchy: `clients/{clientName}/projects/{projectTitle}/`, with video versions nested at `videos/{videoName}/{versionLabel}/` and albums at `albums/{albumName}/`; this replaces the previous date-partitioned, ID-based layout (`projects/YYYY-MM/{id}/`); new uploads always land in the canonical location, and existing projects can be migrated to the new layout with the "Migrate project storage" tool in Admin Settings ? Developer Tools
- **Album ZIP filenames include the album name** � ZIP files served to clients are now named after the album (e.g. `Wedding_Day_Full_Res.zip`, `Wedding_Day_Social_Sized.zip`) instead of the generic `photos_full.zip` / `photos_social.zip`
- **Project approval no longer requires per-video approval** � the APPROVED status can now be set on a project regardless of whether individual video versions have been approved; the `canApprove` guard and the "Approve one version of each video first" hint in the status picker are removed
- **Multi-video upload modal auto-closes after completion** � after all videos are successfully queued, the modal displays a 3-second countdown with a smooth animation before auto-closing; a new Dropbox toggle checkbox is available per video item when Dropbox is configured
- **Video player download button disabled during Dropbox upload** � the download button for Dropbox downloads on share pages shows "Uploading�" while the video original is still being uploaded to Dropbox, preventing premature download attempts that would fail

### Fixed
- **Storage normalization migration hardened** � the "Migrate project storage to client/project layout" Developer Tools action now: places asset files inside per-version `assets/` subdirectories (previously they were incorrectly placed in the video root); strips legacy upload-timestamp prefixes (`asset-*`, `photo-*`, `photos-*`) from asset and album photo filenames; correctly preserves custom asset-based thumbnails while still moving system-generated `thumbnail.jpg` files to the canonical location; prunes empty legacy storage folders after migration; resolves existing folder roots from actual preview/timeline paths rather than guessing from the DB path alone; detects Dropbox-backed files from actual `dropbox:` storage-path prefixes rather than metadata flags, eliminating false-positive migration reports on canonical local projects
- **Album photo social derivative files moved during migration** � the migration now locates and moves the `<photo>-social.jpg` derivative alongside its parent photo, preventing stale social paths from causing album ZIP worker failures
- **Album ZIP worker no longer crashes on missing social derivative files** � if a social-scaled file is absent when building the social ZIP, the entry is skipped with a debug log rather than throwing an uncaught stream error that previously killed the worker process
- **Video worker resolves stale original file paths before processing** � when a queued job's `originalStoragePath` no longer matches the actual on-disk location (e.g. after storage normalization), the worker now searches canonical and legacy candidate paths before failing; the same resolution logic is shared by the thumbnail repair tool and the Dropbox toggle flow via a new `src/lib/resolve-video-original.ts` helper, eliminating the previous triple duplication

## [1.1.9] - 2026-03-10

### Added
- **Multi-resolution video previews (480p, 720p, 1080p)** � Projects and global settings can now select one or more preview resolutions simultaneously using checkboxes (480p, 720p, 1080p); the worker processes all selected resolutions in a single job, storing them in separate database fields (`preview480Path`, `preview720Path`, `preview1080Path`); adding a resolution from Project Settings queues preview-only regeneration jobs for all READY videos without touching the thumbnail or timeline previews; removing a resolution deletes the corresponding preview files immediately; backed by a new database migration that converts the single `previewResolution` field to a JSON-array `previewResolutions` field on both `Project` and `Settings`
- **Video player quality selector** � when a video has more than one preview stream available, a gear-icon quality button appears in the player controls on both desktop and mobile rows; choosing a specific quality (480p / 720p / 1080p) overrides Auto mode, which selects quality based on player container width (=1200 px ? 1080p, =640 px ? 720p, otherwise 480p) via a ResizeObserver and automatically downgrades when the video buffers for more than 700 ms; the button label shows the active resolution, e.g. `Auto (720p)`
- **Auto-delete video previews and timeline sprites on project close** � a new "Auto-delete video previews and timeline sprites when project is closed" toggle in Admin Settings ? Default Project Settings; when enabled, closing a project deletes all preview files and timeline sprite directories from storage and clears the corresponding database paths; re-opening the project automatically re-queues any READY videos with missing previews for regeneration
- **Pending job cancellation on project close** � closing a project (both manually and via the scheduled auto-close worker) now cancels all waiting, delayed, and prioritized BullMQ jobs for that project across the video-processing, album-photo-ZIP, and album-photo-social queues, preventing orphaned jobs from running after the project is shut down
- **Orphan project files cleanup tool in Developer Tools** � a new "Orphan project files cleanup" section in Admin Settings ? Developer Tools; a dry-run scan walks the entire project storage tree and cross-references every physical file against the full set of database-referenced paths (original videos, all preview resolutions, timeline sprites, thumbnails, video assets, album photos, album ZIPs, comment uploads, project files, and imported emails); the report shows orphan file count, total orphan bytes, sample paths and affected project IDs; a second "Delete orphans" button commits the deletion and prunes any empty directories left behind; backed by a new `POST /api/settings/cleanup-orphan-project-files` endpoint

### Changed
- **Storage breakdown now shows original vs. generated file sub-totals** � the Project Storage Usage panel now splits the "Videos" row into "Original Videos" and "Video Previews (inc. timeline previews)" and splits "Photos" into "Original Photos" and "Photo ZIP files" when the API returns the detailed per-file breakdown; the storage API now queries per-video and per-album storage paths individually to compute these sub-totals instead of relying on approximate aggregate sums
- **Reprocess endpoint supports targeted per-resolution and partial regeneration** � `POST /api/projects/[id]/reprocess` now accepts `previewResolutions` (an array of specific resolutions to regenerate), `regenerateThumbnail: false` (skip thumbnail regeneration and keep the existing one), and `regenerateTimelinePreviews: false` (skip timeline preview regeneration); targeted resolution jobs only delete and nullify the specific preview fields requested rather than wiping all three; the endpoint now rejects requests for CLOSED projects with HTTP 409
- **Closed projects fall back to original files when previews are absent** � the admin share page now fetches an original-quality token for CLOSED projects (not only approved videos), so all videos remain watchable via the admin share page even after previews have been auto-deleted on close; the original token is used as a fallback for all three stream-URL slots (480p / 720p / 1080p)
- **Watermark reprocess modal only fires on content-affecting changes** � a project title change alone no longer triggers the "reprocess existing previews?" modal unless the project uses the default auto-title watermark format (watermark enabled and no custom watermark text set); changing the title with a custom watermark text or with watermarks disabled now saves immediately without showing the modal
- **Running Jobs processing phase label extracted to shared utility** � `getProcessingPhaseLabel()` is now defined in `src/lib/video-processing-phase.ts` and shared by the worker and the Running Jobs component; the initial `processingPhase` value written when a video transitions to PROCESSING is now `null` (instead of `'transcode'`), so the phase display in the Running Jobs dropdown starts blank and is only set once the worker begins each stage
- **Storage write-path resolution always targets the canonical date-partitioned folder** � a new `validatePathForWrite()` function is used when writing files; it bypasses the legacy-path short-circuit that applied during reads (`resolveRedirectedProjectPath` now accepts a `forWrite` flag), ensuring all new writes land in the correct `projects/YYYY-MM/<projectId>` location even when an older file still exists at the legacy `projects/<projectId>` path

### Fixed
- **Video token endpoints return 404 when a requested quality has no generated preview** � both `/api/admin/video-token` and `/api/share/[token]/video-token` now verify that the corresponding preview path field (`preview480Path`, `preview720Path`, `preview1080Path`) exists in the database before issuing a content token; requests for a quality that was never generated or that was deleted after project close now receive an explicit 404 instead of a token that silently points to a missing file, preventing broken playback

### Dependencies
- `isomorphic-dompurify` upgraded from `^2.31.0` to `^3.1.0` (uses jsdom 28, eliminating the deprecated `whatwg-encoding` transitive dependency)
- `jsdom` override pinned to `28.1.0` (was `27.2.0`)
- `glob` override pinned to `13.0.6` (was `^11.1.0`, which was deprecated via `archiver-utils`)
- `eslint` pinned to `^9.39.4` to resolve `ajv < 6.14.0` audit advisory; `npm audit` now reports 0 vulnerabilities
- `bullmq` bumped from `^5.63.0` to `^5.70.4`
- `ioredis` bumped from `^5.8.2` to `^5.10.0`
- `mailparser` bumped from `^3.9.1` to `^3.9.4`
- `postcss` pinned to `^8.5.8`
- `dompurify` bumped from `^3.3.0` to `^3.3.2`
- `@simplewebauthn/server` bumped from `^13.2.2` to `^13.2.3`
- `@types/node` bumped to `^22.19.15`; `@types/nodemailer` bumped to `^7.0.11`

## [1.1.8] - 2026-03-09

### Added
- **Synthetic connection test endpoint for browser-to-server throughput checks** � the Video Information panel now runs its speed test against a dedicated authenticated byte stream at `GET /api/connection-test` instead of probing real video files, so the measurement reflects the browser�s path to the server without depending on preview/original file size alignment or media-specific range behavior.
- **Connection test progress bar in Video Information** � while the synthetic speed test is running, the dialog now shows a live progress bar using the app's existing progress component so users can see the 10-second sample is actively in flight.
- **CPU Configuration in Admin Settings** � a new "CPU Configuration" section above Default Project Settings lets admins configure FFmpeg threads per job, concurrent video processing jobs, and toggle dynamic thread allocation from the UI; defaults are established at startup based on detected hardware; settings are persisted in Redis and picked up by the worker within 60 seconds without a container restart (concurrency changes still require restart); the UI warns when the configured allocation would saturate all system threads.

### Changed
- **`TRUSTED_PROXIES` documentation** � README, INSTALLATION guide, and SECURITY guide now all document the `TRUSTED_PROXIES` environment variable and explain why it must be set for accurate rate limiting, IP blocklisting, and security event logging when the app is running behind a reverse proxy.
- **Download analytics now record actual outcomes instead of request starts** � download tracking now writes `DOWNLOAD_SUCCEEDED` and `DOWNLOAD_FAILED` events with transfer metadata in `VideoAnalytics.details`, the analytics UI shows success/failure status and average speed for completed downloads, and aggregate download counts only include successful downloads while still honoring legacy `DOWNLOAD_COMPLETE` rows. Previously downloads were counted from the initialization of a download, which produced inaccurate analytics in situations where downloads failed or were cancelled.
- **HTTPS mode now uses a single source of truth** � transport headers were already decided at startup from `HTTPS_ENABLED`, but passkey/WebAuthn validation had been reading the database-backed `httpsEnabled` setting, which allowed the admin UI to temporarily put the app into a mixed state until the next restart overwrote the DB value again; HTTPS mode is now read directly from `HTTPS_ENABLED` for both startup headers and runtime checks, the settings API no longer writes the `httpsEnabled` column, and Advanced Security Settings now shows a read-only HTTPS status indicator instead of an editable toggle; the GET security settings endpoint still returns the current `httpsEnabled` state for display purposes, and existing database values are ignored.
- **Running Jobs thread allocation uses the configured thread pool** � the `GET /api/running-jobs` endpoint now calls `loadCpuConfigOverrides` on each request so thread counts shown in the Running Jobs dialog always reflect the current Redis-backed CPU settings; dynamic scaling is capped by `alloc.maxThreadsUsedEstimate` rather than a hardcoded constant, so the displayed per-job allocation matches what the worker is actually using.
- **Connection speed test now runs for a fixed 10-second window** � rather than measuring a single 32 MB range request to completion, the test streams as much data as possible within 10 seconds by sending successive range requests and wrapping back to the start when the file is exhausted; the result panel now shows total bytes transferred and elapsed seconds alongside the speed figure.

### Fixed
- **Project-page video downloads now keep the original uploaded filename** � admin downloads triggered from the video filename on the project page now use `video.originalFileName` in the `Content-Disposition` header instead of falling back to a project-title-based filename for unapproved videos.
- **Advanced Security Settings now apply immediately after save** � saving security settings now invalidates both the in-memory settings cache and the shared Redis security-settings cache, so changes like rate limits, analytics/security logging toggles, and safeguard limits no longer wait for cache expiry before taking effect.
- **Upload cancellation no longer triggers false errors or queue stalls** � `UploadManagerProvider` now sets a `cancelled` flag on a job before aborting its TUS upload; subsequent `onProgress`, `onSuccess`, and `onError` callbacks check this flag and exit early, preventing stale TUS events from re-queueing the next upload or surfacing spurious error toasts.
- **Deleting a video now immediately cancels its in-progress upload** � when a video is deleted from the project page, `VideoList` dispatches a `video-deleted` custom event; `UploadManagerProvider` listens for it and aborts and removes any active upload for that video so orphaned uploads no longer continue running after the video record is gone.
- **Video processing jobs no longer crash when a video is deleted mid-process** � all worker `prisma.video.update` calls are routed through a new `updateVideoRecord` helper that detects Prisma `P2025` (record not found) errors; on a missing video, progress updates are silently skipped and the overall job exits cleanly rather than throwing an unhandled error and retrying.
- **Stale in-flight downloads are now marked failed on worker restart** � the worker runs a 60-second interval that calls `cleanupStaleTrackedDownloads` to flip any download records that were started but never completed (e.g. due to a container restart) to `DOWNLOAD_FAILED`, preventing them from permanently inflating in-progress counts.
- **TUS temp files are cleaned up when the target video record is missing** � the upload finish handler in `POST /api/uploads` now calls `cleanupTUSFile` when the video lookup returns nothing, so orphaned TUS files are not left on disk when a video is deleted before its upload completes.

## [1.1.7] - 2026-03-07

### Added
- **Connection speed test in Video Information panel** � a new "Speed Test" button appears in the comment panel header for any video with a playable stream; clicking it opens the Video Information dialog and immediately runs a two-phase test: a 64 KB ping to measure latency followed by a 32 MB byte-range download to measure throughput; results show average speed (Mbps), latency (ms), the actual bytes sampled, an estimated full-file download time, and a qualitative assessment of the connection; results are cached in `sessionStorage` per video for one hour so re-opening the panel restores the last reading without re-running; the test sources the best available URL in priority order � approved download token, 1080p preview stream, 720p preview stream � so it works on all video versions, not just approved ones
- **User active/inactive toggle** � admin users (excluding system admins) can now be suspended from the Users list and from the Edit User page; toggling to inactive immediately revokes all current tokens and signs the user out of every active session; re-enabling restores normal access on next login; system admin accounts cannot be disabled; backed by a new `active` boolean column on the `User` table (default `true`, indexed) with a matching database migration

### Changed
- **Approved video token fetching always prefers preview streams for playback** � when a video is approved, the share page and admin share page now always request separate 720p/1080p preview tokens alongside the original download token; the original-quality token is used only as the `downloadUrl` and as a playback fallback when preview streams are absent; the previous watermark branch that forced original-quality streams for both playback and download is removed, so watermarked approved videos now always play back from the lower-bandwidth preview
- **Share session rate limiting is now separate from admin session rate limiting** � `GET /api/content/[token]` now reads `shareSessionRateLimit` from security settings (default 300 req/min) for non-admin sessions instead of sharing the same `sessionRateLimit` counter used by admins; download chunk size reduced from 50 MB to 16 MB to keep per-chunk transfer times manageable on slow connections
- **Fullscreen comment input suppressed after approval** � once a project or video is approved, the floating fullscreen comment overlay on the video player is hidden and its toggle button is removed; backed by a new `disableFullscreenCommentsUI` prop on `VideoPlayer` passed down from both share and admin share pages when `commentsDisabled` is true

### Fixed
- **Passkey sign-in now returns full RBAC role and permissions** � `verifyPasskeyAuthentication` previously returned a stripped `AuthUser` with no `appRoleId`, `appRoleName`, or `permissions`, causing passkey-authenticated users to lose their role-based menu visibility and access controls until they re-authenticated via password; the credential query now fetches the full role object and the returned result includes all fields matching the password/OTP login path
- **Video worker now routes processed files through the storage abstraction** � `processTimelinePreviews`, `processPreview`, and `processThumbnail` previously constructed absolute paths directly from `STORAGE_ROOT`, bypassing the year-month redirect index; they now call `moveUploadedFile` from the storage layer so all processed files are written to (and remain discoverable via) the correct logical path regardless of storage layout

### Security
- **Disabled users are blocked across all authentication paths** � `verifyCredentials` (password and OTP login), `refreshAdminTokens` (token refresh), `getCurrentUserFromRequest`, `getCurrentUser`, `getAdminOverrideFromRequest`, and `verifyPasskeyAuthentication` all now filter by `active: true`; disabling an account immediately invalidates all existing access and refresh tokens so the user is signed out of every session without waiting for token expiry

## [1.1.6] - 2026-03-06

### Added
- **Live Client Activity monitor in the admin header** � added a new eye-icon dropdown to the left of Running Jobs that shows recently active client sessions, including share-page viewing, video streaming, video downloads, and asset downloads; clicking an item opens the relevant project for internal users

### Changed
- **Client activity is now tracked as short-lived live presence instead of analytics-only history** � share-page access and authenticated content requests now write lightweight Redis presence records for the last 2 minutes, allowing admins to see what clients are doing right now even when historical analytics collection is disabled; the new `GET /api/client-activity` endpoint applies the same project visibility and assignment filtering as other admin activity surfaces

## [1.1.5] - 2026-03-06

### Changed
- **CPU thread budget now reserves threads for the OS/app rather than targeting a fixed fraction** � `getCpuAllocation()` previously budgeted `floor(threads � 0.5)` for FFmpeg, meaning half of all cores were left idle even when no other load was present; it now subtracts a small fixed reservation (2 threads for =4 logical threads, 4 threads otherwise) and gives the remainder to FFmpeg, so an 8-thread machine gets a 4-thread budget under the old model but a 4-thread budget under the new one at low thread counts and a 4-thread budget either way � and a 16-thread machine goes from 8 threads to 12 threads available for video work; the `reservedSystemThreads` value is now included in the `CpuAllocation` object and printed in the startup log; the `DEFAULT_VIDEO_CPU_BUDGET_FRACTION` constant is removed
- **Running Jobs now inspects the live BullMQ queue for accurate QUEUED/PROCESSING state** � the `GET /api/running-jobs` endpoint previously inferred queue status only from the database `status` field, which could lag behind reality; it now calls `videoQueue.getJobs(['active'])` and `getJobs(['waiting', 'prioritized', 'delayed'])` and cross-references video IDs so each job shows the real queue position; `processingProgress` is forced to 0 for genuinely QUEUED jobs instead of showing a stale non-zero value
- **Running Jobs shows video version labels** � both upload rows and processing rows in the Running Jobs dropdown now display the version label (e.g. `v2`, `Director's Cut`) alongside the video name using a new `VideoNameWithLabel` component; `versionLabel` is propagated through the API response and the `UploadJob` / `ProcessingJob` types in `UploadManagerProvider`

### Fixed
- **Project switching dialog no longer steals focus from the video player** � the "Other Current Projects" dialog on share pages was rendered as a modal, causing the browser to move focus into the dialog on open and return it to the trigger on close, which paused the video and prevented keyboard shortcuts from working; the dialog is now non-modal (`modal={false}`) with both `onOpenAutoFocus` and `onCloseAutoFocus` suppressed
- **Project storage year-month routing corrected for uploads** � `uploadFile` and `moveUploadedFile` now call a new `ensureProjectStorageLayout()` helper before writing, guaranteeing the `projects/YYYY-MM/<projectId>` directory and redirect stub are bootstrapped even when no prior redirect entry exists; previously an upload arriving before the redirect index was populated could silently land in the legacy `projects/<projectId>` root instead of the dated subfolder, causing the file to remain inaccessible via storage-path lookups after migration
- **`resolveRedirectedProjectPath` now falls back to filesystem scan** � if neither the central redirect index nor the per-project stub file contains an entry, the path resolver now scans for an existing `projects/YYYY-MM/<projectId>` directory so files written before the redirect entry was created are still served correctly
- **Year-month migration merges misplaced content** � the Developer Tools "Migrate Project Storage" action now detects the case where a project already has a `projects/YYYY-MM/<projectId>` folder but files were subsequently written back to the legacy root (e.g. before a redirect stub existed), and recursively merges that misplaced content into the correct dated location; previously the migration would count such projects as already-migrated and leave the orphaned files behind
- **Project creation uses consolidated `ensureProjectStorageLayout`** � the inline year-month folder creation in `POST /api/projects` is replaced with the new shared helper, ensuring the exact same idempotent bootstrap logic runs for new projects and for uploads; the log level for storage-init failures is also raised from `warn` to `error` so infrastructure faults are not silently swallowed

## [1.1.4] - 2026-03-05

### Added
- **Authenticated client project switching** � password and OTP recipients on client share pages can now switch between other current projects for the same client when the target project is in an allowed active status; guest users are excluded, and switching remains blocked for `NOT_STARTED` and `CLOSED` projects
- **Project-switching controls in settings** � added a global default toggle in Admin Settings ? Default Project Settings and a per-project toggle in Project Settings ? Security so admins can disable project switching platform-wide or on individual projects; server-side enforcement checks both source and destination projects
- **Internal user notes and file storage** � admin user records now support freeform notes plus uploaded internal files such as agreements, insurance certificates, and rate sheets, backed by new user-file APIs, uploads, and worker validation

### Changed
- **Share-page analytics now record project-switch flow explicitly** � switching into a project records an arrival event with the origin project name, and switching away records a matching "changed to" event on the project being left; password sessions are labeled as Password User and OTP sessions continue to preserve the authenticated email address
- **Installation docs now standardize on `docker compose`** � README and installation instructions now use the Docker Compose v2 CLI form consistently and clarify that the setup scripts are optional convenience helpers, not a requirement; admins can still generate and manage their own secrets manually if preferred
- **FFmpeg CPU limits now align much more closely with the configured thread budget** � the worker already budgets against logical CPU threads (not physical cores), but FFmpeg could still over-parallelize internally; preview transcodes now cap both decode and encode thread usage explicitly, and all FFmpeg paths pin `-filter_threads 1` so lightweight filter graphs do not silently spawn a full-CPU pool; timeline generation still scales dynamically with the active-job count, while thumbnail extraction uses the auxiliary `TIMELINE_FFMPEG_THREADS_PER_JOB` allocation

### Fixed
- **Timeline-only regen jobs now appear correctly in Running Jobs** � toggling "Enable Timeline Previews" on in project settings queues timeline-only worker jobs while the video stays in `READY` for uninterrupted playback; the Running Jobs endpoint now includes `READY` videos with a non-null `processingPhase`, the queueing path marks them as `timeline` immediately, and the worker clears that marker on completion or failure so jobs do not get stuck in the dropdown if queueing or processing fails
- **Reprocessed videos show correct QUEUED ? PROCESSING progression** � the `POST /api/projects/[id]/reprocess` endpoint (triggered by watermark or resolution changes) was setting all videos to `PROCESSING` immediately, even when the worker had not yet picked them up; this made every video look like it was actively being encoded in Running Jobs, hiding the true queue depth; the endpoint now sets `QUEUED` (matching the upload flow) and lets the worker advance to `PROCESSING` when it begins work
- **Running Jobs now shows accurate per-job thread allocation** � the dropdown now displays badges such as `(4/8 threads)` beside active processing phases, including timeline-only `READY` jobs; the API computes the allocation per job/phase so thumbnails, transcodes, and timeline generation each report the thread count they actually use instead of sharing one approximate global value
- **Scheduled internal comment digests now fail cleanly when nobody can receive them** � if a project has no assigned users with notifications enabled, the queued digest is now marked skipped with a recorded reason instead of remaining pending indefinitely

## [1.1.3] - 2026-03-05

### Changed
- **Timeline preview toggle no longer triggers a full video reprocess** � the "Enable Timeline Previews" switch in project settings previously detected as a processing-settings change and showed the same ReprocessModal as watermark or resolution changes, offering "Save Without Reprocessing" or "Save & Reprocess"; the toggle is now handled entirely outside that flow: turning it **OFF** immediately deletes sprite directories from storage and clears the three timeline DB fields (`timelinePreviewsReady`, `timelinePreviewVttPath`, `timelinePreviewSpritesPath`) for every video in the project without any modal; turning it **ON** queues a lightweight timeline-only background job for each READY video that does not already have previews � the worker downloads the original source file, generates sprite sheets and the WebVTT index, updates the DB, and exits, leaving the video in READY status throughout so clients can keep watching uninterrupted; backed by a new `POST /api/projects/[id]/timeline-previews` endpoint (`action: 'remove' | 'generate'`) and a new `timelineOnly` code path in the video worker that skips all transcode and thumbnail stages

### Fixed
- **`TypeError: Invalid state: Controller is already closed` errors in streaming routes** � 11 API endpoints that wrap a Node.js `ReadStream` in a Web `ReadableStream` were vulnerable to a race condition where the runtime called `controller.enqueue()` / `controller.error()` / `controller.close()` after the controller had already been closed; two patterns triggered this: (1) pull-based routes where the runtime issues one final `pull()` after the `end` event has already called `close()`, and (2) push-based routes where the client disconnects, `cancel()` destroys the underlying Node.js stream, the stream emits a trailing `error` event, and the `error` handler calls `controller.error()` on an already-closed controller; all 11 affected routes are now guarded by a `closed` boolean that is set to `true` on the first `close()` / `error()` call and checked before every subsequent controller interaction; affected routes: `api/content/[token]`, `api/content/photo/[token]`, `api/videos/[id]/download`, `api/videos/[id]/assets/[assetId]`, `api/projects/[id]/emails/[emailId]/attachments/[attachmentId]`, `api/projects/[id]/files/[fileId]`, `api/comments/[id]/files/[fileId]`, `api/clients/[id]/files/[fileId]`, `api/branding/favicon`, `api/branding/logo`, `api/branding/dark-logo`

## [1.1.2] - 2026-03-05

### Added
- **Per-phase progress in Running Jobs** � the Running Jobs dropdown now shows which processing stage is active ("Processing previews�" / "Generating thumbnail�" / "Generating timeline previews�") with an independent 0�100% progress bar for each phase; progress is driven by a new `processingPhase` database field written by the worker, so the UI always reflects the real current operation; the video list on the Projects page continues to show the generic "Processing previews�" badge unchanged

### Fixed
- **CRITICAL: Timeline previews (video scrub bar hover sprites) were never generated** � `processTimelinePreviews` was guarded by `tempFiles.preview`, a ref that is explicitly deleted from the temp-file map after `processPreview` moves the transcoded file to storage; the guard always evaluated to `false`, meaning no video had ever produced hover-preview sprites since the feature was introduced; the guard is removed and the input is changed to `videoInfo.path` (the original source file), so sprite sheets are now generated correctly for every video with timeline previews enabled
- **Dynamic FFmpeg thread scaling for lone jobs** � when fewer jobs are actively processing, each job now receives proportionally more FFmpeg threads up to the full configured CPU budget; a single job gets all `budgetThreads` threads rather than the static `budgetThreads / maxConcurrency` allocation, significantly reducing transcode time for large files when the queue is not at capacity; the FFmpeg preset (`faster` / `fast` / `medium`) remains fixed to the statically configured threshold and is not affected by the active job count
- **Large file downloads no longer fail on slow connections** � the Node.js-to-Web-ReadableStream wrapper used for all video/asset downloads was push-based: `createReadStream` fired `data` events as fast as the disk could read, each chunk was immediately enqueued via `controller.enqueue()`, and the Node.js stream was never paused; for a 1 GB file on a client with a slower connection than disk throughput (i.e. always), the Web ReadableStream's internal queue grew unbounded in memory, eventually causing OOM pressure, stream errors, or HTTP-layer timeouts that forced the client to retry the download from scratch; converted both the `/api/content/[token]` helper (`createWebReadableStream`) and the `/api/videos/[id]/download` inline wrapper to a pull-based model � data is only read from disk when the consumer (browser) calls `pull()`, and the Node.js stream is immediately paused after each chunk, keeping server memory flat regardless of file size or transfer speed
- **Download tokens use a dedicated 2-hour TTL** � video and asset download tokens previously inherited the client session timeout, so downloading a large file on a slower connection could fail mid-transfer when the token expired in Redis; download tokens now use a fixed 2-hour TTL (`DOWNLOAD_TOKEN_TTL`) independent of the session timeout, and a separate cache key (`download` / `asset-download`) so they don't collide with shorter-lived streaming tokens; the `/api/content` endpoint now returns `410 Gone` with "Download link has expired" when a download token has expired, instead of a generic 403
- **Removed Node.js DEP0169 `url.parse()` deprecation warning from browser-push notifications** � `web-push` v3.6.7 (latest) still calls `url.parse()` internally; patched the dependency to use the WHATWG `URL` API via `patch-package`, and ensured Docker production builds apply the patch consistently

## [1.1.1] - 2026-03-05

### Fixed
- **Large video processing no longer crashes the worker** � transcoding a multi-GB video (e.g. 6+ GB / 90+ minutes) caused the FFmpeg `onProgress` callback to fire hundreds of concurrent `prisma.video.update()` calls, exhausting the Prisma connection pool (limit 17, timeout 10 s) with error `P2024`; the unhandled error crashed the Node.js process, the container restarted, BullMQ detected a stalled job and re-queued it, and the cycle repeated indefinitely � the logs show the same video picked up 6+ times with interleaved output before finally failing with "job stalled more than allowable limit"; fixed by (1) throttling progress DB writes to at most once every 3 seconds with an in-flight guard so only one query is active at a time, (2) catching and logging any progress-update error instead of letting it bubble up as an unhandled rejection, and (3) configuring the BullMQ video worker with `lockDuration: 600 000 ms` (10 min, auto-renewed every 5 min), `stalledInterval: 300 000 ms`, and `maxStalledCount: 2` so that long-running transcodes are not prematurely declared stalled
- **Notification bell hides internal fields and uses human-readable labels** � the bell dropdown no longer shows raw database field names (`viewUrl`, `salesQuoteId`, `clientName`, etc.) in notification detail lines; `viewUrl`, `salesQuoteId`, and `salesInvoiceId` are now hidden (navigation is handled by clicking the notification row), and remaining fields are mapped to clean labels (`clientName` ? "Client", `quoteNumber` ? "Quote", `invoiceNumber` ? "Invoice", `projectTitle` ? "Project"); any unknown camelCase or underscore-separated field name is automatically converted to Title Case words as a fallback
- **Unaccepting a quote now shows the correct "Opened" status immediately** � the `PATCH` response from `patchSalesQuote` does not include `hasOpenedEmail` (a derived field computed from email open-tracking records); previously, clicking Unaccept on the Quotes page would momentarily display "Sent" because the optimistic update had no email-open context, reverting to "Opened" only after a full page refresh; the `hasOpenedEmail` flag from the original quote row is now preserved when applying the unaccept update locally

## [1.1.0] - 2026-03-04

### Added
- **Mobile hamburger navigation menu** � the admin header nav links are now hidden behind a `Menu`-icon `DropdownMenu` on screens narrower than the `md` breakpoint; the full inline nav is still shown on `md` and above; this prevents the nav from collapsing into an awkwardly scrollable row on phones and tablets

### Changed
- **"Project Ready for Review" email video list improvements** � videos with multiple versions are now consolidated onto a single line (e.g. `Day 1 - Session 3 v1 v2`) instead of one line per version; videos and albums are listed in alphabetical order; any video group that has at least one approved version now shows a green `Approved` pill next to the title; the defunct duplicate "Ready to view" card (dead-code variable) has been removed from the template
- **Running Jobs completed jobs linger for 10 minutes** � recently completed uploads in the Running Jobs dropdown now auto-dismiss after 10 minutes instead of 8 seconds, giving users a longer window to review finished items
- **Running Jobs poll rate increases when dropdown is open** � the `GET /api/running-jobs` endpoint is now polled every 5 seconds while the Running Jobs dropdown is open, and every 10 seconds when it is closed, providing more responsive progress updates during active use without increasing background traffic
- **Header dropdown buttons highlight while open** � the `RunningJobsBell`, `NotificationsBell`, and mobile nav trigger buttons now apply `data-[state=open]` accent-colour classes so the button visually stays "pressed" while its dropdown is open; Radix `onCloseAutoFocus` is also suppressed on both dropdowns so focus is blurred rather than retained (which previously left a visible focus ring on the button after closing)
- **Running Jobs rows navigate to the project page** � clicking anywhere on an upload or processing job row (other than the pause/resume/cancel/dismiss icon buttons) closes the dropdown and navigates to `/admin/projects/[projectId]`; the action buttons stop event propagation so they are unaffected

### Fixed
- **Admin IP suppression applied to guest share access tracking** � `trackSharePageAccess` now calls `isLikelyAdminIp` (same helper used by the sales doc view page) before writing a `SharePageAccess` record or firing the push notification; previously, an admin clicking "Continue as Guest" on a share page would trigger a "A client accessed the share page" bell notification and analytics record because the client-side guest POST request carries no admin JWT header � `getCurrentUserFromRequest` returned null, so the existing JWT guard was ineffective; the IP-based fallback now correctly suppresses tracking for internal users regardless of how they entered the share page
- **Stale TUS temp-directory path in upload cleanup script** � `upload-cleanup.ts` still referenced the old `/tmp/vitransfer-tus-uploads` path after the v1.0.8 change that moved TUS chunk files to `STORAGE_ROOT/.tus-tmp`; the script now derives the same path from `STORAGE_ROOT`, so stale partial-upload files are correctly purged during scheduled cleanup

## [1.0.9] - 2026-03-04

### Added
- **Running Jobs header indicator** � a new `Activity` icon button to the left of the notification bell in the admin header shows a badge counter with the total number of active jobs (uploads + server-side processing); clicking it opens a dropdown listing active uploads (with progress bars, upload speed, ETA, pause/resume/cancel controls via compact icon buttons), processing/queued server-side jobs (with progress percentages), and recently completed jobs that auto-dismiss after 8 seconds; this feature is available to internal admin users only � external clients and share-page visitors do not see or interact with the Running Jobs indicator; backed by a new `GET /api/running-jobs` endpoint that polls every 10 seconds for videos in `QUEUED` or `PROCESSING` status
- **Persistent uploads across page navigation** � video uploads now continue running in the background when navigating between admin pages; a new `UploadManagerProvider` React context at the admin layout level holds all TUS upload instances, processes them sequentially, and exposes pause/resume/cancel controls through the Running Jobs dropdown; both `MultiVideoUploadModal` (batch uploads) and `VideoUpload` (single "Add New Version" uploads) now create the video record, enqueue the file with the global upload manager, and immediately close/reset � the upload progress is tracked exclusively in the Running Jobs indicator
- **Project-scoped running jobs** � the `GET /api/running-jobs` endpoint now respects RBAC project access: system admins see processing jobs across all projects, while other internal roles only see jobs for projects they are assigned to; project status visibility settings from the user's role are also applied, ensuring users never see jobs for projects outside their permission scope
- **Purge stale BullMQ jobs tool in Developer Tools** � new maintenance action in Settings ? Developer Tools that counts (dry-run) or removes completed and failed BullMQ job keys across all eight queues in Redis; completed jobs older than 1 hour and failed jobs older than 24 hours are purged, with a per-queue breakdown shown in the results; backed by `POST /api/settings/purge-bullmq-jobs`

### Fixed
- **Redis key bloat causing slow uploads and AOF fsync warnings** � the `notification-processing` BullMQ queue had no `removeOnComplete` / `removeOnFail` defaults, so every hourly notification check, key-date reminder, auto-close run, and retry job left completed/failed job keys in Redis permanently; over weeks this accumulated tens of thousands of keys, triggering Redis AOF `fsync is taking too long (disk is busy?)` warnings and blocking the event loop during BGSAVE � which stalled TUS upload PATCH handling; fixed by adding `defaultJobOptions` with `removeOnComplete: { age: 3600 }` and `removeOnFail: { age: 86400 }` to the queue constructor (matching all other queues), and adding explicit `removeOnComplete: true` / `removeOnFail: true` to the two repeatable jobs (`process-notifications`, `auto-close-approved-projects`) that were missing them; the `user:tokens:revoked_at:${userId}` key in `password-reset.ts` was also written with `redis.set()` (no TTL), accumulating one permanent key per password reset � changed to `redis.set(..., 'EX', 604800)` (7-day expiry matching refresh token duration)

## [1.0.8] - 2026-03-03

### Added
- **Processing progress percentage in video bar** � the PROCESSING progress bar in the video list now shows the actual FFmpeg transcode percentage (e.g. `42%`) alongside the "Processing previews..." label; the bar fills proportionally with a 1% minimum so there is always a visible indicator from the moment processing begins; normalises both the `0.0�1.0` float range stored during transcoding and the `100` completion sentinel
- **Cancel Upload button in batch upload modal** � a "Cancel Upload" button appears in the `MultiVideoUploadModal` footer while a batch upload is in progress; clicking it immediately aborts the active TUS upload, resets the item back to pending state, and stops the remaining queue without closing the dialog, so the user can correct issues or close manually
- **Upload speed and ETA in batch upload modal** � while a file is uploading in `MultiVideoUploadModal`, a `Speed: X MB/s` / `Estimated: Y seconds` row now appears beneath the progress bar for each active item, matching the display already present in the asset and file upload components
- **UPLOADING status badge** � videos in `UPLOADING` status now display a neutral spinning `UPLOADING` badge in the same position as the `PROCESSING` / `QUEUED` badges in both the video list row and the `AdminVideoManager` group card header, making in-flight uploads visible rather than appearing as blank entries
- **FAILED status badge** � videos in `ERROR` status now display a destructive `FAILED` badge in the video list row and `AdminVideoManager` group card header (previously these showed no badge at the group level)
- **`POST /api/videos/[id]/cancel-upload` endpoint** � new endpoint that marks an `UPLOADING` or `ERROR` video record as `ERROR` with the reason `Upload cancelled before completion`; used as a fallback when the caller lacks the `projectsFullControl` permission required to hard-delete the video record, preventing ghost `UPLOADING` entries from persisting on the Projects page

### Changed
- **TUS temp files co-located with storage root** � the TUS server now stores upload chunk temp files in `STORAGE_ROOT/.tus-tmp` instead of `/tmp/vitransfer-tus-uploads`; because the temp directory is now on the same filesystem as the final storage location, the `onUploadFinish` handler uses an atomic `fs.rename` move instead of a full read/write copy, eliminating a complete extra copy of every uploaded file; a cross-device (`EXDEV`) fallback stream-copy is retained for edge cases
- **Cancel cleans up incomplete video records** � on abort or TUS error, the upload components first attempt `DELETE /api/videos/:id`; if that returns 403 (insufficient permissions), they fall back to the new `cancel-upload` endpoint so the incomplete record is always resolved rather than left as a ghost

### Fixed
- **Upload ETA shown in minutes when over one minute** � all upload components (`MultiVideoUploadModal`, `VideoAssetUpload`, `VideoAssetUploadItem`, `AlbumPhotoUploadItem`) now format the remaining time estimate as `X min Y sec` (or `X min` when no seconds remainder) for ETAs of 60 seconds or more, replacing the raw seconds count that could reach into the thousands for large files
- **Cancel Upload freezing the upload queue** � `tus.Upload.abort(true)` can silently skip the `onError` callback, leaving the queue's internal `await new Promise(�)` permanently unresolved and freezing all subsequent uploads; fixed by storing a direct reference to the Promise's `reject` function (`currentUploadRejectRef`) that `handleCancelCurrentUpload` calls immediately before issuing the TUS abort, with a `settled` boolean guard preventing double-settlement if `onError` also fires
- **Ghost UPLOADING records persisting on Projects page after cancel** � `handleCancelCurrentUpload` now tracks the active `videoId` in a dedicated ref (`currentVideoIdRef`) and directly calls `DELETE /api/videos/:id` (falling back to `cancel-upload`) as a fire-and-forget before `abort(true)` is issued; this ensures the server-side record is always cleaned up regardless of whether the TUS `onError` callback fires
- **Collapsing a video card during "Add New Version" upload cancels the upload** � the `CardContent` in `AdminVideoManager` was conditionally mounted with `{isExpanded && ...}`, so collapsing the card unmounted the `VideoUpload` component mid-upload, destroying all TUS state; the card content is now kept mounted (visually hidden via `hidden`) when an upload form is open for that group, so the upload survives collapse/expand and progress resumes exactly where it left off when the card is reopened

## [1.0.7] - 2026-03-02

### Added
- **Reconciled payment amounts shown in brackets** � the payments page now wraps the amount in parentheses (e.g. `($120.00)`) for any payment marked as a reconciliation/mirror entry (`excludeFromInvoiceBalance`), making it visually clear at a glance that the entry is a QBO-mirrored or reconciliation record and not a new payment; the `(reconciled)` source label in the method column is unchanged

### Changed
- **Internal user analytics suppression** � share page access, video analytics, invoice/quote view events, guest video link access events, and associated push/bell notifications are no longer recorded when the visitor is identified as an internal user; detection uses two layers: (1) a `?ref=internal` query parameter automatically appended when internal users click "View Invoice" or "View Quote" from the admin UI, and (2) a best-effort IP match against recent admin login IPs from the `SecurityEvent` table (cached in Redis for 24 h) as a fallback for direct URL access; the security event audit log is unaffected
- **Consistent IP resolution via `getClientIpAddress`** � `trackSharePageAccess` and the NONE-mode share route were using raw `x-forwarded-for` / `x-real-ip` header extraction instead of the centralised `getClientIpAddress()` helper; they now go through the same normalisation, IPv4-mapped-IPv6 handling, Cloudflare header priority, and `TRUSTED_PROXIES` proxy-peeling logic as every other IP callsite

### Fixed
- **IP addresses missing in Security Events and Video Analytics** � the proxy IP hardening introduced in v1.0.0 returned `'unknown'` unconditionally when `TRUSTED_PROXIES` was not configured, breaking IP detection for local/dev deployments and any environment without an explicit trust list; `getClientIpAddress()` now falls back to the left-most `X-Forwarded-For` entry (or `X-Real-IP`) with a one-time console warning when no trust list is set, restoring the pre-hardening behaviour while still recommending `TRUSTED_PROXIES` for production; deployments that already have `TRUSTED_PROXIES` configured are unaffected

## [1.0.6] - 2026-03-02

### Added
- **"QUEUED" video status badge** � when multiple videos are uploaded simultaneously and the worker CPU limit is reached, videos waiting in the processing queue now display an orange `QUEUED` badge (and a flat amber progress bar) instead of silently waiting; the badge appears in the same position as the `PROCESSING` badge in both the video list and the group card header in `AdminVideoManager`; the `PROCESSING` status and animated stripe bar are unchanged and only appear once the worker actually begins encoding

### Security
- **Open-redirect fix on login `returnUrl`** � the `returnUrl` query parameter on the login page is now validated to only allow relative paths (must start with `/`, must not start with `//`); external URLs and `javascript:` URIs are silently rejected and the user is redirected to `/admin` instead, preventing phishing and script-injection via crafted login links
- **Secure watermark temp-file creation** � replaced direct `/tmp` file creation with `fs.mkdtempSync` for FFmpeg watermark temp files; the new approach creates a dedicated directory with restricted `0700` permissions before writing the file, closing a symlink/hard-link race-condition window; both `close` and `error` cleanup handlers now also remove the temp directory
- **ReDoS fix in `sanitizeFilename`** � replaced the `^[.\s]+|[.\s]+$` alternation regex (catastrophic backtracking on crafted filenames) with deterministic while-loops that strip leading/trailing dots and spaces in O(n) time
- **Proper HTML-to-plaintext in email fallback** � replaced the naive `/<[^>]*>/g` tag-stripping regex in `sendEmail` with the `html-to-text` library; malformed, multi-line, or encoded HTML tags are now handled correctly, preventing garbled or partially-tagged plain-text email parts
- **Cloudflare IP header priority** � `getClientIpAddress()` now checks `CF-Connecting-IP` before `X-Forwarded-For`; when running behind Cloudflare this header is set by the CDN itself and cannot be spoofed by clients, ensuring accurate IP logging and rate-limiting for Cloudflare-proxied deployments

## [1.0.5] - 2026-02-28

### Added
- **Accurate "Last Activity" timestamps** � projects dashboard, client detail page, and analytics now derive the last-activity timestamp from real event records (`sharePageAccess`, `videoAnalytics`, `albumAnalytics`) rather than `project.updatedAt`, giving a more meaningful signal of when a project was last genuinely active

### Changed
- **Quote amounts in client sales summary** � client detail page now shows the amount column for quotes in the per-client sales summary table
- **Albums sorted alphabetically** � project albums are now listed in alphabetical order on share pages and in the admin view
- **QuickBooks payments are read-only** � QBO-synced payment entries are now marked read-only in the payments table alongside Stripe payments, preventing accidental edits to mirrored records
- **Payment source types expanded** � the payment source field now distinguishes `MANUAL`, `QUICKBOOKS`, and `STRIPE` (previously collapsed `LOCAL` and `QUICKBOOKS` into a single `LOCAL` value)
- **Recent payments metric corrected** � the sales dashboard recent-payments total now correctly excludes reconciliation/mirror entries via the `excludeFromInvoiceBalance` flag rather than only filtering by `STRIPE` source, so QBO-mirrored Stripe payments are no longer double-counted
- **Scrollbar styling centralized** � all custom scrollbar CSS consolidated into a single global rule in `globals.css` (6 px width and height, discreet muted-foreground thumb); per-component `styled-jsx` scrollbar blocks removed from `VideoSidebar`, `ProjectInternalComments`, and `ProjectAnalyticsClient`

### Fixed
- **`react-hooks/exhaustive-deps` lint warnings** � `ProjectsList` useMemo was missing `analyticsMap` from its dependency array; `ProjectAnalyticsClient` `activity` array was recreated on every render, making the downstream `sortedActivity` useMemo stale � both corrected

## [1.0.4] - 2026-02-19

### Added
- **Internal comment bell notifications** � posting an internal comment now fires a real-time `PushNotificationLog` entry, updating the badge count and triggering browser push for all users assigned to the project (excluding the author)
- **Browser push for all admin users** � push notification subscriptions are no longer restricted to system admins; all admin users can subscribe their devices and receive notifications scoped to their access level: project events for assigned projects, sales events for sales-menu users, security events for system admins only
- **Inline push subscribe/unsubscribe toggle in notification bell** � a `BellOff`/`BellRing` icon in the bell dropdown header lets any user enable or disable browser push on the current device without needing Settings access; button is hidden automatically when push is unavailable (no VAPID key, unsupported browser, or insufficient permissions)
- **Push subscription error feedback** � blocked or failed push subscribe/unsubscribe attempts now show an inline error message in the bell dropdown; permission-denied state shows a specific "Notifications are blocked in your browser" message rather than silently failing
- **Developer tools section** � new Developer Tools card in Settings for ad-hoc maintenance actions (e.g. purge notification backlog)
- **Notification backlog purge API** � new `POST /api/settings/purge-notification-backlog` endpoint to clear stale unprocessed notification queue entries

### Changed
- **Notification routing refactored** � `sendImmediateNotification` now accepts a `target` parameter (`'client'` or `'admin'`) to cleanly separate routing paths; client and admin delivery are no longer entangled in the same code path
- **Comment notification cancellation key renamed** � Redis key changed from `comment_notification:{id}` to `comment_cancelled:{id}` to accurately reflect its purpose; all workers and the notify route updated consistently
- **Admin notification worker processes both directions** � the admin notifications worker now handles both `CLIENT_COMMENT` (client-to-admin) and `ADMIN_REPLY` types, matching the client notifications worker; previously only `CLIENT_COMMENT` was picked up for admin digest delivery
- **Notification backlog age limit** � admin notification worker and comment summary route now ignore queue entries older than 7 days to prevent delivering stale digests after downtime
- **Comment summary route sends to both sides** � `POST /api/projects/:id/notify` with `type: COMMENT_SUMMARY` now queues emails to both client recipients and internal assigned users from the same payload, rather than only handling one direction
- **Accent colour passed to all email templates** � admin summary, internal comment digest, and comment notification emails now correctly pass `accentColor` through to templates (previously missing, causing some branded emails to fall back to the default colour)
- **Worker job log labels improved** � worker completion and failure log messages now distinguish between key-date checks, notification checks, and other job types instead of labelling everything as "Notification check"
- **User edit page layout rebuilt** � the edit user page now uses a card layout with a two-column grid for fields (email, name, role, status, password), consistent with the rest of the admin UI; same inline generate/copy password buttons as the create user flow

### Fixed
- **Dialog backdrop click no longer blocked** � removed `event.stopPropagation()` handlers from `DialogOverlay` that were preventing modals from closing when clicking outside them
- **Checkbox tick intercepting click events** � added `pointer-events-none` to the `Check` icon inside the checkbox component so that clicking the tick area no longer double-fires the toggle and causes the checkbox to flick back
- **Internal comment email self-notification** � the comment author is now filtered from their own internal comment digest; previously both sides of an internal comment thread would receive the same summary email
- **Notification data leak for non-admin users** � removed an `OR projectId: null` clause from the bell API's project scope filter that was incorrectly leaking all project-type notification log entries (with no project ID) to any user with Projects menu access
- **Bell badge count for project-assigned non-admin users** � notification visibility is now gated on project assignment directly rather than Projects menu visibility; users assigned to projects now correctly see badge counts even when their role does not include the Projects menu item
- **Projects dashboard stale client names** � projects list and key dates calendar now refetch data when the browser tab regains focus, so a client name change made in another tab is reflected immediately without a manual reload
- **Cross-window auth token sync** � tokens received via `BroadcastChannel` from another tab are now written to storage immediately, preventing stale sessions after page reload when a background tab rotated the refresh token
- **Password UI shown for non-password auth modes** � password-related UI (entry prompt, clear button, settings field) no longer appears on share pages and project settings when the project auth mode is OTP, Guest, or None; the project PATCH API now clears any stored password hash when switching away from password-based modes
- **Client page sales status rollup** � client detail page invoice and quote rollup now includes all relevant statuses (`PAID`, `PARTIALLY_PAID`, `OPENED`, `OVERDUE`, `ACCEPTED`, `CLOSED`) rather than a partial subset

### Removed
- **Legacy comment recipient backfill** � removed `backfillCommentRecipientIdsByAuthorName` helper and all call sites; recipient IDs have been normalised in the database and the backfill is no longer needed
- **Dead utility modules** � removed `src/lib/encryption.ts` (duplicated logic), `src/lib/password-utils.ts` (inlined at call sites), and unused dev scripts (`export-pwa-notification-previews.ts`, `_check_prisma_sales_share.js`)
- **Broken `ajv` package override** � removed the `overrides.ajv: 8.18.0` entry in `package.json` that was forcing ajv v8 onto `@eslint/eslintrc`, which requires ajv v6 and crashed ESLint with `TypeError: Cannot set properties of undefined (setting 'defaultMeta')`

## [1.0.3] - 2026-02-17

### Added
- **Default theme setting** � new Light / Dark / Auto selector in Company Branding to set the default colour theme for all visitors
- **Allow theme toggle setting** � new toggle in Company Branding to show or hide the theme switcher button across the entire app; when disabled, all users see only the admin-configured default theme
- Auto mode uses the visitor's operating-system preference (`prefers-color-scheme`)

### Changed
- **Light mode contrast** � background, card, popover, border, and muted tones are now deeper and more contrasty; text and status colours darkened slightly; shadows strengthened
- **Email logo size** � company logo in email templates now constrained to max 280 � 120 px to prevent oversized logos
- **Email hyperlink colours** � Unsubscribe and secondary text links in all email templates no longer override colour with the accent colour; they now inherit the email client's default link colour for better readability
- **Invoice/quote logo theme adaptation** � public invoice and quote pages now display theme-appropriate logos: light mode (dark header) shows dark logo when configured, dark mode (light header) shows normal logo
- **Logo size on sales documents** � company logo on HTML invoice/quote pages and PDF templates increased by ~10% (h-10?h-11 on HTML, 42pt?46pt on PDF)
- **Add New User password UI** � password field now uses inline generate/copy buttons (matching Create Project page) instead of separate row button; improved mobile layout
- **Branding settings simplified** � removed URL/link option for Company Logos and Favicon; only None and Upload modes remain

## [1.0.2] - 2026-02-16

### Added
- **24-hour time picker** for key dates � clock-style HH?MM selector with 5-minute increments, defaults to 12:00 when opened empty, replaces previous long-dropdown style for Start/Finish/Reminder times in all Add Key Date modals
- **Automated setup scripts** � `setup.sh` (Linux/Mac/WSL) and `setup.ps1` (Windows PowerShell) auto-generate all 6 required secrets, validate admin credentials, port, timezone, and HTTPS configuration

### Changed
- **Video upload resume** � check video status before resuming from localStorage to prevent invalid resume attempts when video moved past UPLOADING phase
- **Sales line item layout** � tightened invoice/quote line item grid layout with improved responsive behavior for tax rate and subtotal fields
- **Share album download buttons** � changed to primary button style (from outline) for better visual prominence in album viewer
- **Docker workflow** � simplified to use `docker-compose.override.yml` pattern (gitignored) for local builds instead of separate build compose file
- Date validation error messages now show "Invalid date value. Please use the date picker." instead of locale-specific "date must be YYYY-MM-DD" format text
- Date input fields now enforce 4-digit year bounds (0001�9999) via `min`/`max` attributes to prevent entering invalid year values
- Updated all branch references from `dev` to `main` in installation documentation

### Fixed
- **Client name changes not reflected in project dashboard** � renaming a client now automatically syncs all linked projects' display names; dashboard now includes live client relation as fallback ensuring current names always display
- **413 error for video uploads over 1GB** � video/asset uploads now correctly skip `maxUploadSizeGB` limit in TUS upload handler
- **Video re-upload to ERROR status** � allow re-uploading to videos that previously failed by resetting state to UPLOADING
- Date picker calendar icon now visible in dark mode with proper contrast (inverted and brightened) across all themes
- Date picker icon globally styled in `globals.css` ensuring consistent visibility on all date input fields

### Removed
- `compose-up.ps1` helper script (standard `docker compose up -d` now works for both pull and build workflows)
- `docker-compose.build.yml` (replaced by optional `docker-compose.override.yml` pattern)

## [1.0.1] - 2026-02-15

### Changed
- Merged `scripts/retry-publish-docker.ps1` into `publish-docker.ps1` � retry loop, DNS pre-check, and post-publish verification are now built in
- Added `-MaxAttempts`, `-RetrySleep`, `-NoRetry`, and `-NoVerify` flags to `publish-docker.ps1`

### Removed
- `scripts/retry-publish-docker.ps1` (no longer needed)

## [1.0.0] - 2026-02-15

First independent release of ViTransfer-TVP as a hard fork.
Forked from upstream ViTransfer v0.8.2 (archived at `archive/upstream-v0.8.2` branch).

### TVP-Exclusive Features

#### Sales & CRM
- **Sales dashboard** with outstanding invoices, payment status, revenue tracking, and configurable fiscal year reporting
- **Quote system** � create, send, and track quotes with expiry dates, reminders, and conversion to invoices
- **Invoice management** � create, send, and track invoices with automated overdue payment reminders
- **Payment tracking** � manual payment recording and real-time Stripe webhook updates
- **Branded PDF generation** � downloadable quote and invoice PDFs with company logo support
- **Document sharing** � public share links for quotes and invoices with view/open tracking and email analytics
- **QuickBooks Online integration** � pull-only sync for clients, quotes, invoices, and payments with configurable daily polls
- **Stripe Checkout** � accept payments directly on invoices with processing fee pass-through and surcharge display
- **Currency support** � automatic symbol lookup from ISO 4217 currency codes (60+ currencies)
- **Client database** � centralized client management with company details, contact info, display colors, and file storage

#### Guest Video Links
- **Single-video access** � generate unique links for individual videos without exposing the project
- **Token-based security** � cryptographically secure tokens with 14-day auto-expiry and refresh
- **Analytics tracking** � view counts with IP-based dedupe, push notifications on access, watermark support

#### Photos & Albums
- **Multi-photo albums** � create multiple albums per project with batch upload (up to 300 photos, 3 concurrent)
- **Social media export** � automatic 4:5 (1080x1350) Instagram portrait crop generation
- **Bulk downloads** � ZIP files for full resolution and social crops
- **Share integration** � albums appear on client share pages when enabled per project

#### Comprehensive Branding
- **Company logos** � upload or link to PNG/JPG for app header, emails, and PDFs; separate dark mode logo
- **Custom favicon** � upload or link for professional browser tab appearance
- **Accent color** � custom hex color for buttons, links, toggles, and email templates with light/dark text modes
- **Email branding** � custom header color, text mode, clickable logos, and company watermark across all communications

#### User Roles & Permissions (RBAC)
- **Custom roles** � unlimited named roles (Project Manager, Editor, Accountant, etc.) with granular permissions
- **Menu visibility** � per-role access to Projects, Clients, Sales, Settings, Users, Security, Analytics, Share Page
- **Project status filtering** � limit visible statuses per role (e.g., editors only see IN_PROGRESS)
- **Granular actions** � per-area permissions like uploads, full control, manage comments, send test emails
- **Project assignment** � assign specific users to projects for targeted collaboration and notifications

#### Better Aspect Ratio Support
- **Portrait, square, ultra-wide, and legacy formats** � proper 9:16, 1:1, 21:9, 4:3 support with dynamic player sizing
- **Container queries and metadata-first** � modern CSS scaling and database-stored dimensions prevent visible jumps

#### Communication & Notifications
- **Video version notes** � per-version notes (500 chars) visible on share pages with inline editing
- **Selectable email recipients** � choose which recipients receive each notification, with per-recipient opt-in/out
- **Internal project chat** � admin-only threaded discussions hidden from client share pages
- **Key date reminders** � automated emails to selected users/recipients before milestone dates
- **Push notifications** � optional Gotify and browser Web Push (VAPID) for real-time alerts
- **In-app notification bell** � unread badge, auto-polling, click-to-navigate, covering comments, approvals, sales, and security
- **Smart email digests** � immediate, hourly, daily, or weekly batching to reduce noise
- **Email tracking** � optional open-tracking pixels (can be disabled globally; legal compliance is your responsibility)
- **Comment attachments** � multi-file uploads (up to 5 per comment) supporting images, PSD/AI, and video formats

#### Status Workflow & Calendar
- **8 project statuses** � NOT_STARTED, IN_PROGRESS, IN_REVIEW, REVIEWED, ON_HOLD, SHARE_ONLY, APPROVED, CLOSED
- **Automated transitions** � auto-IN_REVIEW on client notify, auto-APPROVED when all videos approved, auto-close after X days
- **Key dates** � PRE_PRODUCTION, SHOOTING, DUE_DATE, and personal dates with automated reminders
- **Calendar sync** � iCal/ICS feed for Google Calendar, Apple Calendar, Outlook with automatic updates

#### External Communication Library
- **Email import** � drag-and-drop .eml files into projects with automatic parsing of subject, body, attachments, and inline images
- **Background processing** � large email files processed asynchronously

#### Additional Security
- **Max upload safeguards**, **random slug generation**, **constant-time comparison**, **token hashing**, **OTP with crypto.randomInt()**, **account lockout**, **7-layer path traversal defense**, **FFmpeg input sanitization**, and **security event logging**

#### Granular Approval Control
- **Per-version approval toggle** � each video version has an `allowApproval` setting, defaulting to disabled to prevent accidental WIP approvals
- **Admin override** � toggle approval permission on any version at any time
- **API enforcement** � share page validates approval flag before processing

#### Client File Storage
- **Centralized document repository** � per-client file storage for contracts, branding assets, style guides, and reference materials
- **Auto-categorized uploads** � files sorted by type (contracts, branding, images, video, audio, documents)
- **Internal-only** � not exposed on client share pages

### Infrastructure
- **Independent versioning**: SemVer 1.0.0+, dropping upstream version prefix
- **Docker Hub images**: `thinkvp/vitransfer-tvp-app` and `thinkvp/vitransfer-tvp-worker`
- **Compose file**: `docker-compose.yml` (pull from Docker Hub); optional local `docker-compose.override.yml` (gitignored) can be used to build from source while keeping standard `docker compose up` commands
- **Publish script**: `publish-docker.ps1` with built-in retry, DNS pre-check, and post-publish verification

---

## Original ViTransfer Changelog

Entries below are from the original [ViTransfer](https://github.com/MansiVisuals/ViTransfer) project by MansiVisuals (v0.1.0 - v0.8.2).
ViTransfer-TVP forked from v0.8.2 and has since diverged significantly.

## [0.8.2] - 2025-12-24

### Fixed
- Share pages: video sidebar now fills the full visible height consistently (including admin share view)

## [0.8.1] - 2025-12-24

### Changed
- Admin UI spacing tightened and made consistent across pages; grid view is now the default (with improved mobile layouts)
- Analytics + security dashboards condensed overview metrics into single cards and reduced filter UI height
- Share pages: removed footer, moved shortcuts button below the comment field, corrected shortcuts list, and added Ctrl+/ to reset speed to 1x

## [0.8.0] - 2025-12-21

### Added
- Multiple asset upload queue with concurrent upload support
  - Upload multiple assets at once with progress tracking
  - Support for mixed file types (video/image/subtitle) in single selection
  - Auto-detected categories for uploaded files
  - Improved upload queue UI with auto-start functionality
- Analytics improvements for share page tracking
  - Track public share pages with authMode NONE
  - Asset download tracking (individual assets and ZIP downloads)
  - Unified activity feed showing authentication and download events
  - Changed "Accesses" to "Visits" and "Unique Users" to "Unique Visitors"
  - Expandable activity entries with click-to-expand details
  - Display asset filenames in download analytics
- Expanded keyboard shortcuts for video playback with speed control and frame stepping
  - Ctrl+, / Ctrl+. to decrease/increase playback speed by 0.25x (range: 0.25x - 2.0x)
  - Ctrl+J / Ctrl+L to step backward/forward one frame when paused (uses actual video FPS)
  - Speed indicator overlay shows current playback rate when different from 1.0x
  - Shortcuts help button with HelpCircle icon displays all available keyboard shortcuts
- Allow image assets to be set as project thumbnails

### Changed
- Mobile video dropdown now starts collapsed by default and auto-collapses after video selection
  - Added contextual labels: "Tap to select video" when collapsed, "Currently viewing" when expanded
  - Improves mobile UX by prioritizing video player visibility
- Share page authentication UI clarity improvements
  - Added "This authentication is for project recipients only" message
  - Guest button styled with orange (warning) color to stand out
  - Separator text changed from "Or" to "Not a recipient?" for better context
  - Password/OTP fields hidden when OTP code is being entered (BOTH mode)
  - Changed "account" to "recipient" in OTP verification message
- Default sorting set to alphabetical across all pages (projects, videos, versions)
- Replace chevron emoji with Lucide icons throughout UI
- Improved comment reply UI with extended bubble design
- Analytics UI revamped with unified activity feed
  - Removed Access Methods card (redundant with activity feed)
  - Renamed "Recent Access Activity" to "Project Activity"
  - Shows ALL activity with no pagination limit
  - Download events show type (VIDEO/ASSET/ZIP) with appropriate icons
  - Simplified color scheme: blue for visits, green for downloads
  - Improved expanded details layout with clear labels

### Fixed
- TUS upload resume handling and fingerprint detection
  - Fixed fingerprint format to match library exactly
  - Use absolute URL for TUS endpoint to fix fingerprint matching
  - Prevent TUS from resuming uploads to wrong video/project
- Upload queue auto-start bug fixed
- Double tracking for NONE projects with guest mode
  - Only track as NONE when guest mode is disabled
  - When guest mode enabled, let guest endpoint track as GUEST
- TypeScript error: Added NONE to access method types

### Security
- Updated Next.js to fix security vulnerabilities
- Session invalidation now triggered when security settings change
  - Password changes invalidate all project sessions
  - Auth mode changes (NONE/PASSWORD/OTP/BOTH) invalidate all project sessions
  - Guest mode changes invalidate all project sessions
  - Guest latest-only restriction changes invalidate all project sessions
  - Uses Redis-based session revocation with 7-day TTL
  - Deterministic sessionIds for NONE auth mode based on IP address
  - Invalid tokens handled appropriately based on auth mode (reject for PASSWORD/OTP/BOTH, allow for NONE)
  - Optimized database queries with single fetch for all security checks
  - Comprehensive logging shows all changed security fields

## [0.7.0] - 2025-12-07

### Changed
- IP and domain blocklists moved into Security Settings with dedicated management UI, inline add/remove, and loading states; Security Events page now focuses on event history and rate limits only
- Rate limit controls refreshed automatically on load and lay out responsively alongside filters and actions

### Fixed
- Admin project view now updates comments immediately when new comments are posted, avoiding stale threads until the next full refresh
- Hotlink blocklist forms stack cleanly on mobile and include clearer lock expiration messaging in rate limit details

## [0.6.9] - 2025-12-07

### Fixed
- OTP-only projects now correctly display name selection dropdown in comment section
- Recipients API now returns data for all authenticated modes (PASSWORD, OTP, BOTH, NONE), not just password-protected projects
- Security dashboard blocklist forms no longer overflow on mobile devices
- Blocklist item text (IP addresses and domains) now wraps properly on small screens

### Changed
- Removed admin session detection from public share page for cleaner code separation
- Public share page now treats all users (including admins) as clients - admins should use dedicated admin share page
- Made `adminUser` parameter optional in comment management hook for better backwards compatibility
- Improved responsive layout for security blocklist UI (stacks vertically on mobile, horizontal on desktop)

### Technical
- Updated share API route to include recipients for all non-guest authenticated users
- Added `flex-col sm:flex-row` responsive classes to blocklist forms
- Added `min-w-0`, `break-all`, and `wrap-break-word` classes to prevent text overflow in blocklist items
- Made `adminUser` optional with default `null` value in `useCommentManagement` hook

## [0.6.8] - 2025-12-06

### Fixed
- Public share page comment system: real-time updates now work without manual refresh
- Comment name selection: custom names and recipient selections now persist across comment submissions via sessionStorage
- Comment display: removed version label (v1, v2, etc.) from comment header while preserving version filtering logic

## [0.6.7] - 2025-12-06

### Added
- Security dashboard overhaul with event tracking, rate-limit visibility/unblock, and IP/domain blocklists (UI + APIs). Migration: `20251206000000_add_ip_domain_blocklists`.
- Share auth logging: successful password and guest access now generate security events.
- Keyboard shortcut: Ctrl+Space toggles play/pause even while typing comments.
- FPS now shown in admin video metadata; video list displays custom version labels when available.

### Changed
- Standardized security event labels across admin/share auth (password, OTP, guest, passkey); clear existing security events after upgrading to avoid mixed legacy labels in the dashboard.
- Timecode: full drop-frame support (29.97/59.94) with `HH:MM:SS;FF` parsing/formatting; format hints repositioned and aligned with timecode display; DF/NDF badge removed in favor of contextual hint; format hint sits above the timecode.
- Comment UX: auto-pause video when typing comments; added format hint sizing tweaks; version label shown instead of raw version number in lists.
- Admin share view: fixed optimistic comment persistence when switching videos.

### Fixed
- Comment system: improved optimistic updates/deduping, prevent anonymous comments when a recipient name is required, clear optimistic comments on server responses, and cancel pending notifications on deletion to avoid duplicate emails.

### Security
- Consistent naming for admin/share auth events (password/OTP/guest/passkey); blocklist APIs cached with Redis and invalidated on updates.

## [0.6.6] - 2025-12-05

### Fixed
- **CRITICAL**: Re-fixed file-type ESM import issue in Docker worker
  - Static imports were accidentally reintroduced, breaking the worker again
  - Restored dynamic imports (`await import('file-type')`) for ESM compatibility
  - Static imports cause ERR_PACKAGE_PATH_NOT_EXPORTED error with tsx in Docker
  - Affects asset-processor.ts and video-processor-helpers.ts
  - Worker now starts correctly in Docker environments

## [0.6.5] - 2025-12-05

### Fixed
- **CRITICAL**: Fixed file-type ESM import issue in Docker worker (initial fix)
  - Changed to dynamic imports (`await import('file-type')`) for ESM compatibility
  - Note: This fix was accidentally reverted in working tree, necessitating v0.6.6

## [0.6.4] - 2025-12-05

### Added
- **Share Page Video Sorting**: Sort toggle button for video sidebar (upload date ↔ alphabetical)
  - Default to upload date (newest first)
  - Sort applied within "For Review" and "Approved" sections
  - Works on both public and admin share views
  - Sort button only shows when multiple videos exist

### Fixed
- **Timecode Conversion**: Fix timecode conversion for non-even FPS values (23.98, 29.97)
- **Automatic State Updates**: Approval changes now reflect immediately on share page without page refresh
  - Clear token cache when refreshing project data after approval
  - Video tokens are re-fetched with updated approval status
- **Project Password Handling**: Simplified project password handling in settings
  - Load decrypted password directly for admin users
  - Password field now works like any other setting field
  - Fixed issue where editing other settings required password to be revealed first

### Changed
- Updated Docker base image to node:24.11.1-alpine3.23

### Removed
- Unused `/api/projects/[id]/password` endpoint (functionality merged into main project API)

## [0.6.3] - 2025-12-03

### Added
- **Admin Integrations Page**: New dedicated page announcing upcoming professional NLE integrations
  - DaVinci Resolve Studio and Adobe Premiere Pro integrations coming beginning of 2026
  - Direct timeline comment import, project management, and render/upload workflows
  - Integrations offered as one-time purchase to support continued development
  - Web app remains free and open-source
- **Enhanced Asset Support**: Expanded project asset validation to support DaVinci Resolve formats
  - Added support for .drp (DaVinci Resolve Project), .drt (DaVinci Resolve Template), and .dra (DaVinci Resolve Archive) files
  - Updated file validation logic to recognize professional NLE project formats
- **Timecode Format Migration**: Migrated comment timestamps to standardized timecode format (HH:MM:SS or MM:SS)
  - Introduced comprehensive timecode utility library for parsing and formatting
  - Updated comment display, input, and email notifications to use timecode format
  - Improved readability and professional appearance across all comment interfaces

### Changed
- Navigation updated to include Integrations link in admin header
- Comment sanitization enhanced to preserve timecode format in notifications
- Email templates updated to display timestamps in human-readable timecode format

## [0.6.2] - 2025-12-01

### Fixed
- Stop video player resets when switching videos and align the admin share layout with the public share view.
- Bind fallback share tokens to the correct session and reduce token churn on share pages to avoid unexpected access denials.
- Preserve custom thumbnail assets during reprocess and when deleting older versions so copied thumbnails stay valid; keep shared thumbnail files intact when deleting a video if other assets or videos still reference the same storage path.
- Allow admins to download original files via the content endpoint even before approval; admin panel downloads avoid popups and stay responsive.
- Exclude admin activity from analytics and tag admin download sessions to keep metrics clean.

### Changed
- Stream/download pipeline tuned for reliability and speed: streaming chunks capped at 4MB, download chunks capped at 50MB, full-file downloads when no Range header is sent, and downloads trigger without opening new tabs.
- Admin/download UX and performance improvements: faster downloads, responsive UI, safer chunking, and admin download tagging.
- Token revocation TTL handling tightened to avoid stale tokens.

## [0.5.5] - 2025-11-22

### Added
- Consistent footer branding across application
  - Admin layout footer with "Powered by ViTransfer" branding
  - Mobile footer on share page with version display
  - Video sidebar footer for consistent branding
  - Standardized version display format across all footers

### Security
- Fix timing attack in login by adding dummy bcrypt for non-existent users
- Implement refresh token rotation to prevent replay attacks
- Add protocol-aware origin validation respecting x-forwarded headers

## [0.5.4] - 2025-11-22

### Refactored
- Email system with unified template engine
  - Unified email template engine for easier maintenance
  - Consolidated all email types into single reusable component
  - Maintained clean, professional design aesthetic
  - Reduced codebase complexity (135 fewer lines)

## [0.5.3] - 2025-11-21

### Fixed
- Custom thumbnail fallback: when admin deletes an asset being used as a video thumbnail, the system now automatically reverts to the worker-generated thumbnail instead of leaving the video without a thumbnail

### Improved
- Share page performance: removed unnecessary 30-second polling interval that was repeatedly fetching project data
- Content Security Policy now conditionally includes upgrade-insecure-requests only when HTTPS is enabled (fixes local development)
- Thumbnail cache control headers now prevent caching (no-store) for immediate updates when thumbnails change

### Security
- Updated glob dependency from 11.0.4 to 11.1.0 (fixes CVE-2025-64756)
- Asset deletion now uses reference counting to prevent deletion of files shared between video versions

## [0.5.2] - 2025-11-21

### Added
- Real-time password validation UI with inline feedback
  - Shows requirements as you type (8+ chars, one letter, one number)
  - Green checkmarks for met requirements, grey for pending
  - Applied to both new project creation and settings pages

### Security
- Rate limiting on auth refresh endpoint (8 requests/minute per token)
- Rate limiting across all API routes
- Zod schema validation for request payloads
- Standardized authentication using requireApiAdmin helper
- Session timeout monitoring improvements

### Fixed
- Video player version switching now loads videos and thumbnails correctly
  - Separated URL state update from reload logic
  - Added key prop to force proper video element remount
- Thumbnail selection indicator shows green for active, grey for inactive
- Password generator guarantees letter + number requirements
- Thumbnail category preserved when copying assets between versions
- Share password validation with proper Zod schema and error messages

### Removed
- Unused `/api/cron/cleanup-uploads` endpoint

## [0.5.1] - 2025-11-20

### Fixed
- Password visibility in project settings (broken after password API refactor)
- Password field now loads on-demand when eye icon clicked
- Uses secure /api/projects/[id]/password endpoint with rate limiting

### Improved
- Password field UI text clarity
- Placeholder changed to "Enter password for share page"
- Help text updated to "Clients will need this password to access"

## [0.5.0] - 2025-11-20

### Why 0.5.0?
Major codebase refactoring with security hardening and architecture improvements. Total changes: 2,350 lines added, 1,353 lines removed across 41 files.

### Added
- Project password API endpoint for authenticated admins
- Asset copy/move between video versions with batch operations
- Asset thumbnail management (set any image as video thumbnail)
- Comprehensive asset validation with category-based rules
- Separate asset processor worker with magic byte validation

### Fixed
- Asset worker integration (assets now properly queued for processing)
- File validation rejecting valid uploads (relaxed MIME validation at API level)
- Missing security-events module import
- TypeScript null to undefined type conversions

### Refactored
- **Video Processor**: 406 → 96 lines (76% reduction)
  - Extracted 8 helper functions to video-processor-helpers.ts
  - Eliminated magic numbers with named constants
  - Reduced nesting depth from 5 to 2 levels
- **Comments API**: 340 → 189 lines (44% reduction)
  - Extracted 5 helper functions to comment-helpers.ts
  - Separated validation, sanitization, and notification logic
- Share/Content API consolidated with reduced duplication

### Security
- Enhanced FFmpeg watermark validation (strict whitelist, 100 char limit)
- Two-layer asset validation (API extension check + worker magic bytes)
- Defense-in-depth: lenient API validation + strict worker validation

### Improved
- Worker architecture (excluded from Next.js build, cleaner separation)
- Asset management UX (redesigned components with better feedback)
- Centralized project access control logic

## [0.4.0] - 2025-11-19

### Why 0.4.0?
Previous releases (0.3.5-0.3.7) added major features using patch increments. Now that features are complete and stable, bumping to 0.4.0 reflects the accumulated feature additions. This release focuses on bug fixes and quality-of-life improvements to make the feature-complete 0.3.7 release production-ready.

### Fixed
- Guest mode settings now persist correctly when disabled
- Guest mode properly enforces restricted access when enabled
- Authentication logic refactored for reliability and maintainability
- Global watermark settings now inherited by new projects
- Password validation for PASSWORD/BOTH authentication modes
- Mobile UI layout issues with video titles and action buttons
- Video metadata display on mobile (duration/resolution/size)
- Version label truncation on long names

### Improved
- Back buttons now left-aligned and more compact
- Video list layout consistent across desktop and mobile
- Info button hidden for guests
- Security recommendation when disabling guest mode
- Cleaner authentication flow following best practices

## [0.3.7] - 2025-11-18

### Added
- **Video Asset Management System**
  - Upload/download functionality for approved videos
  - Asset management UI (upload modal, list view, download modal)
  - Per-project allowAssetDownload setting
  - Asset download restricted to approved videos only
  - ZIP download support for multiple assets
- **Guest Mode**
  - Guest access for share pages with view-only permissions
  - Guest entry button on authentication screen
  - Auto-entry as guest when authMode is NONE and guestMode enabled
  - Guest sessions persist across page refreshes
  - Guest latest-only restriction (toggle to limit guests to latest video version)
  - Database-level filtering for guest security
  - Guest info hidden in API responses
  - Rate limiting on guest endpoint (20 requests/minute)
- **Global Video Processing Settings**
  - Default watermark enabled toggle in global settings
  - Watermark text input shows only when watermarks enabled
  - Settings persist and apply to new projects
- **Authentication Mode Support**
  - Per-project authMode setting (PASSWORD/PASSKEY/BOTH)
  - Flexible authentication options per project

### Improved
- Mobile VideoList layout now matches desktop appearance
- Share page authentication and access control enhanced
- Admin UI components refactored for consistency
- Redis handling improved with static imports (no dynamic imports)
- API response sanitization for guest sessions

### Fixed
- Redis sismember return type handling (returns number, not boolean)

### Security
- Guest sessions marked in Redis with guest_session key

### Database Migration
- Added guestMode and guestLatestOnly fields to Project schema
- Added authMode field to Project schema
- Added allowAssetDownload field to Project schema
- Added defaultWatermarkEnabled to Settings table
- Created VideoAsset model for asset management

## [0.3.6] - 2025-11-17

### Added
- **Health Check Endpoint** (`/api/health`)
  - Public endpoint for Docker health checks and monitoring systems
  - Tests database and Redis connectivity
  - Returns minimal information (no version or config exposure)
  - No authentication required for health monitoring
  - Replaces deprecated `/api/settings/public` endpoint
- **Database Performance Improvements**
  - Added indexes on Video table for status queries
  - Migration: `20251117000000_add_video_status_indexes`

### Improved
- **Security Events UI Consistency**
  - Replaced HTML disclosure triangle with Lucide ChevronRight icon
  - Standardized font sizes across all admin sections
  - Consistent text sizing with Analytics and Projects pages
  - Better mobile experience with proper SVG icons
  - Smooth rotation animation on details expand/collapse
- **Admin Interface Typography**
  - Unified font sizes: `text-sm` for titles and descriptions
  - `text-xs` for timestamps and labels (consistent with Analytics)
  - Improved readability across desktop and mobile

### Removed
- Deprecated `/api/settings/public` endpoint (replaced by `/api/health`)

## [0.3.5] - 2025-11-16

### Security
- **Resolved 4 HIGH severity Go CVEs** in esbuild dependency
  - Upgraded esbuild from 0.25.12 to 0.27.0 via npm overrides
  - Fixed CVE-2025-58188, CVE-2025-61725, CVE-2025-58187, CVE-2025-61723
  - Reduced total CVE count from 0C 5H 7M 2L to 0C 1H 6M 2L
  - All Go CVEs resolved - esbuild now compiled with patched Go 1.25.4
- Updated Docker base image to node:25.2.0-alpine3.22
- Updated SECURITY.md with current CVE status
  - Removed all fixed Go CVEs
  - Added curl CVE-2025-10966
  - All remaining CVEs are in Alpine/npm packages awaiting upstream fixes

### Improved
- UI consistency across admin interface
  - Standardized form styling and spacing
  - Improved visual consistency in user management
  - Better alignment of UI elements

## [0.3.4] - 2025-11-16

### Added
- **OTP (One-Time Password) Authentication** - Alternative authentication method for share links
  - Modern 6-box OTP input component with auto-focus and keyboard navigation
  - Automatic paste support for codes from email or SMS
  - Configurable via per-project authMode setting (password, OTP, or both)
  - Requires SMTP configuration and at least one recipient
  - Integrates with existing rate limiting and security event logging
  - OTP codes are 6-digit, expire after 10 minutes, and are one-time use only
  - Stored securely in Redis with automatic cleanup
  - Email delivery with professional template including OTP code
- Centralized Redis connection management (`src/lib/redis.ts`)
  - Singleton pattern for consistent connection handling
  - `getRedis()` and `getRedisConnection()` functions
  - Replaces 6 duplicate Redis connection implementations
- Centralized comment sanitization (`src/lib/comment-sanitization.ts`)
  - `sanitizeComment()` function for consistent PII removal
  - Used across all comment API routes
  - Prevents email/name exposure to non-admins
- OTPInput component for user-friendly code entry
  - Individual boxes for each digit with auto-advance
  - Paste support that distributes digits across boxes
  - Backspace support with smart cursor movement
  - Arrow key navigation between boxes

### Changed
- Authentication session storage now supports multiple projects simultaneously
  - Changed from single project ID to Redis SET for auth sessions
  - Changed from single project ID to Redis SET for video access sessions
  - Add projects to session SET instead of overwriting single value
  - Refresh TTL on each project access to maintain active sessions
  - Update validation to use SISMEMBER instead of exact match
  - Each project still requires authentication before being added to session
- Comment section height increased from 50vh to 75vh (150% larger display area)
- Authentication Attempts setting now applies to both password and OTP verification
- Rate limiting now reads max attempts from Settings instead of hardcoded values
- `verifyProjectAccess()` now supports authMode parameter for flexible authentication
- Company Name validation now properly allows empty strings
  - Changed minimum length from 1 to 0 characters
  - Fixes validation mismatch where UI shows field as optional but validation required it
  - Updated in createProjectSchema, updateProjectSchema, and updateSettingsSchema

### Fixed
- **CRITICAL**: Multi-project session conflicts resolved
  - Opening a second project no longer breaks access to the first project
  - Video playback and comments work correctly across all authenticated projects
  - Session state properly maintained when switching between projects
- Comment section auto-scroll behavior improved
  - Now works correctly for both admin and client users
  - Fixed page-level scroll issue by using scrollTop instead of scrollIntoView
  - Auto-scroll only affects comments container, not entire page
  - Prevents page jumping when switching video versions or when new comments appear
- Recipient change callback keeps project settings page in sync with recipient updates

### Improved
- Code maintainability with major refactoring following DRY principles
  - Removed 241 lines of dead/duplicate code
  - Centralized Redis connection management
  - Consolidated duplicate comment sanitization logic
  - Flattened deep nesting in getPasskeyConfigStatus()
- Authentication UI with more concise and helpful messages
- Security event logging now tracks OTP attempts and rate limiting

### Removed
- Duplicate Redis connection implementations across 6 files
- Duplicate sanitizeComment() functions from 3 API route files
- `src/lib/api-responses.ts` (85 lines, unused)
- `src/lib/error-handler.ts` (156 lines, unused)

### Database Migration
- Added authMode field to Project table (password, OTP, or both)

## [0.3.3] - 2025-11-15

### Added
- **PassKey/WebAuthn Authentication** - Modern passwordless login for admin accounts
  - Usernameless authentication support (no email required at login)
  - Multi-device support with auto-generated device names (iPhone, Mac, Windows PC, etc.)
  - Per-user PassKey management in admin user settings
  - Built with SimpleWebAuthn following official security patterns
  - Challenge stored in Redis with 5-minute TTL and one-time use
  - Replay attack prevention via signature counter tracking
  - Comprehensive security event logging for all PassKey operations
  - Rate limiting on authentication endpoints
  - Strict domain validation (production requires HTTPS, localhost allows HTTP)
  - Configuration via Settings.appDomain (no environment variables needed)

### Changed
- Restore SMTP password reveal functionality (reverted to v0.3.0 behavior)
  - Admin-authenticated GET /api/settings now returns decrypted SMTP password
  - Eye icon in password field works normally to show/hide actual password
  - Removed unnecessary placeholder logic for cleaner implementation
- Smart password update logic prevents unnecessary database writes
  - SMTP password only updates if value actually changes
  - Project share password only updates if value actually changes
  - Prevents unnecessary session invalidations when password unchanged

### Fixed
- SMTP password no longer lost when saving other settings
- Project password updates now properly compare with current value before updating
- Session invalidation only triggered when password actually changes

### Security
- PassKey authentication endpoints protected with rate limiting
- Generic error messages prevent information disclosure
  - Client sees: "PassKey authentication failed. Please try again."
  - Server logs detailed error for debugging
- All PassKey operations require admin authentication (except login)
- Session invalidation on password change prevents race conditions

### Database Migration
- Added PasskeyCredential model for WebAuthn credential storage
  - credentialID (unique identifier)
  - publicKey (verification key)
  - counter (replay attack prevention)
  - transports (USB, NFC, BLE, internal)
  - deviceType (single-device or multi-device)
  - backedUp (synced credential indicator)
  - aaguid (authenticator identifier)
  - userAgent and credentialName (device tracking)
  - lastUsedAt and lastUsedIP (security monitoring)

## [0.3.2] - 2025-11-14

### Added
- Comment UI with color-coded message borders and improved visual contrast
- HTTPS configuration support
- Unapprove functionality
- Build script: optional --no-cache flag support

### Changed
- Settings UX improvements
- Project approval logic fixes
- Security settings enhancements

## [0.3.1] - 2025-01-13

### Security
- Add runtime JWT secret validation to prevent undefined secret usage
- Fix fingerprint hash truncation (use full 256-bit SHA-256 instead of 96-bit)
- Add CRLF injection protection for companyName field in email headers
- Strengthen FFmpeg watermark escaping with defense-in-depth approach
- Implement reusable Content-Disposition header sanitization for file downloads
- Add rate limiting to admin endpoints (batch ops, approve/unapprove, users)
- Add batch operation size limits (max 100 items)
- Fix SMTP password exposure in API responses (return placeholder)

### Added
- Per-project companyName field in project creation and settings
- Display priority: companyName → Primary Recipient → "Client"
- Timezone-aware date/time formatting using Intl.DateTimeFormat
  - Client-side: uses browser timezone for proper user localization
  - Server-side: uses TZ environment variable for emails/logs/workers
  - Format adapts based on region (MM-dd-yyyy, dd-MM-yyyy, yyyy-MM-dd)

### Changed
- Update all pages to show companyName with fallback logic
- Update share API to use companyName in clientName field
- Replace toLocaleString() with formatDateTime() for consistency
- Hide recipient email when companyName is set for cleaner display
- Improve comment name picker UX (starts at "Select a name..." instead of pre-selected)

### Fixed
- Correct product name from "VidTransfer" to "ViTransfer" throughout codebase
- Fix TypeScript build errors related to Buffer type annotations in streams
- Revert incorrect project ownership validation (admins see all projects)

## [0.3.0] - 2025-11-13

**Why v0.3.0?** Originally planned as v0.2.6, this release includes critical security hardening that warrants a minor version bump rather than a patch. The scope of security improvements (SQL injection prevention, XSS protection enhancement, command injection fixes, timing attack mitigation, and path traversal hardening) makes this a significant security-focused upgrade.

### Security
- **CRITICAL**: Fixed SQL injection vulnerability in database context management
  - Added strict CUID format validation (`/^c[a-z0-9]{24}$/`) before executing raw SQL
  - Added UserRole enum validation to prevent arbitrary role injection
  - Prevents malicious user IDs from bypassing Row Level Security (RLS)
  - Location: `src/lib/db.ts:setDatabaseUserContext()`
- **CRITICAL**: Enhanced XSS protection in comment rendering
  - Configured DOMPurify with strict ALLOWED_TAGS whitelist
  - Added ALLOWED_URI_REGEXP to only allow https://, http://, mailto: URLs
  - Enabled FORCE_BODY to prevent context-breaking attacks
  - Added rel="noopener noreferrer" to all links automatically
  - Location: `src/components/MessageBubble.tsx:sanitizeContent()`
- **CRITICAL**: Fixed command injection in FFmpeg watermark processing
  - Created dedicated `validateAndSanitizeWatermarkText()` function
  - Validates character whitelist (alphanumeric, spaces, safe punctuation only)
  - Enforces 100 character limit to prevent resource exhaustion
  - Properly escapes text for FFmpeg drawtext filter
  - Location: `src/lib/ffmpeg.ts`
- **CRITICAL**: Fixed timing attack vulnerability in password verification
  - Implemented constant-time comparison using `crypto.timingSafeEqual()`
  - Prevents password enumeration through timing analysis
  - Maintains constant execution time even when lengths differ
  - Location: `src/app/api/share/[token]/verify/route.ts:constantTimeCompare()`
- **HIGH**: Added robust JSON.parse error handling in video access tokens
  - Gracefully handles corrupted Redis data without crashing
  - Validates required fields (videoId, projectId, sessionId) after parsing
  - Logs security events with sanitized token preview (first 10 chars only)
  - Location: `src/lib/video-access.ts:verifyVideoAccessToken()`
- **HIGH**: Enhanced path traversal protection with 7-layer defense
  - Layer 1: Null byte injection check
  - Layer 2: Double URL decoding (catches `%252e%252e%252f` attacks)
  - Layer 3: Path separator normalization
  - Layer 4: Explicit `..` sequence removal
  - Layer 5: Path normalization
  - Layer 6: Absolute path resolution
  - Layer 7: Boundary validation (ensure path is within STORAGE_ROOT)
  - Location: `src/lib/storage.ts:validatePath()`
- **Code Quality**: Removed 51KB of duplicate component files
  - Deleted: AdminVideoManager 2.tsx, LoginModal 2.tsx, VideoPlayer 2.tsx, VideoUpload 2.tsx
  - Eliminates maintenance burden and potential inconsistencies

### Added
- **Complete Email Notification System** (originally planned for future release, delivered now!)
  - Configurable notification schedules: Immediate, Hourly, Daily, Weekly
  - Email notification summaries to reduce spam (batches updates by schedule)
  - Separate admin and client notification settings per project
  - Per-recipient notification preferences with opt-in/opt-out toggles
  - Notification queue system with automatic retry logic (3 attempts, permanent failure tracking)
  - BullMQ repeatable jobs for scheduled summary delivery (every minute check)
  - Professional email templates with project context and direct share links
  - Unified notification flow for all comment types (client comments, admin replies)
- **Per-Video Revision Tracking**
  - Track revision count per video (not just per project)
  - Better control over individual video approval cycles
  - Maintains project-wide revision limits while tracking per video
- Sort toggle for projects dashboard (status/alphabetical sorting)
- Sort toggle for project videos and versions (status/alphabetical sorting)
- Section dividers in share page sidebar (For Review / Approved sections)
- Green check mark icon for approved videos in sidebar (replaces play icon)
- New `formatDate()` utility for consistent date formatting (11-Nov-2025 format)
- **DEBUG_WORKER environment variable** for optional verbose logging

### Changed
- **BREAKING**: All comments must now be video-specific (general comments removed)
- Email notifications now fully functional with flexible scheduling
- Share page sorting now checks if ANY version is approved (not just latest)
- Video groups in admin panel sorted by approval status (unapproved first)
- Versions within groups sorted by approval status (approved first)
- Projects list extracted to client component for better performance
- README development warning now includes 3-2-1 backup principle
- All recipient IDs migrated from UUID to CUID format for consistency
- All dates now display in consistent "11-Nov-2025" format

### Removed
- General/system comments (all comments must be attached to a video)
- System audit comments for approval/unapproval actions (status tracked in database)
- Old per-comment email notification system (replaced with unified notification queue)
- Duplicate component files (AdminVideoManager 2.tsx, LoginModal 2.tsx, VideoPlayer 2.tsx, VideoUpload 2.tsx)

### Improved
- Comment section approval updates now instant (optimistic UI updates)
- Share page filtering refreshes immediately on approval state changes
- Comment/reply updates appear instantly without page refresh
- Optimistic updates for comment replies (no loading delays)
- Admin comment version filtering on share page more accurate
- Feedback & Discussion section updates immediately on approval changes
- Approved badge spacing in admin panel
- "All Versions" section spacing from content above
- Analytics projects card spacing to prevent overlap
- Version labels padding to prevent hover animation cutoff
- Mobile inline editing no longer overflows with action buttons
- Simplified comment filtering logic (no more null videoId checks)

### Fixed
- **CRITICAL**: Thumbnail generation failing for videos shorter than 10 seconds
  - Previously hardcoded to seek to 10s, causing EOF for short videos
  - Now calculates safe timestamp: 10% of duration (min 0.5s, max 10s)
- Comment section not updating when approval status changes
- Share page filtering not refreshing after approval/unapproval
- Instant comment/reply updates not working correctly
- Optimistic updates for comment replies failing
- Feedback & Discussion section not updating on approval changes
- Admin comment version filtering on share page
- Projects dashboard now loads correctly after refactoring
- Mobile overflow when editing video/group names
- Version label hover animation cutoff at top of container

### Database Migration
- Added notification schedule fields to Settings table (admin-wide defaults)
- Added notification schedule fields to Project table (per-project overrides)
- Added notification day field for weekly schedules
- Added lastAdminNotificationSent and lastClientNotificationSent timestamps
- Created NotificationQueue table for batched email delivery with retry tracking
- Added ProjectRecipient.receiveNotifications boolean field
- Added per-video revision tracking fields
- **IRREVERSIBLE**: Deleted all existing general comments (where videoId IS NULL)
- Made Comment.videoId field required (NOT NULL constraint)
- **IRREVERSIBLE**: Migrated all UUID format recipient IDs to CUID format

## [0.2.5] - 2025-11-12

### Added
- **DEBUG_WORKER environment variable**
  - Optional verbose logging for FFmpeg and worker operations
  - Logs command execution, process IDs, exit codes, timing breakdowns
  - Shows download/upload speeds, file sizes, processing time breakdown
  - Controllable without rebuilding Docker image (set env var and restart)
  - Helps diagnose video processing issues in production

### Fixed
- **CRITICAL**: Thumbnail generation failing for videos shorter than 10 seconds
  - Previously hardcoded to seek to 10 seconds, causing EOF for short videos
  - Now calculates safe timestamp: 10% of duration (min 0.5s, max 10s)
  - FFmpeg properly reports when no frames available for extraction

## [0.2.4] - 2025-11-10

### Added
- Auto-approve project setting with toggle in global settings

### Changed
- "Final Version" renamed to "Approved Version"
- Admin footer solid background, fixed at bottom on desktop
- Video information dialog clarifies it shows original video metadata
- Videos sorted by approval status (unapproved first)
- Mobile video selector now starts collapsed

### Improved
- Settings pages show save/error notifications at bottom for better mobile/long page UX
- Simplified video preview note text
- Comment section height and scrolling behavior

### Fixed
- Recipient name selector jumping to first option
- Mobile sidebar collapsing when selecting videos
- Share page auto-scrolling issues

## [0.2.3] - 2025-11-09

### Fixed
- Recipient name selector jumping back to first option when selecting another recipient

## [0.2.2] - 2025-11-09

### Fixed
- Validation error when creating projects without password protection
- Validation error when creating projects without recipient email

## [0.2.1] - 2025-11-09

### Fixed
- Docker entrypoint usermod timeout removed - allows natural completion on all platforms
- Clean startup output without false warning messages

### Added
- Version number now displays in admin footer
- Build script passes version to Docker image at build time

## [0.2.0] - 2025-11-09

### Added
- Multiple recipient support for projects (ProjectRecipient model)
- Recipient management UI in project settings (add, edit, remove)
- Primary recipient designation for each project
- Projects sorted by status on admin dashboard (In Review → Share Only → Approved)

### Changed
- Migrated from single clientEmail/clientName to multi-recipient system
- All notifications sent to all recipients
- Improved notification messages with recipient names

### Removed
- Legacy clientEmail and clientName fields from Project model

### Improvements
- Code refactoring for better maintainability and reusability
- Security enhancements

### Note
Future v0.2.x releases will include notification system changes (configurable email schedules and summary notifications)

## [0.1.9] - 2025-11-07

### Added
- Configurable session timeout for client share sessions (Security Settings)
- Password visibility toggle in project settings (show/hide share password)
- Configurable APP_HOST environment variable for Docker deployments
- Right-click download prevention on video player for non-admin users

### Fixed
- Project deletion now properly removes all folders and files
- Client names now persist correctly after page refresh
- Docker health check endpoint for K8s/TrueNAS compatibility
- TypeScript null handling for client names in comment routes
- Password field UI consistency across the application

### Improved
- Password input fields now use consistent PasswordInput component with eye icon
- Share page password field layout matches SMTP password field
- Security settings with real-time feedback for timeout values

## [0.1.6] - 2025-11-01

### Added
- Video reprocessing when project settings change
- Drag and drop for video uploads
- Resizable sidebar on share page

### Fixed
- Mobile video playback performance
- Upload cancellation deletes video records
- Share page viewport layout and scaling

### Improved
- Progress bar animations with visual feedback
- Sidebar sizing (reduced to 30% max width)

## [0.1.0] - 2025-10-28

### Initial Release

#### Features
- 📹 **Video Upload & Processing** - Automatic transcoding to multiple resolutions (720p/1080p)
- 💧 **Watermarking** - Customizable watermarks for preview videos
- 💬 **Timestamped Comments** - Collect feedback with precise video timestamps
- ✅ **Approval Workflow** - Client approval system with revision tracking
- 🔒 **Password Protection** - Secure projects with client passwords
- 📧 **Email Notifications** - Automated notifications for new videos and replies
- 🎨 **Dark Mode** - Beautiful dark/light theme support
- 📱 **Fully Responsive** - Works perfectly on all devices
- 👥 **Multi-User Support** - Create multiple admin accounts
- 📊 **Analytics Dashboard** - Track page visits, downloads, and engagement
- 🔐 **Security Logging** - Monitor access attempts and suspicious activity
- 🎯 **Version Management** - Hide/show specific video versions
- 🔄 **Revision Tracking** - Limit and track project revisions
- ⚙️ **Flexible Settings** - Per-project and global configuration options

#### Security
- 🔐 **JWT Authentication** - Secure admin sessions with 15-minute inactivity timeout
- 🔑 **AES-256 Encryption** - Encrypted password storage for share links
- 🛡️ **Rate Limiting** - Protection against brute force attacks
- 📝 **Security Event Logging** - Track all access attempts
- 🚫 **Hotlink Protection** - Prevent unauthorized embedding
- 🌐 **HTTPS Support** - SSL/TLS for secure connections
- ⏱️ **Session Monitoring** - Inactivity warnings with auto-logout

#### Technical
- 🐳 **Docker-First** - Easy deployment with Docker Compose
- 🚀 **Next.js 15 + React 19** - High performance modern stack
- 📦 **Redis Queue** - Background video processing with BullMQ
- 🎬 **FFmpeg Processing** - Industry-standard video transcoding
- 🗄️ **PostgreSQL Database** - Reliable data storage
- 🌐 **TUS Protocol** - Resumable uploads for large files
- 🏗️ **Multi-Architecture** - Support for amd64 and arm64

---

## Release Notes

### Version Tagging
Starting with v0.1.0, Docker images are tagged with both version numbers and "latest":
- `simbamcsimba/vitransfer-app:latest` - Application server image
- `simbamcsimba/vitransfer-worker:latest` - Worker image (FFmpeg processing)


