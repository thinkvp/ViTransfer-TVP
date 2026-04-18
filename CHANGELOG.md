# Changelog

All notable changes to ViTransfer-TVP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] - 2026-04-18

### Added
- **BAS lodgement documents** — a new "Lodgement Documents" card on the BAS period detail page lets you upload, download, and delete file attachments (e.g. ATO lodgement confirmation PDFs) directly against a BAS period; files are stored under the accounting storage volume at `<FY>/BAS/`; a new API route `POST /api/admin/accounting/bas/[id]/attachments` handles uploads and the existing shared attachment download/delete routes serve the files
- **Stripe payments backfilled into SalesPayment table** — existing `SalesInvoiceStripePayment` records are backfilled into the `SalesPayment` table (source `STRIPE`, `excludeFromInvoiceBalance = true`) via a new migration; going forward the Stripe webhook creates a `SalesPayment` record on each successful checkout so that Stripe income is visible in BAS cash-basis calculations and cash-receipts reports through a single, consistent query path

### Changed
- **BAS/GST amounts now round down to whole dollars** — all BAS figures displayed on the BAS detail page and exported to CSV are now truncated (floor) to the nearest whole dollar rather than rounded to nearest; this ensures amounts are never overstated, which is the conservative approach required for ATO reporting
- **Cash-basis BAS and sales-receipts queries unified** — `listSalesCashReceiptsInRange`, `listSalesCashReceiptsUpTo`, and the BAS `calculateBas` cash-basis path now query only the `SalesPayment` table (matching rows where `excludeFromInvoiceBalance = false` OR `source = STRIPE`), removing the separate `SalesInvoiceStripePayment` fan-out queries and eliminating a class of double-count bugs
- **Account attachment files migrated when account is renamed** — renaming an account via `PUT /api/admin/accounting/accounts/[id]` now moves all existing receipt files for that account (and its direct children, whose path includes the parent name segment) into the updated folder path on the accounting storage volume

## [1.5.0] - 2026-04-18

### Added
- **BAS detail page redesigned to match ATO form layout** — the BAS Calculation card is replaced with a structured table that mirrors the official ATO Business Activity Statement form; rows are grouped into labelled sections (GST, PAYG Withholding, Income Tax Instalment, Summary) with a "Line Description", "Line Code" badge, and "Amount" column per row; the PAYG Amounts card that previously appeared only after lodgement is removed and its figures are incorporated directly in the table; the Summary section replaces the old "Net GST Payable / Refund" row with the ATO's own labels — **8A** Amount you owe the ATO, **8B** Amount the ATO owes you, and **9** Your payment amount
- **G4 Input Taxed Sales line on BAS** — the BAS table and CSV export now include the **G4 — Input taxed sales** line sourced from `g4InputTaxedSalesCents` on the stored calculation snapshot
- **BAS CSV export matches ATO form columns** — the exported CSV now has three columns (Line Description, Line Code, Amount) and includes all rows visible on the BAS table — G1–G4, G10–G11, 1A, 1B, W2 (if non-zero), T7 (if non-zero), 8A, 8B, and 9 — with amounts rounded to whole dollars per ATO requirements

### Changed
- **BAS amounts rounded to whole dollars** — all amounts shown on the BAS detail page and exported to CSV are now rounded to the nearest whole dollar, removing cents; this matches the ATO's requirement that BAS figures be reported in whole dollars
- **PAYG Instalment field relabelled from T4 to T7** — the income tax instalment input on the BAS detail page is corrected from *"T4 — PAYG Instalment"* to *"T7 — Instalment Amount"* to match the ATO's current BAS form field code
- **P&L report COGS and Expense sections now include bank transactions, journal entries, and split lines** — previously the Cost of Goods Sold and Expenses sections of the Profit & Loss report only aggregated `Expense` records; matched bank transactions posted to COGS or Expense accounts, manually entered journal entries, and their split line components are now also included in the relevant P&L sections, ensuring the report reflects the full double-entry picture for any posting method

## [1.4.9] - 2026-04-18

### Fixed
- **Account ledger "Account" column now shows `— ChildName` for all entry kinds** — when viewing a parent account's ledger, Sales Invoice and Split entries from child accounts were missing the `— AccountName` prefix that Expense, Bank Transaction, and Journal entries already showed; both entry kinds now compare their `accountCode` against the current account's code and render the dash indicator when the entry belongs to a sub-account
- **P&L report parent account rows no longer styled differently** — group-header (parent account) rows on the Profit & Loss report were rendered in full foreground colour and bold, making them visually distinct from child account rows; they are now styled identically to other account rows (muted colour, same font weight); child accounts continue to be indented with extra left padding to maintain the hierarchy
- **Bank Transactions and Expenses CSV/PDF export now includes all records in the date range** — exporting from Bank Transactions or Expenses previously exported only the current visible page; both pages now fetch all matching records (up to 10 000) from the API before building the CSV or triggering the print dialog; the API routes accept a `download=true` parameter that raises the per-request page-size cap accordingly

## [1.4.8] - 2026-04-18

### Added
- **Clickable P&L amounts drill through to account ledger** — each line-item amount on the Profit & Loss report is now a link that opens the corresponding account's ledger page pre-filtered to the same date range that was used to run the report; the `from` and `to` values are passed as query parameters and the account ledger initialises its date range from them on load
- **Edit reconciled expense account and tax code** — reconciled expenses can now have their Account and Tax Code changed from the Edit Expense modal; Date and Amount remain locked; saving a reconciled expense with a changed account or tax code also propagates the change to the linked bank transaction's `accountId` / `taxCode` fields; attachments belonging to the expense are moved to the correct account folder on disk when the account changes

### Changed
- **Chart of Accounts balance column shows ex-GST amounts** — the Balance column on the Chart of Accounts list and the Period Total / per-row amounts on the individual account ledger now show expense amounts excluding GST, consistent with the P&L report; the column header is labelled "Balance (ex-GST)" and the ledger column is labelled "Amount (ex-GST)"
- **Edit Expense info text updated for reconciled lock** — the informational note shown at the top of the Edit Expense modal for reconciled expenses now reads: *"Date and amount are locked for reconciled expenses. You can still update account, tax code, supplier, description, notes, and attachments."*
- **P&L and account ledger clickable amounts use default text colour** — the linked/clickable amounts in the P&L report and the account ledger rows no longer use the primary accent colour; they render in the default foreground colour and only underline on hover

## [1.4.7] - 2026-04-18

### Added
- **GST column on Matched bank transactions** — the Matched tab in Bank Accounts now shows a "GST" column displaying the tax code/rate name (e.g. "GST 10%", "GST Free") for each posted transaction row, giving a quick visual audit trail without expanding the transaction
- **Amount search on Bank Transactions and Expenses** — the description/reference search fields on both the Bank Accounts page and the Expenses list now also match by dollar amount; entering a whole number (e.g. `132`) matches all transactions or expenses whose amount starts with those digits across multiple magnitudes ($132.xx, $1,320.xx, $13,200.xx etc.); entering a decimal (e.g. `132.50`) matches exactly; both credit and debit amounts are matched on the transactions list
- **Bank Transactions search input** — a search box is added next to the tab bar on the Bank Accounts transactions table, allowing free-text filtering by description, reference, or amount across the active tab; the search field clears automatically when switching tabs

### Changed
- **Profit & Loss report shows ex-GST amounts** — all income, COGS, and expense figures on the P&L report are now reported excluding GST; a `"All figures shown ex GST"` note is shown at the top of the report card; bank transaction income lines, journal entry lines, and split lines all pass through a new `amountExcludingGst()` helper that strips the GST component before accumulation; the CSV export column header is updated to `"Amount (ex GST)"`; the Balance Sheet equity calculation likewise switches from `amountIncGst` to `amountExGst` for expense accumulation
- **Profit & Loss report groups lines by parent/child account hierarchy** — income, COGS, and expense rows are now structured hierarchically: parent accounts appear as bold group headers with no amount, and their child accounts are listed below indented; accounts with no activity are hidden; any accounts not belonging to a known parent are appended flat at the end as before; the CSV export preserves the same structure with account codes prefixed to names
- **Profit & Loss report adds COGS and Expenses subtotals** — the Cost of Goods Sold section now shows a "Total Cost of Goods Sold" subtotal row and the Expenses section shows a "Total Expenses" subtotal row; `totalCogsCents` and `totalExpenseCents` are added as explicit fields on the `ProfitLossReport` type
- **Expenses list status filter removed** — the "All statuses" dropdown filter on the Expenses list is removed; filtering by status is handled via the existing search and date range controls; the search input is widened and its placeholder updated to `"Search supplier, description, amount…"`
- **Chart of Accounts type filter removed** — the "All types" account-type dropdown on the Chart of Accounts page is removed; the search input already filters across code and name and the hierarchical grouping makes per-type filtering redundant
- **BAS detail page uses full-width layout** — the `max-w-3xl` container constraint is removed from the BAS period detail page so the form and lodgement cards use the full available width consistent with the rest of the accounting section

### Fixed
- **`NewExpenseDropZone` file-input click did nothing** — the hidden `<input type="file">` was wired with a `useState<HTMLInputElement | null>` pair and a manual `useCallback` ref-setter instead of a plain `useRef`; `fileInputRef[0]` was always `null` so clicking the drop zone never opened the file picker; fixed by replacing the pattern with `useRef<HTMLInputElement | null>(null)` and calling `fileInputRef.current?.click()`

## [1.4.6] - 2026-04-18

### Added
- **Drag-and-drop file attachment on bank transaction posting form** — the "Attach receipt or tax invoice" link on the Pending transactions posting form is replaced with a dashed drop zone that accepts dragged files or a click-to-browse interaction; the zone highlights with a primary-colour tint when a file is dragged over it; queued files are listed with white text and per-file remove buttons consistent with the rest of the attachment UI
- **Drag-and-drop file attachment on `AttachmentsPanel`** — the plain "Add files" button on the shared `AttachmentsPanel` component (used on Posted transaction detail panels and the Edit Expense modal) is replaced with the same dashed drop-zone used on the posting form; drag-over highlighting, disabled-state handling, and error display are all managed internally so every upload surface is consistent without changes to callers
- **Drag-and-drop file attachment on New Expense modal** — the New Expense form's bespoke file `<label>` picker is replaced with a `NewExpenseDropZone` component using the same dashed zone; staged files are shown above the zone with white text and per-file remove buttons matching the posting-form style
- **Expenses list paperclip badge reflects linked bank transaction attachments** — the paperclip icon on each row of the Expenses list now appears when either the expense has its own direct attachments **or** its linked bank transaction has attachments; the list API query is extended with a `_count` sub-select on the bank transaction's `accountingAttachments` relation so no extra round trip is needed, and the `Expense` type gains an optional `linkedTransactionAttachmentCount` field propagated through the DB mapper

### Fixed
- **Accounting file volume `EACCES` errors on all attachment upload routes** — the `accounting-data` Docker named volume was initialised with root ownership before the Dockerfile established `/app/accounting` as `app:app`, causing every `mkdir` call under that path to fail with `EACCES: permission denied`; fixed by re-owning the existing volume contents to UID/GID 911 (`docker run --rm -v vitransfer-tvp_accounting-data:/data alpine chown -R 911:911 /data`); no Dockerfile or Compose changes are required for fresh installs because the image already creates the directory with correct ownership at build time
- **Attachment upload failures on transaction post and expense save were silently ignored** — the `handlePost` loop in the bank-accounts page and the `handleSave` receipt-upload loop in `ExpenseFormModal` both awaited attachment uploads without checking the response status; a server error (such as the `EACCES` above) would complete the post/save action and discard the file silently; both paths now inspect the response, surface the server error message to the user, and halt further uploads on the first failure; the `handleUploadAttachments` path in `ExpenseFormModal` likewise now propagates the error into the visible error state instead of silently skipping failed files

## [1.4.5] - 2026-04-18

### Fixed
- **Bank transaction suggested-account matching now prefers real merchant matches over generic card-feed text** — the previous `GET /api/admin/accounting/transactions/suggest-account` logic still relied on broad raw-description token matching, so boilerplate terms such as location names, `card`, `value`, `date`, and masked card fragments could cause unrelated historical expenses to dominate by frequency; the route now normalizes descriptions, ignores generic bank-feed tokens, extracts a small set of meaningful merchant-like terms, scores recent matched transactions by description similarity, and then ranks accounts by aggregated score instead of simple count; this keeps the lookup lightweight while allowing recurring merchants such as Adobe to resolve to the correct child expense account instead of falling back to a more common but unrelated account like Website

## [1.4.4] - 2026-04-18

### Fixed
- **Suggest-account endpoint now returns correct account for expense-type postings** — when a bank transaction is matched via an `Expense` record the `accountId` lives on the linked expense row, not on `BankTransaction.accountId` (which is `null` for those postings); the `GET /api/admin/accounting/transactions/suggest-account` route was therefore ignoring all expense-matched transactions when building the frequency table; it now expands the match filter to include rows where `expense.isNot: null`, reads the account from `expense.accountId` when present, and constructs the description filter as an `AND` clause to avoid interfering with the new `OR` broadened match; the suggested account is now drawn from the full history of expense and non-expense postings rather than only non-expense ones
- **Running Jobs panel shows version label for Dropbox upload entries** — completed and errored Dropbox upload entries in the Running Jobs panel were labelled with only the video file name; the `versionLabel` field is now fetched alongside the other video fields and appended to the label (e.g. "clip.mp4 v2") so version uploads are distinguishable from the original at a glance

### Security
- **Upgraded `dompurify` to `^3.4.0`** — resolves GHSA-39q2-94rc-95cp (moderate): `ADD_TAGS` form bypass of `FORBID_TAGS` due to short-circuit evaluation in versions ≤ 3.3.3

## [1.4.3] - 2026-04-14

### Changed
- **Docker containers now drop all Linux capabilities** — both the `app` and `worker` services include `cap_drop: ALL` in both Compose files, eliminating the ambient capability set that containers inherit by default; neither service requires any elevated capability at runtime, so removing them reduces the blast radius of any container compromise
- **Docker containers use an init process for correct signal handling** — both `app` and `worker` services now set `init: true`, which injects a minimal init (tini) as PID 1; this ensures SIGTERM is forwarded correctly on `docker compose stop` and that zombie child processes (e.g. spawned ffmpeg or shell subprocesses) are reaped properly
- **Structured log rotation on all services** — all four services (`postgres`, `redis`, `app`, `worker`) now configure the `json-file` logging driver with `max-size: "10m"` and `max-file: "3"`, capping the total log footprint to 30 MB per service and preventing unbounded log growth on long-running hosts

### Fixed
- **Rate limiter key collisions between API endpoints** — the `rateLimit()` calls on `GET /api/client-activity`, `GET /api/running-jobs`, `POST /api/settings/delete-closed-project-previews`, `POST /api/settings/purge-bullmq-jobs`, and `POST /api/settings/purge-notification-backlog` were not passing an explicit key name; without a per-route key, distinct endpoints can share the same Redis counter and trigger each other's limits under concurrent polling; each call now passes a unique string key so rate limit windows are tracked independently per endpoint

## [1.4.2] - 2026-04-14

### Changed
- **Removed `node_modules` from Dockerfile `chmod -R` in both app and worker images** — the production containers run as a non-root UID from Docker Compose and only need read and traverse access to dependency files; `npm ci` installs package files and directories with the normal read and execute bits needed at runtime, so recursively re-granting `a+rX` across the entire `node_modules` tree was redundant in practice and was adding significant time to every image build; writable runtime paths remain handled separately, while the smaller read-only runtime targets (`.next`, `public`, `prisma`, `src`) continue to receive explicit permission normalization
- **Docker images now default to non-root execution** — both app and worker images set `USER app` (UID 911) so containers run unprivileged even without a Compose-level `user:` override; the repository Compose files also explicitly set `user: "911:911"` for consistency
- **Removed legacy `PUID`/`PGID` environment variables** — these were passed into the container but never consumed by the entrypoint or application; removed from Compose files, `.env.example`, setup scripts, and docs; use Compose `user:` to control the runtime UID/GID instead
- **Removed `openssl-dev` from runtime images** — only the `openssl` library is needed at runtime; the development headers added unnecessary attack surface and image size

### Security
- **Upgraded `next` to `^16.2.3`** — addresses known CVEs patched in recent Next.js releases
- **Upgraded `mailparser` to `^3.9.8`** — picks up security and correctness fixes in the mail parsing library
- **Upgraded `nodemailer` to `^8.0.5`** — resolves vulnerabilities identified in the previous minor version

## [1.4.1] - 2026-04-13

### Added
- **Linked bank transaction viewer across accounting tables** — an eye icon button now appears on relevant rows throughout the Accounting section to open a modal showing the full linked bank transaction without leaving the page; the icon appears on expense rows and split-line rows in the account ledger, on sales invoice rows (with a chooser dialog when multiple matched payments exist), and in the Expenses list between the edit and delete actions
- **Edit Expense modal shows linked bank transaction attachments** — when an expense is linked to a bank transaction, a read-only "Linked Bank Transaction" section appears in the Edit Expense modal with a link to view the transaction and a list of the bank transaction's attachments; files in that section can be downloaded in place
- **Accounting Dashboard shows current balance and pending transaction count** — the bank account cards on the Accounting Dashboard now display the live current balance and a count of pending (unmatched) transactions instead of the static opening balance

### Changed
- **Unified accounting table action buttons** — row action buttons across the entire Accounting section (Expenses, Chart of Accounts, BAS, Settings, Bank Transactions) are now styled consistently with the Sales/Invoices pattern: circular outline, icon-only, red trash can for destructive actions
- **Ignored bank transactions desktop view simplified** — the Ignored tab no longer shows Type or Account columns (which are always empty for excluded transactions) and replaces the expand chevron with direct icon-only Undo and Delete action buttons in the row
- **Confirmation required before deleting an expense attachment** — deleting an attachment from the Edit Expense modal now shows a confirmation prompt matching the safeguard already present on Bank Transaction attachments

### Fixed
- **Expenses list paperclip icon updates immediately after editing attachments** — adding or deleting an attachment inside the Edit Expense modal now updates the row's attachment indicator in the list without requiring a full page refresh
- **Project-page Add Task flow now opens and saves reliably** — the Project detail page was passing a prefilled stub task object into the shared Kanban card dialog, which caused the dialog to think it was editing an existing task; the create action therefore mislabeled the modal, omitted the required `columnId` on save, and could also abort silently if optional preload requests failed; new tasks from the Project page now stay in true add-mode, include the correct status column in the POST body, tolerate partial preload failures, and show any create error message instead of failing silently
- **Accounting transaction table sorting now matches the active sort controls** — the Bank Accounts and Expenses pages were re-sorting only the current client-side page after the API returned date-ordered results, which produced inconsistent ordering across pages and incorrect pagination when switching sort columns; both tables now pass the active sort key and direction to their list APIs so sorting happens server-side before pagination
- **Ignored bank transactions immediately shed attachment support** — when a transaction is marked ignored, any existing `AccountingAttachment` records are deleted and their files are removed from disk, the transaction detail panel stops showing an upload control for ignored rows, and the attachment upload API now rejects attempts to attach files to ignored transactions with a conflict response

## [1.4.0] - 2026-04-08

### Fixed
- **Guest share-page videos could stay stuck on loading** — the public share API fix for preview availability was only applied to the authenticated payload shape; the guest-mode serialization path still omitted `preview480Path`, `preview720Path`, and `preview1080Path`, so guest viewers could see videos in the sidebar but never request playback tokens; guest responses now include the same boolean preview-availability flags as the normal share payload
- **Original Videos missing from Project Data storage breakdown when Dropbox is enabled** — when a video is stored on Dropbox, its `originalStoragePath` (and video asset `storagePath`) is saved in the database with a `dropbox:` prefix; the disk-size helper `computeStorageEntrySizeBytes` passed this prefixed path directly to `getFilePath`, which does not understand the `dropbox:` scheme and resolved to a non-existent path, returning 0 bytes; those bytes then surfaced as unaccounted "Other files" instead of "Original Videos"; the helper now strips the `dropbox:` prefix before resolving the local file path so original video and asset sizes are correctly attributed in the Project Data panel

## [1.3.9] - 2026-04-08

### Added
- **Multi-file attachments on Expenses and Bank Transactions** — the previous single-file `receiptPath` / `attachmentPath` columns on `Expense` and `BankTransaction` are replaced by a new `AccountingAttachment` model that supports an unlimited number of files per record; each `AccountingAttachment` row holds a relative `storagePath`, the `originalName`, and a foreign-key to either a bank transaction or an expense (with `ON DELETE CASCADE`); files continue to be stored in `ACCOUNTING_STORAGE_ROOT` using the existing `FY{year}-{year}/<AccountName>/` layout; backed by migration `20260408000000_add_accounting_attachments` (creates the table and indices) and `20260408000002_remove_legacy_attachment_fields` (drops the legacy `receiptPath`, `receiptOriginalName`, `attachmentPath`, and `attachmentOriginalName` columns)
- **`AttachmentsPanel` shared UI component** — a new reusable `<AttachmentsPanel>` component in `src/components/admin/accounting/AttachmentsPanel.tsx` provides a consistent list / download / upload / delete UI for `AccountingAttachment` items; it accepts an `items` array, an optional `canUpload` flag, and async `onUpload` / `onDownload` / `onDelete` callbacks; used in both the new `ExpenseFormModal` and the Bank Accounts transaction detail panel
- **Expense form converted to an inline modal** — the standalone `/admin/accounting/expenses/new` and `/admin/accounting/expenses/[id]` pages are replaced by a new `<ExpenseFormModal>` dialog that opens directly on the Expenses list page without a navigation; both pages now immediately redirect to the list with `?new=1` or `?edit=<id>` query params respectively; the list page reads those params on mount and opens the modal automatically, preserving deep-link compatibility; the modal includes the full form, status badge, Approve and Delete actions, and the multi-file `AttachmentsPanel`
- **Expense entries in the account ledger are clickable to open the edit modal** — on the Chart of Accounts ledger page, clicking the amount cell of an Expense row now opens `ExpenseFormModal` inline (triggering reload of ledger entries on save) rather than navigating to a separate page
- **Browser push notifications for pinned system alert events** — `RATE_LIMIT_ALERT`, `QUICKBOOKS_DAILY_PULL_FAILURE`, `ORPHAN_PROJECT_FILES_SCAN`, and `DROPBOX_STORAGE_INCONSISTENCY` notifications now call `sendBrowserPushToEligibleUsers` when the in-app bell entry is upserted; the four new payload types are added to the `PushNotificationPayload` union; previously these pinned alerts were only visible in the notification bell and did not trigger a browser push

### Changed
- **Bank Accounts post form supports multiple file attachments** — the single-file "Attach receipt or tax invoice" control in the transaction posting form is replaced with a multi-file picker; selected files are listed individually with per-file remove buttons; files are uploaded sequentially to the new `POST /api/admin/accounting/transactions/[id]/attachments` endpoint after posting; the form state field changes from `file: File | null` to `files: File[]`
- **Paperclip badge shown on transaction rows that have attachments** — a `Paperclip` icon appears next to the date in the collapsed transaction row header whenever the transaction has one or more `AccountingAttachment` records, giving a quick visual indicator without expanding the row
- **Account ledger page uses full-width layout** — the page container switches from `max-w-7xl` to `max-w-screen-2xl` and gains responsive horizontal padding (`px-3 sm:px-4 lg:px-6 py-3 sm:py-6`) so wider ledgers on large screens use more of the available space; the `Date` and `Type` table columns are given `whitespace-nowrap` so they do not wrap on smaller viewports

### Fixed
- **Unmatch and undo operations clean up all attachment files** — the unmatch route and the account-ledger delete-entry route previously cleaned up only the single legacy `attachmentPath` / `receiptPath` field; they now query `accountingAttachments` on the transaction and linked expense, collect all `storagePath` values, and delete every file via `deleteAccountingFile` after the database transaction completes
- **Match operation relocates all attachment files into the correct folder** — when a bank transaction that already has `AccountingAttachment` records is matched to an expense, every file is moved from its original upload path into the `FY{year}-{year}/<AccountName>/` folder corresponding to the transaction date and posting account, and the `storagePath` on each `AccountingAttachment` row is updated accordingly; previously only the single legacy `attachmentPath` column was moved

## [1.3.8] - 2026-04-08

### Added
- **PAYG fields on BAS periods** — the BAS detail form gains two new optional dollar fields: **W2 — PAYG Withholding** and **T4 — PAYG Instalment**; when a period is lodged, a summary card displays both values alongside a calculated **Total Amount Payable to ATO** (net GST + W2 + T4); values are stored in the new `paygWithholdingCents` and `paygInstalmentCents` columns on `BasPeriod` (migration `20260407000004_add_bas_payg_payment`)
- **BAS payment recording** — a new **BAS Payment** card on lodged periods allows recording the date, amount, and chart-of-accounts posting account for the ATO payment; saving creates an `APPROVED` `Expense` record (tax code `BAS_EXCLUDED`) linked back to the period via `paymentExpenseId`; the payment can be deleted to reverse the entry; backed by a new `POST/DELETE /api/admin/accounting/bas/[id]/payment` route and four new `BasPeriod` columns (`paymentDate`, `paymentAmountCents`, `paymentNotes`, `paymentExpenseId`)
- **"Match Expense" on Bank Account transactions** — debit transactions in the Pending list now have a **Match Expense** button that opens a search dialog listing all unmatched expenses (DRAFT or APPROVED, not yet linked to a bank transaction); selecting one and confirming links the expense to the transaction and marks it MATCHED; backed by a new `GET /api/admin/accounting/unmatched-expenses` endpoint
- **Quick-match badges for exact-amount invoice and expense matches** — when the Pending tab is active the page eagerly loads all open invoices and unmatched expenses; any transaction whose amount exactly matches a single open invoice (credit) or a single unmatched expense (debit) shows a one-click badge directly on the transaction row; clicking the badge matches without expanding the row; the badge list refreshes after each match
- **Dedicated accounting file storage volume** — expense receipts and bank transaction attachments are now stored under a separate `accounting-data` Docker volume (`ACCOUNTING_STORAGE_ROOT`) rather than the shared uploads volume; files are organized as `FY{year}-{year}/<AccountName>/filename.ext` (or `FY{year}-{year}/<ParentAccount>/<ChildAccount>/filename.ext` for sub-accounts), making it straightforward to audit or archive documents by fiscal year; a new `file-storage.ts` module handles path building with path-traversal protection, FY resolution from `SalesSettings.fiscalYearStartMonth`, filename sanitisation, and automatic deduplication
- **"This financial year" and "All time" presets in DateRangePreset** — the date-range selector used across Accounting pages gains two new options: **This financial year** (full FY, not truncated to today) and **All time** (no date bounds); a new exported helper `getThisFinancialYearDates()` is used to initialise the Bank Accounts transaction filter and the Expenses list filter so both pages open showing the current FY by default instead of an empty date range; the component also now infers its active preset from externally controlled `from`/`to` values so the selector stays in sync when dates are set programmatically

### Fixed
- **Account balance sign incorrect for debit-normal accounts** — the `/api/admin/accounting/accounts/balances` endpoint was accumulating bank-transaction `amountCents` with the same sign for every account regardless of normal balance; credits (positive `amountCents`, money in) were therefore inflating debit-normal account balances (ASSET, EXPENSE, COGS) rather than reducing them; the endpoint now fetches account types, builds a debit-normal set, and negates contributions for those accounts so the balance reflects the correct accounting sign; the same sign fix is applied in the POST transaction route, which now uses `-txn.amountCents` instead of `Math.abs` so debit transactions (money out) produce positive expense amounts
- **Account ledger page did not show entries from child accounts** — viewing a parent account's ledger page (`/admin/accounting/chart-of-accounts/[id]`) only returned entries posted directly to that account ID; all child-account entries were silently omitted; the entries API now resolves all direct children, expands all five data sources (expenses, bank transactions, journal entries, split lines, sales invoice income) to the full account ID list, and returns a `hasChildAccounts` flag; an **"Includes sub-accounts"** badge appears on the account header when child entries are included; an **Account** column is added to the ledger table and CSV export showing the specific sub-account each entry was posted to; a `periodTotalCents` rolling total for the full period (not just the current page) is also returned and shown
- **Deleting a payment linked to a bank transaction now returns the transaction to Pending** — when a `SalesPayment` was deleted from the Sales › Payments page, the associated `BankTransaction` (if any) was left in `MATCHED` state with a dangling null `invoicePaymentId`, hiding it from the Pending list in Bank Accounts; the DELETE route now wraps the operation in a transaction that resets the bank transaction to `UNMATCHED` (clearing `matchType` and `transactionType`) before deleting the payment, so the transaction reappears in the Pending list ready to be re-matched
- **Deleting an expense or bank transaction now removes its on-disk file** — the expense DELETE route and transaction DELETE route previously removed the database row but left the receipt / attachment file on disk; both routes now read the stored file path before deletion and call `deleteAccountingFile` to clean up the physical file
- **Attachments organised into the correct FY/account folder on post and match** — when a bank transaction that already has an attachment is then posted as an expense or matched to an existing expense, the attachment file is now relocated from its original upload path into the `FY{year}-{year}/<AccountName>/` folder that corresponds to the transaction date and posting account, keeping the storage layout consistent across all document types
- **Bank Accounts pending-tab actions no longer reload the full transaction list** — posting, ignoring, undoing, splitting, and invoice-matching operations previously called `loadTransactions()` after completion, triggering a full server fetch and resetting scroll position; each action now removes the affected transaction from local state immediately, decrements the total, and collapses any expanded row, giving instant feedback without a round-trip
- **Unit price field cursor jumps to end while typing on Quote and Invoice pages** — the Unit `(${currency})` input on the New and Edit pages for both Quotes and Invoices stored `unitPriceCents` as the source of truth and re-derived the display string via `centsToDollars` (which formats with comma separators and always two decimal places) on every keystroke; any intermediate value that did not round-trip identically caused React to replace the `value` attribute, resetting the cursor to the end of the field; the input now tracks a raw string in `unitPriceInputs` state while the field is focused — the raw string is displayed during editing and `centsToDollars` is only used as the fallback display when the field is not being actively edited; on blur the raw entry is discarded and the canonical formatted value is shown

### Changed
- **Account search pickers now show hierarchical labels and search across the full name path** — all account typeahead inputs across Bank Accounts (posting form and split lines) and Expense forms previously displayed a flat `Type — Name` label and only matched against the account name and type string individually; a new `buildAccountOptions()` helper pre-computes a `label` field that includes the parent account name for child accounts (e.g. "Expense — Motor Vehicle — Fuel"), a `searchText` index combining code, name, full path, type label, and label, and sorts the list alphabetically; all pickers now use this pre-built index, eliminating repeated inline sort and filter operations

## [1.3.7] - 2026-04-07

### Fixed
- **Video quality options not loading on client share page** — the share API route was returning `undefined` for `preview480Path`, `preview720Path`, and `preview1080Path` instead of boolean availability flags; the player therefore could not detect which quality levels were available and failed to load; the route now returns the correct boolean values so quality selection works as expected
- **Archived task list not refreshing after deleting an archived task** — deleting a card from the archived view did not re-fetch the archived list; a `key` prop driven by a counter (`archivedViewKey`) is now incremented after each delete, forcing the archived panel to remount and reload its data

## [1.3.6] - 2026-04-07

### Added
- **Reporting settings** — Accounting › Settings gains a global **Reporting Basis** preference (Cash vs Accrual) stored in the new `AccountingSettings` table; the Sales Dashboard independently respects a `dashboardReportingBasis` and `dashboardAmountsIncludeGst` override (new columns on `SalesSettings`) so the dashboard totals can differ from the full accounting reports
- **Sales Labels** — a new `SalesLabel` model provides colour-coded labels (hex colour, optional Chart of Accounts account mapping, sort order, active flag) that can be assigned to Sales Library Items; labels bridge the sales and accounting modules by linking a line-item category to a default posting account; backed by the `SalesLabel` table with a `labelId` foreign key added to `SalesItem`
- **Default income account in Sales Settings** — a default Chart of Accounts `Account` can now be selected in Sales Settings (`defaultIncomeAccountId`); used as the fallback posting account when sales transactions are surfaced in the accounting module

## [1.3.5] - 2026-04-06

> **⚠ Upgrade note — migration squash:** The 67+ individual Prisma migrations accumulated since v0.1 have been collapsed into a single baseline snapshot (`20260405000000_baseline`). **Fresh installs are unaffected.** If you are upgrading an existing instance, the baseline migration will appear as "pending" to Prisma even though your database already has all the tables — running `migrate deploy` without preparation would fail. Before pulling this release and running `docker compose up -d --build`, mark the baseline as already applied against your running database:
> ```bash
> # 1. Build the new image first (does not start the container)
> docker compose build
> # 2. Mark the baseline migration as already applied (no SQL runs — Prisma just records it)
> docker compose run --rm --no-deps app npx prisma migrate resolve --applied "20260405000000_baseline"
> # 3. Start normally — only the 3 new accounting migrations will be applied
> docker compose up -d
> ```
> **Why the squash was necessary:** Over 5+ months of development the migration folder had grown to 67+ files, many with timestamp collisions and implicit ordering dependencies. This caused unreliable first-run installs and made Prisma's migration history difficult to audit. The squash replaces all prior migrations with a single authoritative schema snapshot and resets the history cleanly.

### Added
- **Accounting module** — a new Accounting section (still under development) is available from the admin header navigation (sub-menu: Dashboard, Bank Accounts, Expenses, Chart of Accounts, BAS / GST, Reports); the module introduces Chart of Accounts management, bank account and transaction import, expense tracking with receipt upload, and transaction posting/matching workflows; three new database migrations introduce the accounting schema (`add_accounting_module`, `add_accounting_settings`, `make_expense_supplier_optional`)

### Fixed
- **Avatar endpoint rate limit raised to prevent false lockouts** — `GET /api/users/[id]/avatar` had a limit of 120 requests per minute; pages that render many users simultaneously (Kanban board, project member lists, etc.) fire one avatar request per visible user, making the old limit trivially easy to hit during normal navigation; the limit is raised to 600 requests per minute and `force-dynamic` is removed so that browser and CDN cache headers can reduce repeat requests over a session
- **Project storage panel now shows "Other files" as a separate row** — unaccounted on-disk bytes (`diskOtherBytes`) were previously surfaced only as inline text ("On disk • X other") in the Source tooltip row; they are now displayed as a dedicated "Other files" row in the storage breakdown alongside Videos, Photos, ZIP files, and Project Files, making the total more transparent and consistent; additionally a `else if` bug in the storage calculation prevented `timelinePreviewVttPath` from being counted when a video also had a `timelinePreviewSpritesPath` — both paths are now always included in the preview storage total
- **"No open invoices found" after manually deleting a payment** — the payment DELETE route removed the `SalesPayment` record but never called `recomputeInvoiceStoredStatus`, leaving the invoice's stored status as `PAID` even after the payment was gone; the route now reads the `invoiceId` before deletion and recomputes the invoice status afterward so the invoice correctly returns to `OPEN` / `SENT` / `OVERDUE` and appears in the invoice-matching dialog in Bank Accounts

## [1.3.4] - 2026-04-04

### Added
- **Client association on Kanban tasks** — each task now has an optional "Client (Optional)" field in the Add and Edit Task modals; the field uses the same client typeahead search as quotes and invoices; selecting a client dynamically narrows the "Project (Optional)" dropdown to projects belonging to that client only; the client name is shown on task board cards beneath the description; a new `clientId` column is added to the `KanbanCard` table with a foreign-key relation to `Client`
- **Archive view Client column** — the archived tasks view gains a "Client" column between the title and Comments columns; the divider line below the archive header is removed and the Title/Status and Client columns share equal width
- **Tasks section on Project pages visible by default and in Show/Hide Sections toggle** — the Tasks panel on each project detail page is now included in the "Show/Hide Sections" dropdown; in defaults to visible (`tasks: true`); existing saved section-visibility settings are merged with the new default so upgrading users see the section automatically; the `tasks` key is validated server-side on save
- **"Add Task" button on Project pages** — a `+ Add Task` button (matching the style of the Key Dates "+ Add Date" button) appears in the Tasks panel header for users with change-project-settings permission; clicking it opens the full Add Task dialog with Client and Project pre-filled from the current project, so tasks can be created directly from the project page without navigating to the Kanban board

### Changed
- **"Link to Project" renamed to "Project (Optional)"** — the project picker in the Add/Edit Task modal is renamed and is now disabled until a client is selected first; when no client is selected the placeholder reads "Select a client first"; clearing the client also clears the selected project
- **Gotify/Ntfy webhook notifications removed** — the Gotify or Ntfy delivery channel is removed from Push Notifications; all webhook-related settings (Enable Gotify or Ntfy toggle, Webhook URL field) are removed from the Push Notifications settings card; push delivery now relies solely on Browser Push (PWA) and the in-app notification bell; the now-unused `provider`, `webhookUrl`, and deprecated `title` columns are dropped from `PushNotificationSettings`

## [1.3.3] - 2026-04-04

### Added
- **Kanban task board on Projects dashboard** — a fully-featured Kanban board lives below the project list on the Projects dashboard; columns can be created, renamed, given a hex colour, reordered by drag (with a column-lock toggle), and deleted; cards can be created in any column, dragged between columns and within columns to change position, assigned a title, rich-text description, optional due date, and an optional project link; the board automatically refreshes the key-dates calendar when a change is saved
- **Card member allocation with per-member notification toggle** — users can be added to or removed from any Kanban card; each member has an individual "Receive notifications" bell toggle that controls whether they receive in-app and browser push notifications for new comments on that card; system admins see all cards, non-admins see only cards on which they are a member or that are linked to a project they are assigned to
- **Comments on Kanban cards** — each card has a threaded comment section with support for top-level replies and nested replies; comments display the author's avatar (or initials fallback), name, timestamp, and content; authors can delete their own comments; admin users can delete any comment; new comments on a card enqueue a `TASK_COMMENT` notification in the existing scheduled notification queue, delivered to card members who have their notification bell enabled
- **Email digest for Kanban task comments** — the worker's scheduled notification pass now includes a `processTaskCommentNotifications` step that batches unsent `TASK_COMMENT` queue entries, groups them by card, and sends a summary email to each card member with notifications enabled; the email lists every new comment per task with author name, email, and content, and includes a direct link to the Projects dashboard; the `Settings` table gains a `lastTaskCommentNotificationSent` column for schedule-tracking
- **Kanban card history log** — every significant action on a card (created, moved between columns, member added/removed, due date set/removed, project linked/removed, title or description edited) is recorded as a `KanbanCardHistory` row with the actor's name snapshot and a JSON payload; the history timeline is displayed inside the card dialog in chronological order with human-readable descriptions and relative timestamps
- **Archive and restore Kanban cards** — an admin-only "Archive" option on each card sets `archivedAt` and removes the card from the board view; a separate "Archived" panel shows all archived cards newest-first with full member and project context; each archived card has an "Unarchive" button that returns it to its original column (or the leftmost column if that column was deleted)
- **Project Tasks panel on the Project detail page** — each project detail page includes a "Tasks" section listing all active Kanban cards linked to that project, showing the card title, column, due date, member avatars, and comment count; clicking a task opens the full card dialog inline; the Projects dashboard handles an `?openTask=` query parameter so clicking a task from the project page navigates to the board and opens the correct card
- **Kanban task due dates in the Projects calendar widget** — tasks with a due date appear on the key-dates calendar as cyan pill entries alongside project key dates; clicking a task pill opens the card dialog on the board; the calendar legend gains a "Task" entry; the calendar refreshes whenever the board changes
- **Task due dates in the ICS calendar export** — the `/api/calendar/key-dates` ICS feed now includes `VEVENT` entries for all Kanban cards with a due date that fall within the calendar window and are visible to the requesting user (admin sees all; non-admin sees only member/project-linked cards), complete with `LAST-MODIFIED` stamps
- **Sales Line Item Library** — a global "Items" library (`SalesItem`) lets teams define reusable line items (description, optional detail text, quantity, unit price, tax rate) once and import them into any quote or invoice; items persist independently of any preset and can be created, deleted, and browsed from the new "Add items" modal
- **Sales Line Item Presets** — named presets (`SalesPreset`) bundle a selection of library items with a defined sort order; presets are saved, listed, and deleted from the same modal; applying a preset auto-checks its items for one-click import; saving a preset with an existing name replaces its item selection (upsert)
- **"Add items" modal on Quotes and Invoices** — both the New and Edit pages for Quotes and Invoices gain an "Add items" button that opens the `SalesLineItemPresetsModal`; the modal lists all library items with checkboxes, a preset selector to pre-check a bundle, a form to add a new item to the library, and a preset save/delete UI; clicking "Import selected" appends the chosen items as line items; blank placeholder rows are removed before appending when using the New page
- **Drag-to-reorder line items on Quotes and Invoices** — every line item row on the New and Edit pages for both Quotes and Invoices now has a grip-handle on the left; holding the handle activates HTML drag-and-drop reordering; the drop target is highlighted with a ring; reordering is reflected immediately in the saved document
- **Duplicate Quote / Duplicate Invoice** — a Copy icon button on the Quote and Invoice edit pages serialises the current notes, terms, and line items into `sessionStorage` and redirects to the New page, which reads and clears the prefill on mount so the duplicated document opens ready to save
- **Notification log entries automatically purged after 45 days** — a daily worker job (02:30 server/container time) deletes `PushNotificationLog` rows with a `sentAt` older than 45 days; pinned system notification types (Dropbox inconsistency, orphan files, QuickBooks pull failure, rate limit alert) are excluded from the purge and continue to persist until manually cleared
- **"None" option replaces "Weekly" in Admin and Client Notification Schedules** — the `WEEKLY` schedule option is removed from both the global Admin Notification Schedule and per-project Client Notification Schedule; a new `NONE` option ("Do not send comment notification emails") is available in its place; all schedule pickers, API validation, and worker logic are updated accordingly; existing `WEEKLY` database values are migrated to `NONE`
- **Per-type toggles for automated admin system emails** — the Email / SMTP & Notifications settings card gains an "Admin System Emails" section with individual on/off switches for each category of automated email sent to internal users: project approved by client, internal comment digests, task comment digests, invoice paid (Stripe), quote accepted by client, project key date reminders, and personal key date reminders; all toggles default to enabled; the corresponding workers and webhook handlers respect the toggle before sending
- **Default Client Notification Schedule in Default Project Settings** — the Default Project Settings card now includes a Client Notification Schedule selector (Immediate / Hourly / Daily / None) and a "Client System Emails" section; newly created projects inherit the chosen schedule; a "Project approval confirmation" toggle controls whether the automated approval email is sent to the client when they approve a project; the existing per-project schedule selector continues to override the default for individual projects

### Changed
- **"Gotify Notifications" and "Browser Push (Admin)" settings merged into a single "Push Notifications" section** — the two separate Global Settings cards are replaced by one unified card; the section contains a master enable/disable toggle, a Gotify or Ntfy sub-toggle (with the webhook URL field shown only when enabled), and the browser push device management panel embedded inline; the sidebar navigation item count reduces from twelve to eleven sections
- **Push notification master toggle now gates all delivery channels** — previously the master toggle only controlled Gotify/webhook delivery while browser push always fired regardless; the master toggle now applies to both browser push and webhook delivery so disabling push notifications stops all outbound push across every channel while still logging events for the in-app notification bell
- **Per-event toggles now apply to browser push as well as webhook delivery** — the "Enable Notifications For" toggles previously only controlled Gotify delivery; they now control all push channels (browser push, Gotify, Ntfy) simultaneously; disabling an event type suppresses delivery on every channel
- **Gotify or Ntfy webhook label and description updated** — the "Enable Gotify Notifications" toggle is renamed to "Enable Gotify or Ntfy Notifications" with a description clarifying that either service works; the webhook URL placeholder shows both formats (`https://gotify.example.com/message?token=TOKEN` and `https://ntfy.example.com/topic`)
- **Gotify/Ntfy webhook notifications now use the same content templates as browser push** — the webhook sender previously built a raw key/value message from the payload details map; it now calls `buildAdminWebPushNotification` (the PWA template layer) for consistent, human-readable titles and bodies across all push channels
- **"Notification Title Prefix" field removed** — the optional free-text prefix that prepended `[prefix]` to Gotify notification titles is removed from the settings UI and the save path; the `title` column is retained in the database for backward compatibility but is no longer written
- **"Enable Notifications For" list updated with four additional event categories** — the toggle list gains: **Internal Comments** (admin project comments not visible to clients, previously lumped with Client Comments), **Task Comments** (Kanban board card comments, previously lumped with Client Comments), **User Assignments** (project and Kanban task assignments), and **Sales Reminders** (overdue invoice and expiring quote worker reminders); `INTERNAL_COMMENT`, `TASK_COMMENT`, `PROJECT_USER_ASSIGNED`, `TASK_USER_ASSIGNED`, `SALES_REMINDER_INVOICE_OVERDUE`, and `SALES_REMINDER_QUOTE_EXPIRING` payload types are all now mapped to their respective toggles and respected across every push channel; backed by a migration adding `notifyInternalComments`, `notifyTaskComments`, `notifyUserAssignments`, and `notifySalesReminders` columns to `PushNotificationSettings`
- **PWA notification templates extended for task and assignment events** — `buildAdminWebPushNotification` now has explicit cases for `TASK_COMMENT` (showing task title, author, and comment excerpt), `PROJECT_USER_ASSIGNED` (showing project and assigning user), and `TASK_USER_ASSIGNED` (showing task, project, and assigning user); these event types previously fell through to the generic fallback
- **Schema: `Comment.videoId` formalised as a foreign key** — a proper `FOREIGN KEY` constraint with `ON DELETE CASCADE` is added from `Comment.videoId` to `Video.id`, plus a composite index on `(projectId, videoId)` for efficient video-scoped comment queries; this closes a latent data-integrity gap where deleting a video via raw SQL would have left orphaned comment rows
- **Schema: `NotificationQueue.type` converted from plain string to enum** — the column is now typed as the Postgres enum `NotificationQueueType` (`CLIENT_COMMENT | ADMIN_REPLY | INTERNAL_COMMENT | TASK_COMMENT`); the migration casts existing values to the enum in place; new `TASK_COMMENT` type supports Kanban comment notifications alongside the existing project-comment types
- **Schema: redundant `User.role` column and `UserRole` enum removed** — the legacy `role VARCHAR` column on `User` and the single-value `UserRole` enum (`ADMIN`) are dropped; all session tokens, API routes, auth helpers, and the `setDatabaseUserContext` function now read the role name from the RBAC `AppRole` relation (`appRoleName`); the passkey login flow is updated accordingly

### Fixed
- **Video delete now uses database cascade for comment cleanup** — `Comment.videoId` previously had no foreign-key constraint to `Video`, so comments had to be deleted in a manual Prisma transaction before the video could be deleted; the new FK (`ON DELETE CASCADE`) lets the database handle comment removal automatically; the manual transaction is removed

## [1.3.2] - 2026-04-02

### Fixed
- **Client detail Quotes and Invoices tables no longer wrap columns on mobile** — the Quote/Invoice number, Issue date, Amount, and Status columns now have minimum fixed widths so they cannot shrink below a readable size on narrow screens; the Project column has a 200 px minimum width so longer project names have more room; the Payments table Date, Amount, and Invoice columns likewise have minimum widths; the overflow-x-scroll wrapper on each table allows horizontal scrolling when the viewport is narrower than the total table width

### Added
- **Photos count on the Client detail project table** — the project table on the Client detail page now includes a "Photos" column showing the total number of photos across all albums in that project; the "Versions" and "Comments" columns have been removed; the `/api/clients/[id]/projects` endpoint now queries each project's albums and sums the photo count, returning a `photoCount` field per project row
- **Skip preview transcoding when uploading to a closed project** — when "Auto-delete video previews and timeline sprites when project is closed" is enabled, uploading a video (or version) to a project that is already CLOSED no longer queues a full transcode job; a thumbnail-only job is queued instead so the video enters READY status with a poster image but without generating preview files that would be immediately redundant

### Fixed
- **Share-page quality selector correctly reflects available preview resolutions** — the Admin and public Share pages now only fetch stream tokens for resolutions that have an actual preview file stored; previously the fallback logic populated all resolution tokens with the original file, causing the quality selector to show "Auto / 480p / 720p / 1080p" even when no previews existed; a dedicated `streamUrlOriginal` field is now passed to `VideoPlayer`, which displays a non-interactive "Original" quality button on both desktop and mobile when no preview resolutions are available and streams the original file directly
- **Client detail Quotes, Invoices, and Payments sorted by document date** — the Quotes and Invoices sections on the client detail page now sort by `issueDate` descending instead of `updatedAt`; the Payments section sorts by `paymentDate` descending instead of `createdAt`, matching the natural document ordering expected when reviewing a client's billing history
- **Invoice paid-on date uses consistent date formatting** — the "Paid on" display and the payment detail summary lines on Invoice detail pages now use the shared `formatDate` utility rather than raw YYYY-MM-DD string replacement

## [1.3.1] - 2026-04-02

### Added
- **Search on Invoices and Quotes list pages** — a text input above each table allows real-time filtering by document number, client name, or linked project title; the search resets the current page to 1 so results are always shown from the start; both lists also reset to page 1 when the search query changes alongside the existing status filter and sort controls
- **Rate limit lockouts logged as Security Events** — when a rate limit lockout is triggered, a `RATE_LIMIT_HIT` security event is written at WARNING severity with `wasBlocked: true`, recording the rate limit type and the client IP address so lockout activity is fully auditable on the Security Events page
- **Rate limit lockouts surface as pinned notifications** — alongside the security event, a pinned `RATE_LIMIT_ALERT` notification is upserted in the notification bell; the notification includes the rate limit type, IP address, and retry-after window; it persists until manually cleared and links directly to the Security Events page; duplicate lockout events on the same limit type update the existing notification rather than creating additional entries
- **Export client emails as CSV** — a download button on the Clients list page generates a `client-emails.csv` file containing all contacts (not just the primary) across all clients that match the current active filter; each row includes the contact name, email address, company name, and a "Primary" flag indicating whether the contact is the primary recipient; contacts without an email address are omitted
- **Sales Projects Overview and Clients Leaderboard now use Project Start Date** — the Projects Overview chart and Clients Leaderboard on the Sales Dashboard now bucket closed projects by their `startDate` (falling back to `createdAt` when unset), consistent with how Start Date is used elsewhere in the app; the projects-chart API endpoint was updated accordingly
- **"All time" period option on the Clients Leaderboard** — the Clients Leaderboard chart gains an "All time" option in its period selector that shows every client with at least one closed project regardless of date, bypassing the month-bucketing filter used by the other period options
- **Admin can now delete any internal comments** — users can still delete their own comments, but now Admin can delete all internal comments

### Fixed
- **QuickBooks pull no longer creates duplicate contacts on matched clients** — the `ensurePrimaryRecipient` helper was being called even when a QB customer record was matched to an existing client (both the "matched by QB ID" and "matched by name" update paths), potentially creating a duplicate recipient row on every scheduled pull; the call is now removed from both update branches in the manual pull API route and the daily pull runner; new-client creation is unaffected and still assigns a contact
- **New Project page shows the server error reason on failure** — the error alert now reads "Failed to create project: \<reason\>" instead of the uninformative static message

### Changed
- **Pinned system notification helpers extracted to a shared module** — `isPinnedSystemNotificationType`, `isPinnedSystemNotificationDetails`, `isClearablePinnedNotificationDetails`, and all pinned notification type constants have been moved from `dropbox-storage-inconsistency-notification.ts` into a new `pinned-system-notifications.ts` module; the old file is removed; all import sites updated; this consolidates the `RATE_LIMIT_ALERT` type alongside the existing Dropbox, orphan-scan, and QuickBooks constants
- **Zero-quantity line items now supported on quotes and invoices** — the Qty field minimum is now 0 (was 1) so descriptive or informational line items with no chargeable quantity can be entered; the quantity normalizer on save now preserves 0 instead of substituting 1; the QuickBooks pull line-item normalizer (`normalizeEstimateLines` / `normalizeInvoiceLines`) likewise preserves a `qty` of 0 from QuickBooks rather than coercing it to 1, and the unit-price calculation guards against division-by-zero when `qty` is 0
- **Pagination controls replaced with icon buttons throughout the app** — every paginated table that previously showed "Previous" and "Next" text buttons now shows a four-button row of icon-only controls (first page, previous, next, last page) using `ChevronsLeft` / `ChevronLeft` / `ChevronRight` / `ChevronsRight`; affected areas: Projects dashboard, Security Events, Project Email table, Project Activity log, Project Analytics client list, Sales doc views and email-open tracking, Client detail quotes/invoices/payments tables, Invoices list, Quotes list, and Payments list
- **Client detail sales tables paginated instead of truncated** — the Quotes, Invoices, and Payments sections on the client detail page previously displayed only the first 10 records with a "View all" link; they now show a full paginated view (10 per page) with first/prev/next/last controls, and the "View all" links have been removed; page cursors reset to 1 when the client changes
- **Rate limiting on project routes scoped per user** — the projects-list (`GET /api/projects`) and create-project (`POST /api/projects`) rate limiters now include the authenticated user's ID in the limit key; previously the limit was shared across all users, so one user's burst could exhaust the quota for others
- **Preview file deletion parallelised when closing a project** — when the "Auto-delete previews on close" setting is enabled, preview file deletions across all videos in the project now run concurrently via a single `Promise.allSettled` call instead of sequentially for each video; the subsequent raw-SQL path-column nulling (introduced in v1.3.0 to avoid bumping `updatedAt`) is unaffected
- **Primary button gradient removed** — the `.btn-primary` CSS utility class no longer applies a `linear-gradient` overlay on top of the primary colour token; buttons render a flat primary colour consistent with the design language introduced in v1.2.6

## [1.3.0] - 2026-04-01

### Added
- **User profile pictures** — admin users can upload, crop, and remove a profile photo from the Edit User page; photos are stored server-side and served through a dedicated avatar endpoint with cache-busting; a canvas-based drag-to-reposition and zoom crop dialog makes it easy to frame the shot; a fallback initials circle using the user's display colour is shown whenever no photo is set
- **Profile pictures shown throughout the app** — uploaded avatars now appear in the Project page assigned-users list (both the search dropdown and added-user cards), the Projects dashboard Users column, and comment bubbles on both the client and admin Share pages
- **My Profile modal in the admin header** — the email+icon display in the top-right header is replaced with a User icon button that opens a profile modal; the modal shows the user's current profile picture (with the ability to upload or remove it), read-only fields for Name, Username, Email, Role, and Phone, and a password-change form (current password, new password, confirm)
- **Self-service password change for all authenticated users** — any signed-in internal user can now update their own password via the My Profile modal regardless of whether they have access to the Users settings page; the `/api/users/[id]` GET endpoint also allows users to fetch their own profile data without requiring the users menu permission
- **Project Start Date** — projects now have an optional Start Date field separate from their creation date; users with Full Control can edit the start date inline on the project detail page; the New Project form includes a Start Date input that defaults to today; the Projects dashboard and Client detail project tables now display a sortable "Start Date" column (replaces the former "Date Created" column); project dropdown lists in Quotes and Invoices sort by start date then creation date; backed by a new database migration adding a nullable `startDate` DateTime column to the Project table
- **Auto-promote projects when Start Date is due** — the worker job that previously auto-started projects only on a SHOOTING key date now also promotes projects from NOT_STARTED → IN_PROGRESS when their `startDate` is today or earlier; duplicates are deduplicated so a project with both triggers is only promoted once; saving a project's start date via the API also immediately promotes it if the new date is already due and no explicit status change was requested
- **Sales reminder push notifications** — when the sales reminders worker sends an overdue-invoice or expiring-quote email notification, it now also creates an in-app push notification for users with Sales menu access; each notification includes the document number, client name, and amount; clicking a `SALES_REMINDER_INVOICE_OVERDUE` or `SALES_REMINDER_QUOTE_EXPIRING` entry in the notification bell navigates directly to the relevant invoice or quote detail page
- **Share-page-gated notification delivery** — `CLIENT_COMMENT`, `ADMIN_SHARE_COMMENT`, and `VIDEO_APPROVAL` notifications are now only delivered (both in-app and via browser push) to users who have the `accessSharePage` permission in addition to being assigned to the project; `INTERNAL_COMMENT` and `PROJECT_USER_ASSIGNED` notifications remain accessible to any project-assigned user regardless of share-page access
- **QuickBooks pull assigns display colours to new contacts immediately** — when the QB pull-customers job creates a new client recipient it now assigns a random display colour at creation time, so the colour is applied without requiring a manual save from the Edit Client page

### Fixed
- **Closing a project no longer floods Running Jobs with stale completions** — when the "Auto-delete previews on close" setting is enabled, closing a project previously called `prisma.video.update()` for every video to null out preview/timeline paths, which bumped each video's `updatedAt` to the current time; the Running Jobs API uses `updatedAt` within the last 30 minutes as a proxy for "recently completed", so all those videos appeared as brand-new "Processing complete" and "Dropbox upload complete" entries; the preview-path nulling is now done via raw SQL (`UPDATE "Video" … WHERE "id" = ANY(…)`) which skips Prisma's automatic `updatedAt` management, leaving the timestamps untouched
- **Internal Comments scroll position defaults to bottom** — when the Internal Comments panel on the project page loads, the scroll container now correctly positions at the bottom so the most recent comments are immediately visible; previously the auto-scroll guard was being consumed on initial mount (when the comment list was still empty), which prevented the scroll from firing once the comments actually loaded

### Changed
- **Comment avatar size on Share pages increased slightly** — comment author avatars on both the client-facing and admin Share pages are 25 % larger than their default size (up from 24 px to 30 px); reply avatars scale proportionally
- **`Textarea` component gains `autoResize` prop** — passing `autoResize` causes the textarea to automatically grow and shrink to fit its content (no scrollbar, `resize-none`); the project description field in both the New Project form and Project Settings now uses `autoResize` for a cleaner editing experience
- **Admin landing page suppresses spurious PERMISSION_DENIED security events** — security settings are now only fetched during landing-page load if the signed-in user actually has the `security` menu permission; previously the unconditional fetch produced a PERMISSION_DENIED security event on every page load for users without security access
- **RBAC enforcement distinguishes menu access denials from action access denials** — `requireMenuAccess` no longer writes a `PERMISSION_DENIED` security event when a user lacks menu access (this is expected, routine RBAC enforcement and was generating noise); `requireActionAccess` continues to log a PERMISSION_DENIED event at INFO severity so deliberate permission bypass attempts remain auditable

## [1.2.9] - 2026-03-30

### Added
- **Sales Dashboard — Sales Overview chart** — a monthly column chart displays invoice revenue for the selected period, positioned immediately above the QuickBooks Actions section; the subheader shows the period total, average revenue per month, and (for Financial Year to Date and Year to Date periods) a projected full-year figure extrapolated from the current run-rate; the projection accounts for partial-month progress by weighting the current month proportionally to the number of elapsed days, avoiding inflated projections early in a month
- **Sales Dashboard — Quotes Overview chart** — a dual line chart plots total quotes issued and accepted quotes per month side-by-side; "Total" counts every quote for the month by issue date regardless of status, while "Accepted" counts only quotes that reached accepted status; the subheader displays totals and a win-rate percentage; both lines share the same period selector
- **Sales Dashboard — Projects Overview chart** — a composite chart combines a bar series (closed project count per month, left axis) with a line series (average invoiced value per project, right axis), giving simultaneous visibility of volume and deal size; only projects with `CLOSED` status are included; projects are bucketed by creation date; a new `/api/admin/sales/projects-chart` endpoint serves the data, computing each project's total invoiced amount by summing all linked invoice line items including tax
- **Sales Dashboard — Clients Overview leaderboard** — a ranked list beneath the Projects Overview chart shows all clients who have closed projects in the selected period, ordered by total invoiced revenue descending; each row displays a gold/silver/bronze rank badge for the top three, a relative progress bar scaled to the highest-revenue client, the client name (linked to the client detail page), total revenue, project count, and average project value; the list is scrollable when there are many clients
- **Period selector on all four charts** — each chart carries an independent dropdown offering Financial Year to Date (default), Last Financial Year, Year to Date, and Last 12 Months; all periods respect the `fiscalYearStartMonth` configured in Sales Settings

### Changed
- **QuickBooks Actions card layout redesigned** — the card header is removed and replaced with an inline title; on desktop the title and all four buttons sit on a single centred row; on mobile the title is centred above a 2 × 2 button grid (Pull Clients / Pull Quotes on the first row, Pull Invoices / Pull Payments on the second); each button now carries a matching icon — `Building2` for Pull Clients, `FileText` for Pull Quotes, `Receipt` for Pull Invoices, and `DollarSign` for Pull Payments, consistent with the icons used in the stat-card strip at the top of the dashboard

## [1.2.8] - 2026-03-30

### Added
- **Admin and internal users can now upload attachments when leaving comments on the Share Page** — previously only possible by Clients / project recipients.
- **`projectExternalCommunication` RBAC permission** — a new granular permission "External Communication" is added to the Projects permission group on the Users page; it controls access to email upload, email list/delete, and email attachment download routes; enabling Full Control automatically grants it, and disabling it (or Photo & Video Uploads) clears Full Control to avoid a misleading partial state
- **Comment Attachments section on the Project page** — when a project has one or more comment attachment files a dedicated "Comment Attachments" read-only list appears in the project files area, visible to users with the `accessSharePage` permission; the list refreshes automatically when uploads or file changes occur
- **Email Attachments section on the Project page** — when a project has non-inline email attachments a dedicated "Email Attachments" read-only list appears, visible to users with the new `projectExternalCommunication` permission; it refreshes in sync with email and storage changes
- **`commentAttachmentsCount` and `emailAttachmentsCount` in project API** — the project GET endpoint now fetches both counts in parallel via `Promise.all` alongside the main project query, and includes them in the serialised response; counts are zeroed for callers that lack the corresponding permission
- **Unsaved comment guard on Admin Share Page** — switching away from a video while a comment draft or attachment is in flight now shows a native confirmation prompt ("You have an unsent comment. Are you sure you want to leave?"); confirming automatically resets the draft; the guard is hooked into both the video selector and the album selector
- **Unsaved comment guard on Internal Comments** — `ProjectInternalComments` now registers `useUnsavedChanges` so navigating away while a draft is typed triggers a browser confirmation; the draft is discarded if the user confirms

### Changed
- **External communication routes gated by dedicated permission** — the email list, email detail, email attachment download, and email delete/post endpoints previously required `accessProjectSettings` or `projectsFullControl`; they now require the new `projectExternalCommunication` permission, making it possible to grant email access without granting full project control or settings access
- **Email attachments removed from the internal project files list** — `ProjectFileList` no longer requests `includeEmailAttachments=1`; email attachments are presented via the dedicated "Email Attachments" section added above; the corresponding query-param branch is removed from the files API route; the "Email Attachment" source-type label that previously appeared inline in the file list is also removed
- **Storage breakdown splits External Communication into its own row** — `communicationsBytes` (raw email bodies + email attachments) is now exposed as a separate field from `projectFilesBytes` in both the per-project storage API and the global Storage Overview API; `ProjectStorageUsage` and `StorageOverviewSection` each show a new "External Communication" row; empty rows are filtered out automatically so the breakdown stays uncluttered
- **Project Storage Usage card hides itself when there is nothing to show** — `ProjectStorageUsage` returns `null` when the project reports zero tracked bytes, preventing an empty card from appearing on projects that have no files yet
- **`externalCommunication` section on Project page gated by new permission** — the section was previously rendered for any user with Full Control (`canDeleteInternalFiles`); it now checks `canAccessExternalCommunication` so operators who manage emails but do not have full control can still see the section, and users without the permission no longer see it regardless of their other grants
- **Project page refreshes project data after file and email changes** — upload-complete and file-changed callbacks throughout the project page now call `void fetchProject()` in addition to bumping the storage refresh counter, so `commentAttachmentsCount` and `emailAttachmentsCount` update live without a page reload
- **Project Settings upload allocation label renamed** — "Max allowed data allocation for client uploads" is renamed to "Max allowed data allocation for comment attachments" in both the primary and default-settings dialogs to accurately reflect that the quota applies to comment file uploads, not all client uploads
- **`useUnsavedChanges` hook extended with message and discard options** — the hook now accepts an optional second argument `{ message?, onDiscard? }`; `message` overrides the default "You have unsaved changes" browser prompt text; `onDiscard` is called automatically when the user confirms leaving (browser unload and programmatic `confirmNavigation()` paths both trigger it); a same-document navigation guard prevents false positives when hash or query-string changes occur within the same page; the hook also exposes `confirmNavigation()` to consumers that need to intercept programmatic navigation
- **`useCommentManagement` adds `hasUnsentComment` and `resetDraft()`** — `hasUnsentComment` is `true` when the comment text or any attachment is pending; `resetDraft()` clears the text, timestamp, reply target, attachments, and upload progress in one call; both are returned from the hook; existing call sites in the submit and delete-all paths are updated to use `resetDraft()`; the hook also resets the reply state when the selected video changes; admin comment fetches now pass `cache: 'no-store'` to prevent stale data
- **`CommentSection` gains an `allowCommentFileUpload` prop** — the new prop decouples the file-attachment capability from the `allowClientUploadFiles` flag so the admin share page can allow admins to attach files to their comments independently of whether clients can upload; it defaults to `allowClientUploadFiles || isAdminView` to preserve existing behaviour
- **CPU utilization summary styling unified for high and full allocation** — `highAllocation` and `fullUtilization` states both now render the warning colour and border style; the orange-coloured variant for `highAllocation` is removed in favour of the consistent warning token used for `fullUtilization`
- **"View Share Page" action button uses primary button styling and repositioned** — the button in the `ProjectActions` panel is now `variant="default"` (filled primary colour) instead of `variant="outline"`, making it visually distinct from secondary action buttons; the button is also moved to appear immediately above the Delete Project button so destructive and primary actions are grouped at the bottom of the panel
- **CI actions pinned and upgraded for Node 24 compatibility** — `actions/checkout` pinned to v4.2.2 and `actions/setup-node` to v4.4.0; Node.js version in the CI workflow updated to 24

## [1.2.7] - 2026-03-29

### Added
- **`useUnsavedChanges` hook** — new `src/hooks/useUnsavedChanges.ts` registers a `beforeunload` guard when a form has unsaved changes and exports a `confirmNavigation()` helper for programmatic navigation (e.g. router.push); integrated into Global Settings, Project Settings, Client detail, User edit, Invoice detail, Quote detail, and Sales Settings pages so users are warned before losing work
- **QuickBooks Actions card on Sales Dashboard** — when QuickBooks is configured a new card appears alongside the stats summary with Pull Clients, Pull Quotes, Pull Invoices, and Pull Payments buttons; each button posts to the corresponding pull endpoint with a 7-day lookback, displays a timed success or error banner, and refreshes the rollup totals; buttons are disabled while a pull is in progress
- **Sales sub-navigation in admin header** — the Sales entry in the main nav now expands into a sub-menu listing Dashboard, Quotes, Invoices, Payments, and Settings; on desktop the sub-menu opens as a hover-activated fly-out with individual icons; on mobile the hamburger menu gains an expandable inline sub-list with the same entries and a chevron toggle

### Changed
- **Sales Settings redesigned as a sidebar-nav layout on desktop** — matching the pattern introduced in v1.2.6 for Global Settings and Project Settings, a persistent left sidebar on screens ≥1024 px lists five sections (Sales Details, Tax, Sales Notifications, Stripe Checkout, QuickBooks Integration) with matching icons; the per-section Save buttons are removed and replaced with a single unified "Save Changes" button at the top of the page that persists all sections concurrently via `Promise.all`; the stacked card layout is retained on mobile
- **Client detail page tracks unsaved changes and shows inline success banner** — form data and recipient list are snapshot on load; a dirty-state comparison drives `useUnsavedChanges`; on successful save a green "Changes saved successfully!" banner appears for 3 seconds; navigating away while the form is dirty triggers a browser confirmation prompt
- **User edit page stays on page after save and warns on dirty navigation** — previously a successful save redirected to `/admin/users`; the page now shows an inline success banner and keeps the user in the edit form; the Cancel button calls `confirmNavigation()` before routing so unsaved changes are not silently discarded
- **Role dialog on Users page warns before closing with unsaved changes** — the role editor dialog intercepts all close paths (overlay click, Escape key, Cancel button) and shows a native confirm prompt when role name or permissions have been modified since the dialog was opened
- **Invoice and quote detail pages replace `alert('Saved')` with success banners** — the blocking `alert` call on both pages is replaced by a timed green "Changes saved successfully!" banner; `useUnsavedChanges` is also wired up using a JSON snapshot of all editable fields so these pages now guard against accidental navigation
- **Sales Dashboard tables use `whitespace-nowrap` on key columns** — quote number, issue date, status, and total columns (and the corresponding invoice columns) no longer wrap on narrow screens; client name columns retain a `min-w-[120px]` constraint
- **Success message copy standardised to "Changes saved successfully!"** — the previous "Settings saved successfully!" label is replaced on Global Settings, Project Settings, Client detail, User edit, Invoice, Quote, and Sales Settings pages

### Fixed
- **Security Events "Blocked" count now reflects all matching events, not just the current page** — the API runs a second scoped `count` query for `wasBlocked: true` under the same active filters and returns it as `blockedTotal`; the stats card displays that server-side total instead of counting only the rows visible on screen; a fourth stat card "Rate Limits" is added to the overview grid (layout changed from 3 to 4 columns)
- **Accent color rendered at the exact lightness the user chose** — `buildAccentOverrideCss` previously forced the CSS `--primary` variable to 50 % lightness in light mode and 60 % in dark mode regardless of the stored hex value; it now reads the actual `l` component of the stored color and applies it unchanged in both themes, so dark, muted, or very light brand colors are rendered faithfully instead of being silently brightened or dimmed
- **ProjectStatusPicker dialog no longer triggers parent-row navigation** — click events originating inside the status-change dialog (overlay background clicks, empty-area clicks within the modal content) were bubbling through the React tree to the surrounding clickable table row and triggering a page navigation; the Dialog is now wrapped in a `<span onClick={stopPropagation}>` portal boundary that absorbs those events before they reach the row handler

## [1.2.6] - 2026-03-28

### Changed
- **Global Settings redesigned as a sidebar-nav layout on desktop** — on screens ≥1024 px the former stack of collapsible accordion cards is replaced by a persistent left sidebar listing all twelve setting sections (Company Branding, Domain Configuration, Email & SMTP, CPU Configuration, Storage Overview, Dropbox Storage, Default Project Settings, Project Behavior, Developer Tools, Gotify Notifications, Browser Push, Advanced Security), each with a matching icon; clicking a section swaps the right-hand content panel without re-mounting state; the collapsible accordion view is retained unchanged on mobile; all section components gain a `hideCollapse` prop that suppresses the chevron toggle and keeps the card permanently expanded when rendered in the desktop panel
- **Project Settings redesigned as a sidebar-nav layout on desktop** — the same two-column pattern is applied to individual project settings pages; sections are dynamically filtered (Video Processing, Revision Tracking, and Feedback & Client Uploads are hidden when the project has videos disabled) and the desktop sidebar resets to "Project Details" automatically when the active section becomes unavailable; mobile users continue to see the collapsible card layout
- **Design language refreshed across light and dark themes** — card backgrounds in light mode are now pure white against a cooler blue-tinted page background, creating stronger visual lift; dark mode backgrounds gain a consistent blue tint throughout (background, cards, popovers, borders, accents, muted surfaces); corner radii are increased (base `0.875 rem`, large `1.25 rem`); shadows are softer and more layered; status-badge colours are updated to lighter tinted backgrounds with dark text in light mode for all project statuses (REVIEWED, APPROVED, SHARE_ONLY, IN_REVIEW, IN_PROGRESS), removing the high-contrast inverted badges that were hard to read at small sizes; borders on all badges are removed for a cleaner look
- **Inter typeface loaded via next/font** — `Inter` is now loaded through Next.js font optimisation (`next/font/google`) and applied via the `--font-sans` CSS variable on the `<html>` element; this eliminates the previous flash of system font and ensures consistent typography across environments
- **UI primitives updated for the new design language** — `Button` gains an `active:scale-[0.98]` micro-interaction on press; `Card` border radius increased to `rounded-xl` with a lighter shadow (`shadow-elevation-sm`) and a slightly more visible border; `Dialog` overlay darkens to `bg-black/50` with `backdrop-blur-sm` and the content panel gains `rounded-xl` corners and `shadow-elevation-xl`; `Input`, `Select`, and `Textarea` gain softened placeholder opacity (`/70`), consistent `transition-all`, and a focus-ring that also highlights the border; `Select` content uses an `xl` radius and the elevated shadow token
- **Projects dashboard table given more breathing room** — cell padding increased from `px-3 py-2` to `px-4 py-3`; header cells use `font-semibold`; table container gains `rounded-xl`, a subtle drop shadow, and a lighter border; row hover colour switches to `bg-accent/40` for better contrast with the new white-card background
- **Key Dates calendar preloads adjacent months** — when the user navigates to a month the calendar now silently fetches the previous and next months in parallel so forward/back navigation is instant; trailing and leading cells from neighbouring months are filled with real dates (styled in a dimmed inactive colour) rather than blank placeholders, giving the grid a full 6-row × 7-column structure at all times; today's date number is bolded and coloured with the accent colour; the calendar dependency array is corrected to include `monthCursor`
- **Invoices and quotes tables are click-through rows** — each row on the Invoices and Quotes list pages is now an interactive row that navigates to the detail page on click, matching the behaviour of the projects table; individual cells that contain their own interactive links stop click propagation so those elements remain independently clickable
- **Project Analytics activity page size increased** — the activity log now shows 50 entries per page (previously 20), reducing the need to paginate through recent events
- **Dependency updates** — `nodemailer` updated to 8.0.4; `mailparser` updated to 3.9.6; security overrides added for `brace-expansion` (5.0.5), `flatted` (3.4.2), `picomatch` (2.3.2 / 4.0.4 for tinyglobby), `srvx` (0.11.13), and `yaml` (2.8.3) to resolve moderate advisory flags

### Security
- **Proactive JWT refresh eliminates 401 races across browser tabs** — `SessionMonitor` now decodes the `exp` claim from the in-memory access token (without verifying the signature, which is server-only) and schedules a silent refresh 5 minutes before expiry; this means tokens are renewed while they are still valid, preventing the race where multiple tabs all detect the same expired token simultaneously and each attempt a refresh; the timer reschedules itself whenever the token store is updated (e.g. after a successful refresh in another tab)
- **Token-store events no longer broadcast cross-tab logouts after local inactivity expiry** — `apiFetch` and `attemptRefresh` now check `isCurrentWindowSessionTimedOut()` before calling `handleSessionExpired()` or `clearTokens()`; a tab whose inactivity timer has fired will silently skip the global token-clear path, preventing it from wiping the refresh token for all other open browser windows that are still active; the fix complements the single-tab session timeout introduced in v1.2.4 by also closing the gap in the token-refresh error path

## [1.2.5] - 2026-03-25

### Changed
- **Branding settings cached in-process** — a new `getBrandingSettingsSnapshot()` helper in `src/lib/settings.ts` reads branding fields once and caches them for the standard settings TTL; `layout.tsx` previously issued two separate `prisma.settings.findUnique()` calls per page render (one for metadata, one for accent/theme), both of which are now served from the shared cache; `getCompanyName()` also reuses the same snapshot; the cache is invalidated when the company logo, dark logo, or favicon is uploaded
- **Admin landing page parallelizes session and settings fetches** — the `pickLandingPage` effect previously awaited the session check before fetching settings; both requests are now issued concurrently with `Promise.all`, reducing the delay before the redirect to the first permitted menu
- **Settings API GET fetches settings and security settings in parallel** — previously the two records were fetched sequentially; they are now fetched together with `Promise.all` in a single round-trip
- **Comment notification helpers batch database reads** — `resolveCommentAuthor` previously issued sequential awaits for primary recipient, project, and recipient lookups; `handleCommentNotifications` did the same for project, video, and settings; all reads within each function are now batched with `Promise.all`
- **Video streaming session rate limit skips range requests** — byte-range requests (video seeking and scrubbing) are normal browser behaviour already covered by IP rate limiting and hotlink detection; only initial load requests (non-range) are counted against the per-session budget, preventing legitimate scrubbing activity from triggering a 429

### Fixed
- **Running Jobs panel separates failed and completed entries into distinct sections** — the panel previously grouped all finished activity under a single "Recent" label; failed uploads and failed server-side jobs (processing errors, Dropbox upload failures) now appear together under a red-labelled "Failed" section, while successful uploads and successful server jobs appear under the "Completed" section; this makes it immediately obvious when something went wrong without having to scan a mixed list
- **Running Jobs completed and failed entries sorted newest-first by finish time** — uploads now record a `completedAt` timestamp when they succeed or error, and both the completed and failed lists are ordered by that timestamp (falling back to `createdAt`); server-side completed jobs follow the same ordering so the most recent activity always appears at the top of each section
- **Running Jobs server job keys no longer collide across job types** — `CompletedServerJobRow` keys used bare numeric IDs (`done-{id}`), which could collide when a Dropbox job and a processing job happened to share the same database ID; keys now include the job type (`done-{type}-{id}` and `failed-{type}-{id}`), eliminating React reconciliation errors caused by duplicate keys
- **Deleting security events now invalidates the Redis recent-events cache** — bulk-deleting events from the security dashboard left the `security:events:recent` Redis list intact; the delete endpoint now removes that key after the database purge so the panel immediately reflects the cleared state instead of serving stale cached entries
- **Deleting a project now cascades to its security events** — the `SecurityEvent` → `Project` relation was `onDelete: SetNull`, which left orphaned event rows when a project was deleted; changed to `onDelete: Cascade` so security events are removed along with the project
- **Dropbox cloud icon in Project Analytics no longer clips long description text** — the cloud icon was rendered as a sibling element wrapping `TruncatedText`, breaking the truncation width measurement; the icon is now passed as a `suffix` prop so it renders inside the measured span and the text tooltip fires correctly on truncated entries; fixed in both the table row and the expanded detail view

## [1.2.4] - 2026-03-20

### Added
- **Running Jobs correctly surfaces upload and processing errors** — Dropbox upload failures (video originals, video assets, and album ZIP variants) and video processing failures are now reported as distinct error entries in the Running Jobs panel; each failed job shows a red `XCircle` icon and a descriptive "…failed" label instead of the previous green "…complete" badge; errored jobs are returned directly from the API so they appear immediately rather than relying on disappearance detection
- **Failed jobs in Running Jobs require manual dismissal** — completed jobs that finished with an error are never auto-purged from the Running Jobs panel; they persist until the user explicitly dismisses them, ensuring failures are not silently swept away by the 30-minute cleanup timer that still applies to successful completions
- **"UPLOAD FAILED" badge on video cards** — when any version in a video group has a Dropbox upload error (`dropboxUploadStatus: ERROR`), the collapsed video card header now shows a red "UPLOAD FAILED" badge (with `XCircle` icon) alongside the existing FAILED / PROCESSING / QUEUED badges
- **Error badges on album cards** — the album card header now shows a red "FAILED" badge when the album itself is in `ERROR` status, and a red "UPLOAD FAILED" badge (with `XCircle` icon) when a Dropbox ZIP upload has failed; the Dropbox cloud icon on the album also switches to a red `XCircle` with destructive styling and an "Dropbox upload failed" tooltip when `fullZipDropboxStatus` or `socialZipDropboxStatus` is `ERROR`
- **Running Jobs panel now shows recently completed processing jobs** — video versions that reached `READY` status within the past 30 minutes are now included in the Running Jobs API response and displayed in the panel alongside Dropbox upload completions, giving a unified view of recent activity without requiring a page reload
- **Dropbox cloud icon on Project Analytics download entries** — download-related entries in Project Analytics (Video Download, Asset Download, ZIP Download, Album Download) now show a small cloud icon (☁) next to the description when the file was served from Dropbox; album ZIP analytics now record the download source in a new `details` column on `AlbumAnalytics` so the indicator is accurate for both video and album downloads

### Fixed
- **Video processing failures no longer appear as silent completions** — previously, when a video encoding job failed the video would disappear from Running Jobs with no trace, or be detected by the client's disappearance logic and incorrectly shown as "Processing complete"; the `/api/running-jobs` endpoint now queries videos with `status: ERROR` (within the past 30 minutes) and returns them as errored processing entries with `error: true`
- **Running Jobs dismiss buttons now use type-scoped keys** — dismissing a completed or errored job entry now keys on `{type}:{id}` rather than `{id}` alone, preventing a dismissed job from accidentally suppressing a different job type that happened to share the same database ID
- **Dismissing a pinned system notification no longer returns "Notification not found"** — the delete endpoint was filtering candidates by a hardcoded type allow-list before accepting the delete, so any row whose type was valid but not in that exact list returned a 404 and the item reappeared on the next refresh; the endpoint now looks up the record by its ID and validates clearability from `details.__controls` — the same logic used when rendering the dismiss button
- **Session timeout in one tab no longer logs out other open browser tabs** — the inactivity timer now calls `expireCurrentWindowSession()`, which sets a per-window `sessionStorage` flag and clears tokens only for that tab; other tabs retain their in-memory and persisted tokens and continue working; a fresh login in any tab clears the flag so normal navigation resumes

## [1.2.3] - 2026-03-15

### Added
- **Storage Overview section in Admin Settings** — a new "Storage Overview" panel in Admin Settings shows a live breakdown of disk usage across all content types (original videos, video previews, video assets, comment attachments, original photos, photo ZIPs, project files, client files, and user files); when the storage root is on a local filesystem the panel also reports total capacity and available free space; the data is fetched from a new `/api/settings/storage-overview` endpoint and refreshes on demand
- **Auto-delete previews toggle relocated to Storage Overview** — the "Auto-delete video previews and timeline sprites when project is closed" toggle has been moved from the Project Behavior section into the new Storage Overview panel where it sits alongside the breakdown chart for clearer context
- **Recalculate storage totals relocated to Storage Overview** — the "Recalculate totals" action (previously in Developer Tools) is now surfaced inside the Storage Overview panel

### Changed
- **"Original Photos" storage row now counts full-resolution files only** — social-sized photo derivatives are no longer included in the "Original Photos" total; they are now counted under "Photo ZIP files & previews" in both the Project Data panel on project pages and the Storage Overview section in Admin Settings
- **"Video Previews" label simplified** — "Video Previews (inc. timeline previews)" has been shortened to "Video Previews" in both the Project Data panel and the Storage Overview section
- **Storage Overview section header no longer shows an icon** — the hard-drive icon next to the "Storage Overview" card title has been removed for consistency with other settings sections
- **Dropbox token refresh deduplicated** — concurrent calls to `fetchDropboxAccessToken` now share a single in-flight refresh promise; previously rapid parallel requests could trigger multiple simultaneous token refreshes against the Dropbox OAuth endpoint
- **Dropbox API calls retry on transient network errors** — all Dropbox HTTP requests now retry up to 2 times (1 s delay) on fetch-level errors such as `ECONNRESET`, `ETIMEDOUT`, and `fetch failed`; non-retryable errors and HTTP-level failures are surfaced immediately without retrying
- **Notification backlog purge tool shows stale vs. recent breakdown and larger sample** — the dry-run response now separately counts stale (>7 days old) and recent pending entries, returns up to 50 stale sample rows (up from 20) with a truncation flag, and serialises dates as ISO strings for consistent display
- **Worker notification log labels are more specific** — `project-key-date-reminders` and `user-key-date-reminders` jobs now log as "Project Key Date reminders check" and "User Key Date reminders check" respectively (previously both were "Key Date check"); the label logic is extracted into a shared `getNotificationWorkerJobLabel` helper used by both the `completed` and `failed` handlers
- **Worker Dropbox consistency scan logs the full error object** — the error logged when a Dropbox storage consistency scan fails is now the raw caught value rather than `e.message`, preserving stack traces and non-Error objects
- **Deleting an email prunes empty storage directories** — the email DELETE endpoint now removes the raw-email directory and each attachment directory after file deletion, then prunes any empty parent directories up to the project root; Dropbox-prefixed paths are stripped to a local path before pruning so the cleanup works regardless of storage provider

### Removed
- **Migrate project storage tool removed from Developer Tools** — the one-time `migrate-project-storage-yearmonth` API route and its associated UI panel have been removed; the storage migration was completed in v1.2.0 and the tool is no longer needed
- **Regenerate missing thumbnails tool removed from Developer Tools** — the `regenerate-missing-thumbnails` API route and its Developer Tools panel have been removed from the settings UI; thumbnail repair remains available via the worker

## [1.2.2] - 2026-03-14

### Added
- **System Alert notifications** - Added daily scans that check and report on app related issues, such as Dropbox vs local server inconsistencies, daily Quickbooks pull fails; a pinned notification advises users of issues and any affected videos or albums show an alert icon to highlight there is an issue
- **Social media copies toggle on album creation** — albums now have a "Create social media sized copies" checkbox (enabled by default) that controls whether social-sized photo derivatives (long edge scaled to 2048px) and the Social Media Sized ZIP are generated; when disabled, social derivative jobs are skipped, the social ZIP download button is hidden on share pages, and the admin status display reflects that social copies are disabled
- **Dropbox upload toggle on album creation** — albums now have an "Upload to Dropbox" checkbox that controls whether album ZIPs are uploaded to Dropbox; previously Dropbox upload was automatic when configured — this gives users explicit control; when disabled, ZIPs remain on the local server only
- **Social copies toggle on existing albums** — a Layers icon button next to the Dropbox cloud button lets admins enable or disable social-media-sized copies after album creation; enabling queues social derivative generation for all existing READY photos and a social ZIP build; disabling deletes all social derivative files, the social ZIP, and any Dropbox social ZIP copy, and frees the associated storage

### Removed
- **Orphan Comments cleanup developer tool** — removed; the historical missing-video comment bug was fixed in an earlier release and the cleanup tool is no longer required

### Changed
- **Video deletion prunes empty storage folders** — after a version is deleted, the empty version-label folder is removed and, when it was the last remaining version, the now-empty parent video folder is also removed; pruning stops at the project's `videos/` root
- **Deleting a Dropbox-backed video also removes the local server copy** — the storage delete path cleans up both the Dropbox object and the mirrored local file from `STORAGE_ROOT`
- **Dropbox folder cleanup scope limited to the project root** — ordinary file and version deletes no longer prune through `projects/` or the client folder; deleting a project still removes the full project root explicitly while client-root folders are left untouched even when otherwise empty
- **Deleting a client removes the client storage root when safe** — the client delete route removes the full client folder on both local and Dropbox when no projects remain; if projects still exist, the delete is blocked to avoid orphaning project records while removing their files
- **Orphaned files cleanup scans managed storage beyond project roots** — the orphan-file scanner walks the full managed storage root and cross-checks project media, imported emails, comment and project uploads, client files, user files, and stored branding assets while still ignoring temporary upload chunks and redirect metadata
- **Notification backlog tool includes diagnostic sample rows and system-local dates** — the backlog dry run includes a sample of pending queue entries with type, project, pending targets, retry counts, failure flags, and payload; `Oldest entry` uses the shared timezone-aware formatter
- **Delete previews for closed projects tool includes timeline VTT files** — the closed-project preview cleanup detects and removes `timelinePreviewVttPath` files alongside preview MP4s and timeline sprite directories

## [1.2.1] - 2026-03-13

### Added
- **Last Access column on projects dashboard** — the projects table now has a "Last Access" column showing when a client or guest last accessed the share page; the timestamp is written via a raw SQL update so `updatedAt` (Last Activity) is not bumped; falls back to the most recent `SharePageAccess` ACCESS event so projects with visits before this feature was added still show a meaningful value

### Changed
- **Dropbox section description updated to accurately reflect scope** — the Dropbox configuration card in Admin Settings now states that video originals, assets, and album ZIPs can all be offloaded to Dropbox, replacing the previous description that only mentioned approvable video originals

### Fixed
- **Admin IPs excluded from Last Access tracking** — visiting a share page from an admin IP no longer advances the Last Access timestamp when "Exclude internal/admin IPs from analytics" is enabled
- **Enabling Dropbox on a video now also queues existing assets for upload** — toggling Dropbox on a video version now marks all attached assets as `dropboxEnabled` and queues them for Dropbox upload in the same operation; previously only the video original was uploaded and assets were left behind
- **Running Jobs panel now shows recently completed Dropbox uploads** — Dropbox upload completions from the past 30 minutes (for both video originals and assets) are included in the running-jobs API response and surfaced in the Running Jobs panel
- **Asset panel refreshes immediately after Dropbox toggle** — toggling Dropbox on a video version now triggers an asset list refresh so asset Dropbox statuses update without a manual page reload

## [1.2.0] - 2026-03-12

### Added
- **Per-item Dropbox upload toggle for video versions** — Eeach video version has an explicit on/off control; on the Add Video/s popup, a "Store original in Dropbox" checkbox is shown and is only enabled when approval is turned on (since Dropbox is only used for approved download delivery); toggling on queues a background Dropbox upload job; toggling off confirms with a prompt then deletes the file from Dropbox and reverts the storage reference to the local copy; uploaded assets automatically inherit the parent video's Dropbox setting
- **Automatic Dropbox upload for video assets** — when a video version has Dropbox enabled, any new assets uploaded to that version are automatically queued for Dropbox upload; assets follow the parent video: disabling Dropbox on the video cascades to all its assets, and deleting the video or project deletes asset Dropbox copies as well
- **Automatic Dropbox upload for album ZIPs** — newly created albums automatically enable Dropbox when Dropbox storage is configured; both Full and Social ZIP files are uploaded to Dropbox as soon as ZIP generation completes; when photos are added or removed, old Dropbox ZIP copies are deleted and new uploads are queued after ZIP regeneration
- **Album ZIP Dropbox toggle** — admins can manually enable or disable Dropbox for an album's ZIP files via the Cloud icon on the album card; enabling queues uploads for any variants whose ZIPs already exist on disk; disabling deletes Dropbox copies and clears tracking fields
- **Dropbox vs. Local Server download toggle on share pages** — the video asset download modal now shows a toggle to switch between downloading from Dropbox (default) or from the local server; includes descriptive text about Dropbox (high-speed CDN, unlimited concurrent downloads) vs Local Server (direct transfer, no third-party dependency) tradeoffs
- **Album ZIP downloads served from Dropbox** — when an album has Dropbox-complete ZIPs, the photo-zip download endpoint redirects clients to a temporary Dropbox link (307) instead of streaming from the local server, offloading bandwidth and enabling higher concurrency; falls back to local streaming if the Dropbox link fails
- **Album ZIP and Dropbox jobs in Running Jobs** — the Running Jobs panel now shows album ZIP generation jobs (PENDING/ACTIVE from BullMQ), album ZIP Dropbox upload jobs (with progress), and per-asset Dropbox upload jobs alongside video-version Dropbox uploads
- **Delete previews for closed projects tool in Developer Tools** — a new "Delete previews for closed projects" section in Admin Settings → Developer Tools scans all CLOSED projects that still have preview files (480p, 720p, 1080p), or timeline sprite directories on disk; a dry-run reports how many closed projects, videos, and files would be affected; a "Delete previews" button commits the deletion and clears the corresponding database fields so previews regenerate automatically if the project is ever re-opened
- **Configurable upload and download chunk sizes** — new settings in Developer Tools allow admins to tune TUS upload chunk size (8–512 MB, default 200 MB) and server download chunk size (1–64 MB, default 16 MB); all upload forms (videos, assets, photos, emails, project files, user files) fetch the configured upload chunk size from a lightweight metadata endpoint and adapt automatically; download chunk size controls how much data is read per iteration when streaming files to clients
- **Exclude internal IPs from analytics toggle** — new Developer Tools setting to suppress analytics recording (share page access, video events, album events) for IP addresses that match recent admin login history; enabled by default
- **Expanded security event logging** — 13 new security event types covering admin session lifecycle (logout, token refresh failure), account management (user create, delete, deactivate, reactivate, role change, password change), security configuration changes, blocklist IP/domain modifications, and permission-denied access attempts; all events include IP address, acting user, and resource details
- **Dropbox integration documentation** — new comprehensive guide in `docs/dropbox-integration.md` covering Dropbox app setup, OAuth token generation, feature overview, architecture, queue configuration, and troubleshooting
- **Regenerate missing video thumbnails tool in Developer Tools** — a new "Regenerate missing video thumbnails" section in Admin Settings → Developer Tools scans all READY and ERROR videos for missing or null system thumbnails; a dry-run reports affected counts and a sample list; a "Queue repairs" button queues thumbnail-only regeneration jobs for those videos without touching their previews or timeline sprites; custom asset-based thumbnails and closed project videos are excluded

### Changed
- **File storage reorganized into human-readable client/project paths** — all project files (video originals, previews, timeline sprites, thumbnails, video assets, album photos, and album ZIPs) are now stored under a named folder hierarchy: `clients/{clientName}/projects/{projectTitle}/`, with video versions nested at `videos/{videoName}/{versionLabel}/` and albums at `albums/{albumName}/`; this replaces the previous date-partitioned, ID-based layout (`projects/YYYY-MM/{id}/`); new uploads always land in the canonical location, and Dropbox object paths follow the same naming; existing projects can be migrated to the new layout with the "Migrate project storage" tool in Admin Settings → Developer Tools
- **Album ZIP filenames include the album name** — ZIP files served to clients are now named after the album (e.g. `Wedding_Day_Full_Res.zip`, `Wedding_Day_Social_Sized.zip`) instead of the generic `photos_full.zip` / `photos_social.zip`
- **Project approval no longer requires per-video approval** — the APPROVED status can now be set on a project regardless of whether individual video versions have been approved; the `canApprove` guard and the "Approve one version of each video first" hint in the status picker are removed
- **Multi-video upload modal auto-closes after completion** — after all videos are successfully queued, the modal displays a 3-second countdown with a smooth animation before auto-closing; a new Dropbox toggle checkbox is available per video item when Dropbox is configured
- **Video player download button disabled during Dropbox upload** — the download button for Dropbox downloads on share pages shows "Uploading…" while the video original is still being uploaded to Dropbox, preventing premature download attempts that would fail

### Fixed
- **Storage normalization migration hardened** — the "Migrate project storage to client/project layout" Developer Tools action now: places asset files inside per-version `assets/` subdirectories (previously they were incorrectly placed in the video root); strips legacy upload-timestamp prefixes (`asset-*`, `photo-*`, `photos-*`) from asset and album photo filenames; correctly preserves custom asset-based thumbnails while still moving system-generated `thumbnail.jpg` files to the canonical location; prunes empty legacy storage folders after migration; resolves existing folder roots from actual preview/timeline paths rather than guessing from the DB path alone; detects Dropbox-backed files from actual `dropbox:` storage-path prefixes rather than metadata flags, eliminating false-positive migration reports on canonical local projects
- **Album photo social derivative files moved during migration** — the migration now locates and moves the `<photo>-social.jpg` derivative alongside its parent photo, preventing stale social paths from causing album ZIP worker failures
- **Album ZIP worker no longer crashes on missing social derivative files** — if a social-scaled file is absent when building the social ZIP, the entry is skipped with a debug log rather than throwing an uncaught stream error that previously killed the worker process
- **Video worker resolves stale original file paths before processing** — when a queued job's `originalStoragePath` no longer matches the actual on-disk location (e.g. after storage normalization), the worker now searches canonical and legacy candidate paths before failing; the same resolution logic is shared by the thumbnail repair tool and the Dropbox toggle flow via a new `src/lib/resolve-video-original.ts` helper, eliminating the previous triple duplication

## [1.1.9] - 2026-03-10

### Added
- **Multi-resolution video previews (480p, 720p, 1080p)** — Projects and global settings can now select one or more preview resolutions simultaneously using checkboxes (480p, 720p, 1080p); the worker processes all selected resolutions in a single job, storing them in separate database fields (`preview480Path`, `preview720Path`, `preview1080Path`); adding a resolution from Project Settings queues preview-only regeneration jobs for all READY videos without touching the thumbnail or timeline previews; removing a resolution deletes the corresponding preview files immediately; backed by a new database migration that converts the single `previewResolution` field to a JSON-array `previewResolutions` field on both `Project` and `Settings`
- **Video player quality selector** — when a video has more than one preview stream available, a gear-icon quality button appears in the player controls on both desktop and mobile rows; choosing a specific quality (480p / 720p / 1080p) overrides Auto mode, which selects quality based on player container width (≥1200 px → 1080p, ≥640 px → 720p, otherwise 480p) via a ResizeObserver and automatically downgrades when the video buffers for more than 700 ms; the button label shows the active resolution, e.g. `Auto (720p)`
- **Auto-delete video previews and timeline sprites on project close** — a new "Auto-delete video previews and timeline sprites when project is closed" toggle in Admin Settings → Default Project Settings; when enabled, closing a project deletes all preview files and timeline sprite directories from storage and clears the corresponding database paths; re-opening the project automatically re-queues any READY videos with missing previews for regeneration
- **Pending job cancellation on project close** — closing a project (both manually and via the scheduled auto-close worker) now cancels all waiting, delayed, and prioritized BullMQ jobs for that project across the video-processing, album-photo-ZIP, and album-photo-social queues, preventing orphaned jobs from running after the project is shut down
- **Orphan project files cleanup tool in Developer Tools** — a new "Orphan project files cleanup" section in Admin Settings → Developer Tools; a dry-run scan walks the entire project storage tree and cross-references every physical file against the full set of database-referenced paths (original videos, all preview resolutions, timeline sprites, thumbnails, video assets, album photos, album ZIPs, comment uploads, project files, and imported emails); the report shows orphan file count, total orphan bytes, sample paths and affected project IDs; a second "Delete orphans" button commits the deletion and prunes any empty directories left behind; backed by a new `POST /api/settings/cleanup-orphan-project-files` endpoint

### Changed
- **Storage breakdown now shows original vs. generated file sub-totals** — the Project Storage Usage panel now splits the "Videos" row into "Original Videos" and "Video Previews (inc. timeline previews)" and splits "Photos" into "Original Photos" and "Photo ZIP files" when the API returns the detailed per-file breakdown; the storage API now queries per-video and per-album storage paths individually to compute these sub-totals instead of relying on approximate aggregate sums
- **Reprocess endpoint supports targeted per-resolution and partial regeneration** — `POST /api/projects/[id]/reprocess` now accepts `previewResolutions` (an array of specific resolutions to regenerate), `regenerateThumbnail: false` (skip thumbnail regeneration and keep the existing one), and `regenerateTimelinePreviews: false` (skip timeline preview regeneration); targeted resolution jobs only delete and nullify the specific preview fields requested rather than wiping all three; the endpoint now rejects requests for CLOSED projects with HTTP 409
- **Closed projects fall back to original files when previews are absent** — the admin share page now fetches an original-quality token for CLOSED projects (not only approved videos), so all videos remain watchable via the admin share page even after previews have been auto-deleted on close; the original token is used as a fallback for all three stream-URL slots (480p / 720p / 1080p)
- **Watermark reprocess modal only fires on content-affecting changes** — a project title change alone no longer triggers the "reprocess existing previews?" modal unless the project uses the default auto-title watermark format (watermark enabled and no custom watermark text set); changing the title with a custom watermark text or with watermarks disabled now saves immediately without showing the modal
- **Running Jobs processing phase label extracted to shared utility** — `getProcessingPhaseLabel()` is now defined in `src/lib/video-processing-phase.ts` and shared by the worker and the Running Jobs component; the initial `processingPhase` value written when a video transitions to PROCESSING is now `null` (instead of `'transcode'`), so the phase display in the Running Jobs dropdown starts blank and is only set once the worker begins each stage
- **Storage write-path resolution always targets the canonical date-partitioned folder** — a new `validatePathForWrite()` function is used when writing files; it bypasses the legacy-path short-circuit that applied during reads (`resolveRedirectedProjectPath` now accepts a `forWrite` flag), ensuring all new writes land in the correct `projects/YYYY-MM/<projectId>` location even when an older file still exists at the legacy `projects/<projectId>` path

### Fixed
- **Video token endpoints return 404 when a requested quality has no generated preview** — both `/api/admin/video-token` and `/api/share/[token]/video-token` now verify that the corresponding preview path field (`preview480Path`, `preview720Path`, `preview1080Path`) exists in the database before issuing a content token; requests for a quality that was never generated or that was deleted after project close now receive an explicit 404 instead of a token that silently points to a missing file, preventing broken playback

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
- **Synthetic connection test endpoint for browser-to-server throughput checks** — the Video Information panel now runs its speed test against a dedicated authenticated byte stream at `GET /api/connection-test` instead of probing real video files, so the measurement reflects the browser’s path to the server without depending on preview/original file size alignment or media-specific range behavior.
- **Connection test progress bar in Video Information** — while the synthetic speed test is running, the dialog now shows a live progress bar using the app's existing progress component so users can see the 10-second sample is actively in flight.
- **CPU Configuration in Admin Settings** — a new "CPU Configuration" section above Default Project Settings lets admins configure FFmpeg threads per job, concurrent video processing jobs, and toggle dynamic thread allocation from the UI; defaults are established at startup based on detected hardware; settings are persisted in Redis and picked up by the worker within 60 seconds without a container restart (concurrency changes still require restart); the UI warns when the configured allocation would saturate all system threads.

### Changed
- **`TRUSTED_PROXIES` documentation** — README, INSTALLATION guide, and SECURITY guide now all document the `TRUSTED_PROXIES` environment variable and explain why it must be set for accurate rate limiting, IP blocklisting, and security event logging when the app is running behind a reverse proxy.
- **Download analytics now record actual outcomes instead of request starts** — download tracking now writes `DOWNLOAD_SUCCEEDED` and `DOWNLOAD_FAILED` events with transfer metadata in `VideoAnalytics.details`, the analytics UI shows success/failure status and average speed for completed downloads, and aggregate download counts only include successful downloads while still honoring legacy `DOWNLOAD_COMPLETE` rows. Previously downloads were counted from the initialization of a download, which produced inaccurate analytics in situations where downloads failed or were cancelled.
- **HTTPS mode now uses a single source of truth** — transport headers were already decided at startup from `HTTPS_ENABLED`, but passkey/WebAuthn validation had been reading the database-backed `httpsEnabled` setting, which allowed the admin UI to temporarily put the app into a mixed state until the next restart overwrote the DB value again; HTTPS mode is now read directly from `HTTPS_ENABLED` for both startup headers and runtime checks, the settings API no longer writes the `httpsEnabled` column, and Advanced Security Settings now shows a read-only HTTPS status indicator instead of an editable toggle; the GET security settings endpoint still returns the current `httpsEnabled` state for display purposes, and existing database values are ignored.
- **Running Jobs thread allocation uses the configured thread pool** — the `GET /api/running-jobs` endpoint now calls `loadCpuConfigOverrides` on each request so thread counts shown in the Running Jobs dialog always reflect the current Redis-backed CPU settings; dynamic scaling is capped by `alloc.maxThreadsUsedEstimate` rather than a hardcoded constant, so the displayed per-job allocation matches what the worker is actually using.
- **Connection speed test now runs for a fixed 10-second window** — rather than measuring a single 32 MB range request to completion, the test streams as much data as possible within 10 seconds by sending successive range requests and wrapping back to the start when the file is exhausted; the result panel now shows total bytes transferred and elapsed seconds alongside the speed figure.

### Fixed
- **Project-page video downloads now keep the original uploaded filename** — admin downloads triggered from the video filename on the project page now use `video.originalFileName` in the `Content-Disposition` header instead of falling back to a project-title-based filename for unapproved videos.
- **Advanced Security Settings now apply immediately after save** — saving security settings now invalidates both the in-memory settings cache and the shared Redis security-settings cache, so changes like rate limits, analytics/security logging toggles, and safeguard limits no longer wait for cache expiry before taking effect.
- **Upload cancellation no longer triggers false errors or queue stalls** — `UploadManagerProvider` now sets a `cancelled` flag on a job before aborting its TUS upload; subsequent `onProgress`, `onSuccess`, and `onError` callbacks check this flag and exit early, preventing stale TUS events from re-queueing the next upload or surfacing spurious error toasts.
- **Deleting a video now immediately cancels its in-progress upload** — when a video is deleted from the project page, `VideoList` dispatches a `video-deleted` custom event; `UploadManagerProvider` listens for it and aborts and removes any active upload for that video so orphaned uploads no longer continue running after the video record is gone.
- **Video processing jobs no longer crash when a video is deleted mid-process** — all worker `prisma.video.update` calls are routed through a new `updateVideoRecord` helper that detects Prisma `P2025` (record not found) errors; on a missing video, progress updates are silently skipped and the overall job exits cleanly rather than throwing an unhandled error and retrying.
- **Stale in-flight downloads are now marked failed on worker restart** — the worker runs a 60-second interval that calls `cleanupStaleTrackedDownloads` to flip any download records that were started but never completed (e.g. due to a container restart) to `DOWNLOAD_FAILED`, preventing them from permanently inflating in-progress counts.
- **TUS temp files are cleaned up when the target video record is missing** — the upload finish handler in `POST /api/uploads` now calls `cleanupTUSFile` when the video lookup returns nothing, so orphaned TUS files are not left on disk when a video is deleted before its upload completes.

## [1.1.7] - 2026-03-07

### Added
- **Connection speed test in Video Information panel** — a new "Speed Test" button appears in the comment panel header for any video with a playable stream; clicking it opens the Video Information dialog and immediately runs a two-phase test: a 64 KB ping to measure latency followed by a 32 MB byte-range download to measure throughput; results show average speed (Mbps), latency (ms), the actual bytes sampled, an estimated full-file download time, and a qualitative assessment of the connection; results are cached in `sessionStorage` per video for one hour so re-opening the panel restores the last reading without re-running; the test sources the best available URL in priority order — approved download token, 1080p preview stream, 720p preview stream — so it works on all video versions, not just approved ones
- **User active/inactive toggle** — admin users (excluding system admins) can now be suspended from the Users list and from the Edit User page; toggling to inactive immediately revokes all current tokens and signs the user out of every active session; re-enabling restores normal access on next login; system admin accounts cannot be disabled; backed by a new `active` boolean column on the `User` table (default `true`, indexed) with a matching database migration

### Changed
- **Approved video token fetching always prefers preview streams for playback** — when a video is approved, the share page and admin share page now always request separate 720p/1080p preview tokens alongside the original download token; the original-quality token is used only as the `downloadUrl` and as a playback fallback when preview streams are absent; the previous watermark branch that forced original-quality streams for both playback and download is removed, so watermarked approved videos now always play back from the lower-bandwidth preview
- **Share session rate limiting is now separate from admin session rate limiting** — `GET /api/content/[token]` now reads `shareSessionRateLimit` from security settings (default 300 req/min) for non-admin sessions instead of sharing the same `sessionRateLimit` counter used by admins; download chunk size reduced from 50 MB to 16 MB to keep per-chunk transfer times manageable on slow connections
- **Fullscreen comment input suppressed after approval** — once a project or video is approved, the floating fullscreen comment overlay on the video player is hidden and its toggle button is removed; backed by a new `disableFullscreenCommentsUI` prop on `VideoPlayer` passed down from both share and admin share pages when `commentsDisabled` is true

### Fixed
- **Passkey sign-in now returns full RBAC role and permissions** — `verifyPasskeyAuthentication` previously returned a stripped `AuthUser` with no `appRoleId`, `appRoleName`, or `permissions`, causing passkey-authenticated users to lose their role-based menu visibility and access controls until they re-authenticated via password; the credential query now fetches the full role object and the returned result includes all fields matching the password/OTP login path
- **Video worker now routes processed files through the storage abstraction** — `processTimelinePreviews`, `processPreview`, and `processThumbnail` previously constructed absolute paths directly from `STORAGE_ROOT`, bypassing the year-month redirect index; they now call `moveUploadedFile` from the storage layer so all processed files are written to (and remain discoverable via) the correct logical path regardless of storage layout

### Security
- **Disabled users are blocked across all authentication paths** — `verifyCredentials` (password and OTP login), `refreshAdminTokens` (token refresh), `getCurrentUserFromRequest`, `getCurrentUser`, `getAdminOverrideFromRequest`, and `verifyPasskeyAuthentication` all now filter by `active: true`; disabling an account immediately invalidates all existing access and refresh tokens so the user is signed out of every session without waiting for token expiry

## [1.1.6] - 2026-03-06

### Added
- **Live Client Activity monitor in the admin header** — added a new eye-icon dropdown to the left of Running Jobs that shows recently active client sessions, including share-page viewing, video streaming, video downloads, and asset downloads; clicking an item opens the relevant project for internal users

### Changed
- **Client activity is now tracked as short-lived live presence instead of analytics-only history** — share-page access and authenticated content requests now write lightweight Redis presence records for the last 2 minutes, allowing admins to see what clients are doing right now even when historical analytics collection is disabled; the new `GET /api/client-activity` endpoint applies the same project visibility and assignment filtering as other admin activity surfaces

## [1.1.5] - 2026-03-06

### Changed
- **CPU thread budget now reserves threads for the OS/app rather than targeting a fixed fraction** — `getCpuAllocation()` previously budgeted `floor(threads × 0.5)` for FFmpeg, meaning half of all cores were left idle even when no other load was present; it now subtracts a small fixed reservation (2 threads for ≤4 logical threads, 4 threads otherwise) and gives the remainder to FFmpeg, so an 8-thread machine gets a 4-thread budget under the old model but a 4-thread budget under the new one at low thread counts and a 4-thread budget either way — and a 16-thread machine goes from 8 threads to 12 threads available for video work; the `reservedSystemThreads` value is now included in the `CpuAllocation` object and printed in the startup log; the `DEFAULT_VIDEO_CPU_BUDGET_FRACTION` constant is removed
- **Running Jobs now inspects the live BullMQ queue for accurate QUEUED/PROCESSING state** — the `GET /api/running-jobs` endpoint previously inferred queue status only from the database `status` field, which could lag behind reality; it now calls `videoQueue.getJobs(['active'])` and `getJobs(['waiting', 'prioritized', 'delayed'])` and cross-references video IDs so each job shows the real queue position; `processingProgress` is forced to 0 for genuinely QUEUED jobs instead of showing a stale non-zero value
- **Running Jobs shows video version labels** — both upload rows and processing rows in the Running Jobs dropdown now display the version label (e.g. `v2`, `Director's Cut`) alongside the video name using a new `VideoNameWithLabel` component; `versionLabel` is propagated through the API response and the `UploadJob` / `ProcessingJob` types in `UploadManagerProvider`

### Fixed
- **Project switching dialog no longer steals focus from the video player** — the "Other Current Projects" dialog on share pages was rendered as a modal, causing the browser to move focus into the dialog on open and return it to the trigger on close, which paused the video and prevented keyboard shortcuts from working; the dialog is now non-modal (`modal={false}`) with both `onOpenAutoFocus` and `onCloseAutoFocus` suppressed
- **Project storage year-month routing corrected for uploads** — `uploadFile` and `moveUploadedFile` now call a new `ensureProjectStorageLayout()` helper before writing, guaranteeing the `projects/YYYY-MM/<projectId>` directory and redirect stub are bootstrapped even when no prior redirect entry exists; previously an upload arriving before the redirect index was populated could silently land in the legacy `projects/<projectId>` root instead of the dated subfolder, causing the file to remain inaccessible via storage-path lookups after migration
- **`resolveRedirectedProjectPath` now falls back to filesystem scan** — if neither the central redirect index nor the per-project stub file contains an entry, the path resolver now scans for an existing `projects/YYYY-MM/<projectId>` directory so files written before the redirect entry was created are still served correctly
- **Year-month migration merges misplaced content** — the Developer Tools "Migrate Project Storage" action now detects the case where a project already has a `projects/YYYY-MM/<projectId>` folder but files were subsequently written back to the legacy root (e.g. before a redirect stub existed), and recursively merges that misplaced content into the correct dated location; previously the migration would count such projects as already-migrated and leave the orphaned files behind
- **Project creation uses consolidated `ensureProjectStorageLayout`** — the inline year-month folder creation in `POST /api/projects` is replaced with the new shared helper, ensuring the exact same idempotent bootstrap logic runs for new projects and for uploads; the log level for storage-init failures is also raised from `warn` to `error` so infrastructure faults are not silently swallowed

## [1.1.4] - 2026-03-05

### Added
- **Authenticated client project switching** — password and OTP recipients on client share pages can now switch between other current projects for the same client when the target project is in an allowed active status; guest users are excluded, and switching remains blocked for `NOT_STARTED` and `CLOSED` projects
- **Project-switching controls in settings** — added a global default toggle in Admin Settings → Default Project Settings and a per-project toggle in Project Settings → Security so admins can disable project switching platform-wide or on individual projects; server-side enforcement checks both source and destination projects
- **Internal user notes and file storage** — admin user records now support freeform notes plus uploaded internal files such as agreements, insurance certificates, and rate sheets, backed by new user-file APIs, uploads, and worker validation

### Changed
- **Share-page analytics now record project-switch flow explicitly** — switching into a project records an arrival event with the origin project name, and switching away records a matching "changed to" event on the project being left; password sessions are labeled as Password User and OTP sessions continue to preserve the authenticated email address
- **Installation docs now standardize on `docker compose`** — README and installation instructions now use the Docker Compose v2 CLI form consistently and clarify that the setup scripts are optional convenience helpers, not a requirement; admins can still generate and manage their own secrets manually if preferred
- **FFmpeg CPU limits now align much more closely with the configured thread budget** — the worker already budgets against logical CPU threads (not physical cores), but FFmpeg could still over-parallelize internally; preview transcodes now cap both decode and encode thread usage explicitly, and all FFmpeg paths pin `-filter_threads 1` so lightweight filter graphs do not silently spawn a full-CPU pool; timeline generation still scales dynamically with the active-job count, while thumbnail extraction uses the auxiliary `TIMELINE_FFMPEG_THREADS_PER_JOB` allocation

### Fixed
- **Timeline-only regen jobs now appear correctly in Running Jobs** — toggling "Enable Timeline Previews" on in project settings queues timeline-only worker jobs while the video stays in `READY` for uninterrupted playback; the Running Jobs endpoint now includes `READY` videos with a non-null `processingPhase`, the queueing path marks them as `timeline` immediately, and the worker clears that marker on completion or failure so jobs do not get stuck in the dropdown if queueing or processing fails
- **Reprocessed videos show correct QUEUED → PROCESSING progression** — the `POST /api/projects/[id]/reprocess` endpoint (triggered by watermark or resolution changes) was setting all videos to `PROCESSING` immediately, even when the worker had not yet picked them up; this made every video look like it was actively being encoded in Running Jobs, hiding the true queue depth; the endpoint now sets `QUEUED` (matching the upload flow) and lets the worker advance to `PROCESSING` when it begins work
- **Running Jobs now shows accurate per-job thread allocation** — the dropdown now displays badges such as `(4/8 threads)` beside active processing phases, including timeline-only `READY` jobs; the API computes the allocation per job/phase so thumbnails, transcodes, and timeline generation each report the thread count they actually use instead of sharing one approximate global value
- **Scheduled internal comment digests now fail cleanly when nobody can receive them** — if a project has no assigned users with notifications enabled, the queued digest is now marked skipped with a recorded reason instead of remaining pending indefinitely

## [1.1.3] - 2026-03-05

### Changed
- **Timeline preview toggle no longer triggers a full video reprocess** — the "Enable Timeline Previews" switch in project settings previously detected as a processing-settings change and showed the same ReprocessModal as watermark or resolution changes, offering "Save Without Reprocessing" or "Save & Reprocess"; the toggle is now handled entirely outside that flow: turning it **OFF** immediately deletes sprite directories from storage and clears the three timeline DB fields (`timelinePreviewsReady`, `timelinePreviewVttPath`, `timelinePreviewSpritesPath`) for every video in the project without any modal; turning it **ON** queues a lightweight timeline-only background job for each READY video that does not already have previews — the worker downloads the original source file, generates sprite sheets and the WebVTT index, updates the DB, and exits, leaving the video in READY status throughout so clients can keep watching uninterrupted; backed by a new `POST /api/projects/[id]/timeline-previews` endpoint (`action: 'remove' | 'generate'`) and a new `timelineOnly` code path in the video worker that skips all transcode and thumbnail stages

### Fixed
- **`TypeError: Invalid state: Controller is already closed` errors in streaming routes** — 11 API endpoints that wrap a Node.js `ReadStream` in a Web `ReadableStream` were vulnerable to a race condition where the runtime called `controller.enqueue()` / `controller.error()` / `controller.close()` after the controller had already been closed; two patterns triggered this: (1) pull-based routes where the runtime issues one final `pull()` after the `end` event has already called `close()`, and (2) push-based routes where the client disconnects, `cancel()` destroys the underlying Node.js stream, the stream emits a trailing `error` event, and the `error` handler calls `controller.error()` on an already-closed controller; all 11 affected routes are now guarded by a `closed` boolean that is set to `true` on the first `close()` / `error()` call and checked before every subsequent controller interaction; affected routes: `api/content/[token]`, `api/content/photo/[token]`, `api/videos/[id]/download`, `api/videos/[id]/assets/[assetId]`, `api/projects/[id]/emails/[emailId]/attachments/[attachmentId]`, `api/projects/[id]/files/[fileId]`, `api/comments/[id]/files/[fileId]`, `api/clients/[id]/files/[fileId]`, `api/branding/favicon`, `api/branding/logo`, `api/branding/dark-logo`

## [1.1.2] - 2026-03-05

### Added
- **Per-phase progress in Running Jobs** — the Running Jobs dropdown now shows which processing stage is active ("Processing previews…" / "Generating thumbnail…" / "Generating timeline previews…") with an independent 0–100% progress bar for each phase; progress is driven by a new `processingPhase` database field written by the worker, so the UI always reflects the real current operation; the video list on the Projects page continues to show the generic "Processing previews…" badge unchanged

### Fixed
- **CRITICAL: Timeline previews (video scrub bar hover sprites) were never generated** — `processTimelinePreviews` was guarded by `tempFiles.preview`, a ref that is explicitly deleted from the temp-file map after `processPreview` moves the transcoded file to storage; the guard always evaluated to `false`, meaning no video had ever produced hover-preview sprites since the feature was introduced; the guard is removed and the input is changed to `videoInfo.path` (the original source file), so sprite sheets are now generated correctly for every video with timeline previews enabled
- **Dynamic FFmpeg thread scaling for lone jobs** — when fewer jobs are actively processing, each job now receives proportionally more FFmpeg threads up to the full configured CPU budget; a single job gets all `budgetThreads` threads rather than the static `budgetThreads / maxConcurrency` allocation, significantly reducing transcode time for large files when the queue is not at capacity; the FFmpeg preset (`faster` / `fast` / `medium`) remains fixed to the statically configured threshold and is not affected by the active job count
- **Large file downloads no longer fail on slow connections** — the Node.js-to-Web-ReadableStream wrapper used for all video/asset downloads was push-based: `createReadStream` fired `data` events as fast as the disk could read, each chunk was immediately enqueued via `controller.enqueue()`, and the Node.js stream was never paused; for a 1 GB file on a client with a slower connection than disk throughput (i.e. always), the Web ReadableStream's internal queue grew unbounded in memory, eventually causing OOM pressure, stream errors, or HTTP-layer timeouts that forced the client to retry the download from scratch; converted both the `/api/content/[token]` helper (`createWebReadableStream`) and the `/api/videos/[id]/download` inline wrapper to a pull-based model — data is only read from disk when the consumer (browser) calls `pull()`, and the Node.js stream is immediately paused after each chunk, keeping server memory flat regardless of file size or transfer speed
- **Download tokens use a dedicated 2-hour TTL** — video and asset download tokens previously inherited the client session timeout, so downloading a large file on a slower connection could fail mid-transfer when the token expired in Redis; download tokens now use a fixed 2-hour TTL (`DOWNLOAD_TOKEN_TTL`) independent of the session timeout, and a separate cache key (`download` / `asset-download`) so they don't collide with shorter-lived streaming tokens; the `/api/content` endpoint now returns `410 Gone` with "Download link has expired" when a download token has expired, instead of a generic 403
- **Removed Node.js DEP0169 `url.parse()` deprecation warning from browser-push notifications** — `web-push` v3.6.7 (latest) still calls `url.parse()` internally; patched the dependency to use the WHATWG `URL` API via `patch-package`, and ensured Docker production builds apply the patch consistently

## [1.1.1] - 2026-03-05

### Fixed
- **Large video processing no longer crashes the worker** — transcoding a multi-GB video (e.g. 6+ GB / 90+ minutes) caused the FFmpeg `onProgress` callback to fire hundreds of concurrent `prisma.video.update()` calls, exhausting the Prisma connection pool (limit 17, timeout 10 s) with error `P2024`; the unhandled error crashed the Node.js process, the container restarted, BullMQ detected a stalled job and re-queued it, and the cycle repeated indefinitely — the logs show the same video picked up 6+ times with interleaved output before finally failing with "job stalled more than allowable limit"; fixed by (1) throttling progress DB writes to at most once every 3 seconds with an in-flight guard so only one query is active at a time, (2) catching and logging any progress-update error instead of letting it bubble up as an unhandled rejection, and (3) configuring the BullMQ video worker with `lockDuration: 600 000 ms` (10 min, auto-renewed every 5 min), `stalledInterval: 300 000 ms`, and `maxStalledCount: 2` so that long-running transcodes are not prematurely declared stalled
- **Notification bell hides internal fields and uses human-readable labels** — the bell dropdown no longer shows raw database field names (`viewUrl`, `salesQuoteId`, `clientName`, etc.) in notification detail lines; `viewUrl`, `salesQuoteId`, and `salesInvoiceId` are now hidden (navigation is handled by clicking the notification row), and remaining fields are mapped to clean labels (`clientName` → "Client", `quoteNumber` → "Quote", `invoiceNumber` → "Invoice", `projectTitle` → "Project"); any unknown camelCase or underscore-separated field name is automatically converted to Title Case words as a fallback
- **Unaccepting a quote now shows the correct "Opened" status immediately** — the `PATCH` response from `patchSalesQuote` does not include `hasOpenedEmail` (a derived field computed from email open-tracking records); previously, clicking Unaccept on the Quotes page would momentarily display "Sent" because the optimistic update had no email-open context, reverting to "Opened" only after a full page refresh; the `hasOpenedEmail` flag from the original quote row is now preserved when applying the unaccept update locally

## [1.1.0] - 2026-03-04

### Added
- **Mobile hamburger navigation menu** — the admin header nav links are now hidden behind a `Menu`-icon `DropdownMenu` on screens narrower than the `md` breakpoint; the full inline nav is still shown on `md` and above; this prevents the nav from collapsing into an awkwardly scrollable row on phones and tablets

### Changed
- **"Project Ready for Review" email video list improvements** — videos with multiple versions are now consolidated onto a single line (e.g. `Day 1 - Session 3 v1 v2`) instead of one line per version; videos and albums are listed in alphabetical order; any video group that has at least one approved version now shows a green `Approved` pill next to the title; the defunct duplicate "Ready to view" card (dead-code variable) has been removed from the template
- **Running Jobs completed jobs linger for 10 minutes** — recently completed uploads in the Running Jobs dropdown now auto-dismiss after 10 minutes instead of 8 seconds, giving users a longer window to review finished items
- **Running Jobs poll rate increases when dropdown is open** — the `GET /api/running-jobs` endpoint is now polled every 5 seconds while the Running Jobs dropdown is open, and every 10 seconds when it is closed, providing more responsive progress updates during active use without increasing background traffic
- **Header dropdown buttons highlight while open** — the `RunningJobsBell`, `NotificationsBell`, and mobile nav trigger buttons now apply `data-[state=open]` accent-colour classes so the button visually stays "pressed" while its dropdown is open; Radix `onCloseAutoFocus` is also suppressed on both dropdowns so focus is blurred rather than retained (which previously left a visible focus ring on the button after closing)
- **Running Jobs rows navigate to the project page** — clicking anywhere on an upload or processing job row (other than the pause/resume/cancel/dismiss icon buttons) closes the dropdown and navigates to `/admin/projects/[projectId]`; the action buttons stop event propagation so they are unaffected

### Fixed
- **Admin IP suppression applied to guest share access tracking** — `trackSharePageAccess` now calls `isLikelyAdminIp` (same helper used by the sales doc view page) before writing a `SharePageAccess` record or firing the push notification; previously, an admin clicking "Continue as Guest" on a share page would trigger a "A client accessed the share page" bell notification and analytics record because the client-side guest POST request carries no admin JWT header — `getCurrentUserFromRequest` returned null, so the existing JWT guard was ineffective; the IP-based fallback now correctly suppresses tracking for internal users regardless of how they entered the share page
- **Stale TUS temp-directory path in upload cleanup script** — `upload-cleanup.ts` still referenced the old `/tmp/vitransfer-tus-uploads` path after the v1.0.8 change that moved TUS chunk files to `STORAGE_ROOT/.tus-tmp`; the script now derives the same path from `STORAGE_ROOT`, so stale partial-upload files are correctly purged during scheduled cleanup

## [1.0.9] - 2026-03-04

### Added
- **Running Jobs header indicator** — a new `Activity` icon button to the left of the notification bell in the admin header shows a badge counter with the total number of active jobs (uploads + server-side processing); clicking it opens a dropdown listing active uploads (with progress bars, upload speed, ETA, pause/resume/cancel controls via compact icon buttons), processing/queued server-side jobs (with progress percentages), and recently completed jobs that auto-dismiss after 8 seconds; this feature is available to internal admin users only — external clients and share-page visitors do not see or interact with the Running Jobs indicator; backed by a new `GET /api/running-jobs` endpoint that polls every 10 seconds for videos in `QUEUED` or `PROCESSING` status
- **Persistent uploads across page navigation** — video uploads now continue running in the background when navigating between admin pages; a new `UploadManagerProvider` React context at the admin layout level holds all TUS upload instances, processes them sequentially, and exposes pause/resume/cancel controls through the Running Jobs dropdown; both `MultiVideoUploadModal` (batch uploads) and `VideoUpload` (single "Add New Version" uploads) now create the video record, enqueue the file with the global upload manager, and immediately close/reset — the upload progress is tracked exclusively in the Running Jobs indicator
- **Project-scoped running jobs** — the `GET /api/running-jobs` endpoint now respects RBAC project access: system admins see processing jobs across all projects, while other internal roles only see jobs for projects they are assigned to; project status visibility settings from the user's role are also applied, ensuring users never see jobs for projects outside their permission scope
- **Purge stale BullMQ jobs tool in Developer Tools** — new maintenance action in Settings → Developer Tools that counts (dry-run) or removes completed and failed BullMQ job keys across all eight queues in Redis; completed jobs older than 1 hour and failed jobs older than 24 hours are purged, with a per-queue breakdown shown in the results; backed by `POST /api/settings/purge-bullmq-jobs`

### Fixed
- **Redis key bloat causing slow uploads and AOF fsync warnings** — the `notification-processing` BullMQ queue had no `removeOnComplete` / `removeOnFail` defaults, so every hourly notification check, key-date reminder, auto-close run, and retry job left completed/failed job keys in Redis permanently; over weeks this accumulated tens of thousands of keys, triggering Redis AOF `fsync is taking too long (disk is busy?)` warnings and blocking the event loop during BGSAVE — which stalled TUS upload PATCH handling; fixed by adding `defaultJobOptions` with `removeOnComplete: { age: 3600 }` and `removeOnFail: { age: 86400 }` to the queue constructor (matching all other queues), and adding explicit `removeOnComplete: true` / `removeOnFail: true` to the two repeatable jobs (`process-notifications`, `auto-close-approved-projects`) that were missing them; the `user:tokens:revoked_at:${userId}` key in `password-reset.ts` was also written with `redis.set()` (no TTL), accumulating one permanent key per password reset — changed to `redis.set(..., 'EX', 604800)` (7-day expiry matching refresh token duration)

## [1.0.8] - 2026-03-03

### Added
- **Processing progress percentage in video bar** — the PROCESSING progress bar in the video list now shows the actual FFmpeg transcode percentage (e.g. `42%`) alongside the "Processing previews..." label; the bar fills proportionally with a 1% minimum so there is always a visible indicator from the moment processing begins; normalises both the `0.0–1.0` float range stored during transcoding and the `100` completion sentinel
- **Cancel Upload button in batch upload modal** — a "Cancel Upload" button appears in the `MultiVideoUploadModal` footer while a batch upload is in progress; clicking it immediately aborts the active TUS upload, resets the item back to pending state, and stops the remaining queue without closing the dialog, so the user can correct issues or close manually
- **Upload speed and ETA in batch upload modal** — while a file is uploading in `MultiVideoUploadModal`, a `Speed: X MB/s` / `Estimated: Y seconds` row now appears beneath the progress bar for each active item, matching the display already present in the asset and file upload components
- **UPLOADING status badge** — videos in `UPLOADING` status now display a neutral spinning `UPLOADING` badge in the same position as the `PROCESSING` / `QUEUED` badges in both the video list row and the `AdminVideoManager` group card header, making in-flight uploads visible rather than appearing as blank entries
- **FAILED status badge** — videos in `ERROR` status now display a destructive `FAILED` badge in the video list row and `AdminVideoManager` group card header (previously these showed no badge at the group level)
- **`POST /api/videos/[id]/cancel-upload` endpoint** — new endpoint that marks an `UPLOADING` or `ERROR` video record as `ERROR` with the reason `Upload cancelled before completion`; used as a fallback when the caller lacks the `projectsFullControl` permission required to hard-delete the video record, preventing ghost `UPLOADING` entries from persisting on the Projects page

### Changed
- **TUS temp files co-located with storage root** — the TUS server now stores upload chunk temp files in `STORAGE_ROOT/.tus-tmp` instead of `/tmp/vitransfer-tus-uploads`; because the temp directory is now on the same filesystem as the final storage location, the `onUploadFinish` handler uses an atomic `fs.rename` move instead of a full read/write copy, eliminating a complete extra copy of every uploaded file; a cross-device (`EXDEV`) fallback stream-copy is retained for edge cases
- **Cancel cleans up incomplete video records** — on abort or TUS error, the upload components first attempt `DELETE /api/videos/:id`; if that returns 403 (insufficient permissions), they fall back to the new `cancel-upload` endpoint so the incomplete record is always resolved rather than left as a ghost

### Fixed
- **Upload ETA shown in minutes when over one minute** — all upload components (`MultiVideoUploadModal`, `VideoAssetUpload`, `VideoAssetUploadItem`, `AlbumPhotoUploadItem`) now format the remaining time estimate as `X min Y sec` (or `X min` when no seconds remainder) for ETAs of 60 seconds or more, replacing the raw seconds count that could reach into the thousands for large files
- **Cancel Upload freezing the upload queue** — `tus.Upload.abort(true)` can silently skip the `onError` callback, leaving the queue's internal `await new Promise(…)` permanently unresolved and freezing all subsequent uploads; fixed by storing a direct reference to the Promise's `reject` function (`currentUploadRejectRef`) that `handleCancelCurrentUpload` calls immediately before issuing the TUS abort, with a `settled` boolean guard preventing double-settlement if `onError` also fires
- **Ghost UPLOADING records persisting on Projects page after cancel** — `handleCancelCurrentUpload` now tracks the active `videoId` in a dedicated ref (`currentVideoIdRef`) and directly calls `DELETE /api/videos/:id` (falling back to `cancel-upload`) as a fire-and-forget before `abort(true)` is issued; this ensures the server-side record is always cleaned up regardless of whether the TUS `onError` callback fires
- **Collapsing a video card during "Add New Version" upload cancels the upload** — the `CardContent` in `AdminVideoManager` was conditionally mounted with `{isExpanded && ...}`, so collapsing the card unmounted the `VideoUpload` component mid-upload, destroying all TUS state; the card content is now kept mounted (visually hidden via `hidden`) when an upload form is open for that group, so the upload survives collapse/expand and progress resumes exactly where it left off when the card is reopened

## [1.0.7] - 2026-03-02

### Added
- **Reconciled payment amounts shown in brackets** — the payments page now wraps the amount in parentheses (e.g. `($120.00)`) for any payment marked as a reconciliation/mirror entry (`excludeFromInvoiceBalance`), making it visually clear at a glance that the entry is a QBO-mirrored or reconciliation record and not a new payment; the `(reconciled)` source label in the method column is unchanged

### Changed
- **Internal user analytics suppression** — share page access, video analytics, invoice/quote view events, guest video link access events, and associated push/bell notifications are no longer recorded when the visitor is identified as an internal user; detection uses two layers: (1) a `?ref=internal` query parameter automatically appended when internal users click "View Invoice" or "View Quote" from the admin UI, and (2) a best-effort IP match against recent admin login IPs from the `SecurityEvent` table (cached in Redis for 24 h) as a fallback for direct URL access; the security event audit log is unaffected
- **Consistent IP resolution via `getClientIpAddress`** — `trackSharePageAccess` and the NONE-mode share route were using raw `x-forwarded-for` / `x-real-ip` header extraction instead of the centralised `getClientIpAddress()` helper; they now go through the same normalisation, IPv4-mapped-IPv6 handling, Cloudflare header priority, and `TRUSTED_PROXIES` proxy-peeling logic as every other IP callsite

### Fixed
- **IP addresses missing in Security Events and Video Analytics** — the proxy IP hardening introduced in v1.0.0 returned `'unknown'` unconditionally when `TRUSTED_PROXIES` was not configured, breaking IP detection for local/dev deployments and any environment without an explicit trust list; `getClientIpAddress()` now falls back to the left-most `X-Forwarded-For` entry (or `X-Real-IP`) with a one-time console warning when no trust list is set, restoring the pre-hardening behaviour while still recommending `TRUSTED_PROXIES` for production; deployments that already have `TRUSTED_PROXIES` configured are unaffected

## [1.0.6] - 2026-03-02

### Added
- **"QUEUED" video status badge** — when multiple videos are uploaded simultaneously and the worker CPU limit is reached, videos waiting in the processing queue now display an orange `QUEUED` badge (and a flat amber progress bar) instead of silently waiting; the badge appears in the same position as the `PROCESSING` badge in both the video list and the group card header in `AdminVideoManager`; the `PROCESSING` status and animated stripe bar are unchanged and only appear once the worker actually begins encoding

### Security
- **Open-redirect fix on login `returnUrl`** — the `returnUrl` query parameter on the login page is now validated to only allow relative paths (must start with `/`, must not start with `//`); external URLs and `javascript:` URIs are silently rejected and the user is redirected to `/admin` instead, preventing phishing and script-injection via crafted login links
- **Secure watermark temp-file creation** — replaced direct `/tmp` file creation with `fs.mkdtempSync` for FFmpeg watermark temp files; the new approach creates a dedicated directory with restricted `0700` permissions before writing the file, closing a symlink/hard-link race-condition window; both `close` and `error` cleanup handlers now also remove the temp directory
- **ReDoS fix in `sanitizeFilename`** — replaced the `^[.\s]+|[.\s]+$` alternation regex (catastrophic backtracking on crafted filenames) with deterministic while-loops that strip leading/trailing dots and spaces in O(n) time
- **Proper HTML-to-plaintext in email fallback** — replaced the naive `/<[^>]*>/g` tag-stripping regex in `sendEmail` with the `html-to-text` library; malformed, multi-line, or encoded HTML tags are now handled correctly, preventing garbled or partially-tagged plain-text email parts
- **Cloudflare IP header priority** — `getClientIpAddress()` now checks `CF-Connecting-IP` before `X-Forwarded-For`; when running behind Cloudflare this header is set by the CDN itself and cannot be spoofed by clients, ensuring accurate IP logging and rate-limiting for Cloudflare-proxied deployments

## [1.0.5] - 2026-02-28

### Added
- **Accurate "Last Activity" timestamps** — projects dashboard, client detail page, and analytics now derive the last-activity timestamp from real event records (`sharePageAccess`, `videoAnalytics`, `albumAnalytics`) rather than `project.updatedAt`, giving a more meaningful signal of when a project was last genuinely active

### Changed
- **Quote amounts in client sales summary** — client detail page now shows the amount column for quotes in the per-client sales summary table
- **Albums sorted alphabetically** — project albums are now listed in alphabetical order on share pages and in the admin view
- **QuickBooks payments are read-only** — QBO-synced payment entries are now marked read-only in the payments table alongside Stripe payments, preventing accidental edits to mirrored records
- **Payment source types expanded** — the payment source field now distinguishes `MANUAL`, `QUICKBOOKS`, and `STRIPE` (previously collapsed `LOCAL` and `QUICKBOOKS` into a single `LOCAL` value)
- **Recent payments metric corrected** — the sales dashboard recent-payments total now correctly excludes reconciliation/mirror entries via the `excludeFromInvoiceBalance` flag rather than only filtering by `STRIPE` source, so QBO-mirrored Stripe payments are no longer double-counted
- **Scrollbar styling centralized** — all custom scrollbar CSS consolidated into a single global rule in `globals.css` (6 px width and height, discreet muted-foreground thumb); per-component `styled-jsx` scrollbar blocks removed from `VideoSidebar`, `ProjectInternalComments`, and `ProjectAnalyticsClient`

### Fixed
- **`react-hooks/exhaustive-deps` lint warnings** — `ProjectsList` useMemo was missing `analyticsMap` from its dependency array; `ProjectAnalyticsClient` `activity` array was recreated on every render, making the downstream `sortedActivity` useMemo stale — both corrected

## [1.0.4] - 2026-02-19

### Added
- **Internal comment bell notifications** — posting an internal comment now fires a real-time `PushNotificationLog` entry, updating the badge count and triggering browser push for all users assigned to the project (excluding the author)
- **Browser push for all admin users** — push notification subscriptions are no longer restricted to system admins; all admin users can subscribe their devices and receive notifications scoped to their access level: project events for assigned projects, sales events for sales-menu users, security events for system admins only
- **Inline push subscribe/unsubscribe toggle in notification bell** — a `BellOff`/`BellRing` icon in the bell dropdown header lets any user enable or disable browser push on the current device without needing Settings access; button is hidden automatically when push is unavailable (no VAPID key, unsupported browser, or insufficient permissions)
- **Push subscription error feedback** — blocked or failed push subscribe/unsubscribe attempts now show an inline error message in the bell dropdown; permission-denied state shows a specific "Notifications are blocked in your browser" message rather than silently failing
- **Developer tools section** — new Developer Tools card in Settings for ad-hoc maintenance actions (e.g. purge notification backlog)
- **Notification backlog purge API** — new `POST /api/settings/purge-notification-backlog` endpoint to clear stale unprocessed notification queue entries

### Changed
- **Notification routing refactored** — `sendImmediateNotification` now accepts a `target` parameter (`'client'` or `'admin'`) to cleanly separate routing paths; client and admin delivery are no longer entangled in the same code path
- **Comment notification cancellation key renamed** — Redis key changed from `comment_notification:{id}` to `comment_cancelled:{id}` to accurately reflect its purpose; all workers and the notify route updated consistently
- **Admin notification worker processes both directions** — the admin notifications worker now handles both `CLIENT_COMMENT` (client-to-admin) and `ADMIN_REPLY` types, matching the client notifications worker; previously only `CLIENT_COMMENT` was picked up for admin digest delivery
- **Notification backlog age limit** — admin notification worker and comment summary route now ignore queue entries older than 7 days to prevent delivering stale digests after downtime
- **Comment summary route sends to both sides** — `POST /api/projects/:id/notify` with `type: COMMENT_SUMMARY` now queues emails to both client recipients and internal assigned users from the same payload, rather than only handling one direction
- **Accent colour passed to all email templates** — admin summary, internal comment digest, and comment notification emails now correctly pass `accentColor` through to templates (previously missing, causing some branded emails to fall back to the default colour)
- **Worker job log labels improved** — worker completion and failure log messages now distinguish between key-date checks, notification checks, and other job types instead of labelling everything as "Notification check"
- **User edit page layout rebuilt** — the edit user page now uses a card layout with a two-column grid for fields (email, name, role, status, password), consistent with the rest of the admin UI; same inline generate/copy password buttons as the create user flow

### Fixed
- **Dialog backdrop click no longer blocked** — removed `event.stopPropagation()` handlers from `DialogOverlay` that were preventing modals from closing when clicking outside them
- **Checkbox tick intercepting click events** — added `pointer-events-none` to the `Check` icon inside the checkbox component so that clicking the tick area no longer double-fires the toggle and causes the checkbox to flick back
- **Internal comment email self-notification** — the comment author is now filtered from their own internal comment digest; previously both sides of an internal comment thread would receive the same summary email
- **Notification data leak for non-admin users** — removed an `OR projectId: null` clause from the bell API's project scope filter that was incorrectly leaking all project-type notification log entries (with no project ID) to any user with Projects menu access
- **Bell badge count for project-assigned non-admin users** — notification visibility is now gated on project assignment directly rather than Projects menu visibility; users assigned to projects now correctly see badge counts even when their role does not include the Projects menu item
- **Projects dashboard stale client names** — projects list and key dates calendar now refetch data when the browser tab regains focus, so a client name change made in another tab is reflected immediately without a manual reload
- **Cross-window auth token sync** — tokens received via `BroadcastChannel` from another tab are now written to storage immediately, preventing stale sessions after page reload when a background tab rotated the refresh token
- **Password UI shown for non-password auth modes** — password-related UI (entry prompt, clear button, settings field) no longer appears on share pages and project settings when the project auth mode is OTP, Guest, or None; the project PATCH API now clears any stored password hash when switching away from password-based modes
- **Client page sales status rollup** — client detail page invoice and quote rollup now includes all relevant statuses (`PAID`, `PARTIALLY_PAID`, `OPENED`, `OVERDUE`, `ACCEPTED`, `CLOSED`) rather than a partial subset

### Removed
- **Legacy comment recipient backfill** — removed `backfillCommentRecipientIdsByAuthorName` helper and all call sites; recipient IDs have been normalised in the database and the backfill is no longer needed
- **Dead utility modules** — removed `src/lib/encryption.ts` (duplicated logic), `src/lib/password-utils.ts` (inlined at call sites), and unused dev scripts (`export-pwa-notification-previews.ts`, `_check_prisma_sales_share.js`)
- **Broken `ajv` package override** — removed the `overrides.ajv: 8.18.0` entry in `package.json` that was forcing ajv v8 onto `@eslint/eslintrc`, which requires ajv v6 and crashed ESLint with `TypeError: Cannot set properties of undefined (setting 'defaultMeta')`

## [1.0.3] - 2026-02-17

### Added
- **Default theme setting** — new Light / Dark / Auto selector in Company Branding to set the default colour theme for all visitors
- **Allow theme toggle setting** — new toggle in Company Branding to show or hide the theme switcher button across the entire app; when disabled, all users see only the admin-configured default theme
- Auto mode uses the visitor's operating-system preference (`prefers-color-scheme`)

### Changed
- **Light mode contrast** — background, card, popover, border, and muted tones are now deeper and more contrasty; text and status colours darkened slightly; shadows strengthened
- **Email logo size** — company logo in email templates now constrained to max 280 × 120 px to prevent oversized logos
- **Email hyperlink colours** — Unsubscribe and secondary text links in all email templates no longer override colour with the accent colour; they now inherit the email client's default link colour for better readability
- **Invoice/quote logo theme adaptation** — public invoice and quote pages now display theme-appropriate logos: light mode (dark header) shows dark logo when configured, dark mode (light header) shows normal logo
- **Logo size on sales documents** — company logo on HTML invoice/quote pages and PDF templates increased by ~10% (h-10→h-11 on HTML, 42pt→46pt on PDF)
- **Add New User password UI** — password field now uses inline generate/copy buttons (matching Create Project page) instead of separate row button; improved mobile layout
- **Branding settings simplified** — removed URL/link option for Company Logos and Favicon; only None and Upload modes remain

## [1.0.2] - 2026-02-16

### Added
- **24-hour time picker** for key dates — clock-style HH→MM selector with 5-minute increments, defaults to 12:00 when opened empty, replaces previous long-dropdown style for Start/Finish/Reminder times in all Add Key Date modals
- **Automated setup scripts** — `setup.sh` (Linux/Mac/WSL) and `setup.ps1` (Windows PowerShell) auto-generate all 6 required secrets, validate admin credentials, port, timezone, and HTTPS configuration

### Changed
- **Video upload resume** — check video status before resuming from localStorage to prevent invalid resume attempts when video moved past UPLOADING phase
- **Sales line item layout** — tightened invoice/quote line item grid layout with improved responsive behavior for tax rate and subtotal fields
- **Share album download buttons** — changed to primary button style (from outline) for better visual prominence in album viewer
- **Docker workflow** — simplified to use `docker-compose.override.yml` pattern (gitignored) for local builds instead of separate build compose file
- Date validation error messages now show "Invalid date value. Please use the date picker." instead of locale-specific "date must be YYYY-MM-DD" format text
- Date input fields now enforce 4-digit year bounds (0001–9999) via `min`/`max` attributes to prevent entering invalid year values
- Updated all branch references from `dev` to `main` in installation documentation

### Fixed
- **Client name changes not reflected in project dashboard** — renaming a client now automatically syncs all linked projects' display names; dashboard now includes live client relation as fallback ensuring current names always display
- **413 error for video uploads over 1GB** — video/asset uploads now correctly skip `maxUploadSizeGB` limit in TUS upload handler
- **Video re-upload to ERROR status** — allow re-uploading to videos that previously failed by resetting state to UPLOADING
- Date picker calendar icon now visible in dark mode with proper contrast (inverted and brightened) across all themes
- Date picker icon globally styled in `globals.css` ensuring consistent visibility on all date input fields

### Removed
- `compose-up.ps1` helper script (standard `docker compose up -d` now works for both pull and build workflows)
- `docker-compose.build.yml` (replaced by optional `docker-compose.override.yml` pattern)

## [1.0.1] - 2026-02-15

### Changed
- Merged `scripts/retry-publish-docker.ps1` into `publish-docker.ps1` — retry loop, DNS pre-check, and post-publish verification are now built in
- Added `-MaxAttempts`, `-RetrySleep`, `-NoRetry`, and `-NoVerify` flags to `publish-docker.ps1`

### Removed
- `scripts/retry-publish-docker.ps1` (no longer needed)

## [1.0.0] - 2026-02-15

First independent release of ViTransfer-TVP as a hard fork.
Forked from upstream ViTransfer v0.8.2 (archived at `archive/upstream-v0.8.2` branch).

### TVP-Exclusive Features

#### Sales & CRM
- **Sales dashboard** with outstanding invoices, payment status, revenue tracking, and configurable fiscal year reporting
- **Quote system** — create, send, and track quotes with expiry dates, reminders, and conversion to invoices
- **Invoice management** — create, send, and track invoices with automated overdue payment reminders
- **Payment tracking** — manual payment recording and real-time Stripe webhook updates
- **Branded PDF generation** — downloadable quote and invoice PDFs with company logo support
- **Document sharing** — public share links for quotes and invoices with view/open tracking and email analytics
- **QuickBooks Online integration** — pull-only sync for clients, quotes, invoices, and payments with configurable daily polls
- **Stripe Checkout** — accept payments directly on invoices with processing fee pass-through and surcharge display
- **Currency support** — automatic symbol lookup from ISO 4217 currency codes (60+ currencies)
- **Client database** — centralized client management with company details, contact info, display colors, and file storage

#### Guest Video Links
- **Single-video access** — generate unique links for individual videos without exposing the project
- **Token-based security** — cryptographically secure tokens with 14-day auto-expiry and refresh
- **Analytics tracking** — view counts with IP-based dedupe, push notifications on access, watermark support

#### Photos & Albums
- **Multi-photo albums** — create multiple albums per project with batch upload (up to 300 photos, 3 concurrent)
- **Social media export** — automatic 4:5 (1080x1350) Instagram portrait crop generation
- **Bulk downloads** — ZIP files for full resolution and social crops
- **Share integration** — albums appear on client share pages when enabled per project

#### Comprehensive Branding
- **Company logos** — upload or link to PNG/JPG for app header, emails, and PDFs; separate dark mode logo
- **Custom favicon** — upload or link for professional browser tab appearance
- **Accent color** — custom hex color for buttons, links, toggles, and email templates with light/dark text modes
- **Email branding** — custom header color, text mode, clickable logos, and company watermark across all communications

#### User Roles & Permissions (RBAC)
- **Custom roles** — unlimited named roles (Project Manager, Editor, Accountant, etc.) with granular permissions
- **Menu visibility** — per-role access to Projects, Clients, Sales, Settings, Users, Security, Analytics, Share Page
- **Project status filtering** — limit visible statuses per role (e.g., editors only see IN_PROGRESS)
- **Granular actions** — per-area permissions like uploads, full control, manage comments, send test emails
- **Project assignment** — assign specific users to projects for targeted collaboration and notifications

#### Better Aspect Ratio Support
- **Portrait, square, ultra-wide, and legacy formats** — proper 9:16, 1:1, 21:9, 4:3 support with dynamic player sizing
- **Container queries and metadata-first** — modern CSS scaling and database-stored dimensions prevent visible jumps

#### Communication & Notifications
- **Video version notes** — per-version notes (500 chars) visible on share pages with inline editing
- **Selectable email recipients** — choose which recipients receive each notification, with per-recipient opt-in/out
- **Internal project chat** — admin-only threaded discussions hidden from client share pages
- **Key date reminders** — automated emails to selected users/recipients before milestone dates
- **Push notifications** — optional Gotify and browser Web Push (VAPID) for real-time alerts
- **In-app notification bell** — unread badge, auto-polling, click-to-navigate, covering comments, approvals, sales, and security
- **Smart email digests** — immediate, hourly, daily, or weekly batching to reduce noise
- **Email tracking** — optional open-tracking pixels (can be disabled globally; legal compliance is your responsibility)
- **Comment attachments** — multi-file uploads (up to 5 per comment) supporting images, PSD/AI, and video formats

#### Status Workflow & Calendar
- **8 project statuses** — NOT_STARTED, IN_PROGRESS, IN_REVIEW, REVIEWED, ON_HOLD, SHARE_ONLY, APPROVED, CLOSED
- **Automated transitions** — auto-IN_REVIEW on client notify, auto-APPROVED when all videos approved, auto-close after X days
- **Key dates** — PRE_PRODUCTION, SHOOTING, DUE_DATE, and personal dates with automated reminders
- **Calendar sync** — iCal/ICS feed for Google Calendar, Apple Calendar, Outlook with automatic updates

#### External Communication Library
- **Email import** — drag-and-drop .eml files into projects with automatic parsing of subject, body, attachments, and inline images
- **Background processing** — large email files processed asynchronously

#### Additional Security
- **Max upload safeguards**, **random slug generation**, **constant-time comparison**, **token hashing**, **OTP with crypto.randomInt()**, **account lockout**, **7-layer path traversal defense**, **FFmpeg input sanitization**, and **security event logging**

#### Granular Approval Control
- **Per-version approval toggle** — each video version has an `allowApproval` setting, defaulting to disabled to prevent accidental WIP approvals
- **Admin override** — toggle approval permission on any version at any time
- **API enforcement** — share page validates approval flag before processing

#### Client File Storage
- **Centralized document repository** — per-client file storage for contracts, branding assets, style guides, and reference materials
- **Auto-categorized uploads** — files sorted by type (contracts, branding, images, video, audio, documents)
- **Internal-only** — not exposed on client share pages

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
- Added `min-w-0`, `break-all`, and `break-words` classes to prevent text overflow in blocklist items
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
- **Share Page Video Sorting**: Sort toggle button for video sidebar (upload date â†” alphabetical)
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
- **Video Processor**: 406 â†’ 96 lines (76% reduction)
  - Extracted 8 helper functions to video-processor-helpers.ts
  - Eliminated magic numbers with named constants
  - Reduced nesting depth from 5 to 2 levels
- **Comments API**: 340 â†’ 189 lines (44% reduction)
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
- Display priority: companyName â†’ Primary Recipient â†’ "Client"
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
- Projects sorted by status on admin dashboard (In Review â†’ Share Only â†’ Approved)

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
- ðŸ“¹ **Video Upload & Processing** - Automatic transcoding to multiple resolutions (720p/1080p)
- ðŸ’§ **Watermarking** - Customizable watermarks for preview videos
- ðŸ’¬ **Timestamped Comments** - Collect feedback with precise video timestamps
- âœ… **Approval Workflow** - Client approval system with revision tracking
- ðŸ”’ **Password Protection** - Secure projects with client passwords
- ðŸ“§ **Email Notifications** - Automated notifications for new videos and replies
- ðŸŽ¨ **Dark Mode** - Beautiful dark/light theme support
- ðŸ“± **Fully Responsive** - Works perfectly on all devices
- ðŸ‘¥ **Multi-User Support** - Create multiple admin accounts
- ðŸ“Š **Analytics Dashboard** - Track page visits, downloads, and engagement
- ðŸ” **Security Logging** - Monitor access attempts and suspicious activity
- ðŸŽ¯ **Version Management** - Hide/show specific video versions
- ðŸ”„ **Revision Tracking** - Limit and track project revisions
- âš™ï¸ **Flexible Settings** - Per-project and global configuration options

#### Security
- ðŸ” **JWT Authentication** - Secure admin sessions with 15-minute inactivity timeout
- ðŸ”‘ **AES-256 Encryption** - Encrypted password storage for share links
- ðŸ›¡ï¸ **Rate Limiting** - Protection against brute force attacks
- ðŸ“ **Security Event Logging** - Track all access attempts
- ðŸš« **Hotlink Protection** - Prevent unauthorized embedding
- ðŸŒ **HTTPS Support** - SSL/TLS for secure connections
- â±ï¸ **Session Monitoring** - Inactivity warnings with auto-logout

#### Technical
- ðŸ³ **Docker-First** - Easy deployment with Docker Compose
- ðŸš€ **Next.js 15 + React 19** - High performance modern stack
- ðŸ“¦ **Redis Queue** - Background video processing with BullMQ
- ðŸŽ¬ **FFmpeg Processing** - Industry-standard video transcoding
- ðŸ—„ï¸ **PostgreSQL Database** - Reliable data storage
- ðŸŒ **TUS Protocol** - Resumable uploads for large files
- ðŸ—ï¸ **Multi-Architecture** - Support for amd64 and arm64

---

## Release Notes

### Version Tagging
Starting with v0.1.0, Docker images are tagged with both version numbers and "latest":
- `simbamcsimba/vitransfer-app:latest` - Application server image
- `simbamcsimba/vitransfer-worker:latest` - Worker image (FFmpeg processing)
