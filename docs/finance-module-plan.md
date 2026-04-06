# Finance Module — Development Plan

**App:** ViTransfer-TVP  
**Status:** Planning  
**Last Updated:** April 2026  

---

## Overview

This document outlines the staged plan to build a fully integrated accounting and finance module into ViTransfer-TVP, replacing reliance on QuickBooks for day-to-day bookkeeping, expense management, BAS preparation, and financial reporting.

The existing **Sales** section (quotes, invoices, payments, Stripe integration) is left untouched. The new finance module integrates with it — specifically linking bank transactions to existing `SalesPayment` and `SalesInvoice` records.

The module will live under `/admin/accounting/` and be surfaced as a new top-level section in the admin navigation alongside Sales.

---

## Guiding Principles

- **QuickBooks parity** — match the key workflows QBO provides for a small Australian service business: bank feeds, expense tracking, BAS, P&L, Balance Sheet.
- **Mobile-first expense capture** — the PWA already installs on mobile; expense entry with photo receipt capture must work fully on phone.
- **Australia-first compliance** — GST 10%, BAS lodgement labels (1A, 1B, G1–G20), ATO quarterly periods.
- **Non-destructive Sales integration** — no Sales schema changes; accounting links to Sales via foreign key references only.
- **Staged delivery** — each stage delivers a self-contained, usable slice of functionality.

---

## Proposed Route Structure

```
/admin/accounting                          Dashboard / overview
/admin/accounting/bank-accounts            Bank account list
/admin/accounting/bank-accounts/new
/admin/accounting/bank-accounts/[id]
/admin/accounting/transactions             All transactions (across accounts)
/admin/accounting/transactions/import      CSV import + field mapper
/admin/accounting/transactions/[id]        Single transaction detail / matching
/admin/accounting/expenses                 Expense list
/admin/accounting/expenses/new             New expense (desktop)
/admin/accounting/expenses/[id]            Edit/view expense
/admin/accounting/chart-of-accounts        Account list
/admin/accounting/chart-of-accounts/new
/admin/accounting/chart-of-accounts/[id]
/admin/accounting/reports                  Report selector
/admin/accounting/reports/profit-loss      Profit & Loss
/admin/accounting/reports/balance-sheet    Balance Sheet
/admin/accounting/gst                      BAS period list
/admin/accounting/gst/[period]             BAS worksheet for a quarter
```

---

## Database Schema — New Models

> All new models will be added in new Prisma migrations. No existing models are modified.

### `BankAccount`
```
id, name, accountNumber (last 4), bsb, bankName, currency (default AUD),
openingBalance (cents), openingBalanceDate, isActive, createdAt, updatedAt
```

### `BankTransaction`
```
id, bankAccountId → BankAccount,
date, description, reference, amount (cents, negative = debit),
rawCsv (JSON — original imported row),
status: UNMATCHED | MATCHED | EXCLUDED,
matchType: INVOICE_PAYMENT | EXPENSE | MANUAL,
invoicePaymentId → SalesPayment (nullable),
expenseId → Expense (nullable),
importBatchId → BankImportBatch,
createdAt, updatedAt
```

### `BankImportBatch`
```
id, bankAccountId, fileName, importedAt, rowCount, matchedCount, userId → User
```

### `Account` (Chart of Accounts)
```
id, code (e.g. "6-1000"), name, type: ASSET | LIABILITY | EQUITY | INCOME | EXPENSE | COGS,
subType (string, e.g. "Motor Vehicle", "Office Supplies"),
taxCode: GST | GST_FREE | BAS_EXCLUDED | INPUT_TAXED,
description, isActive, isSystemAccount (protected defaults),
parentId → Account (nullable, for sub-accounts),
sortOrder, createdAt, updatedAt
```

### `Expense`
```
id, date, supplierName, description,
accountId → Account,
taxCode: GST | GST_FREE | BAS_EXCLUDED | INPUT_TAXED,
amountExGst (cents), gstAmount (cents), amountIncGst (cents),
receiptImagePath (nullable), receiptOriginalName (nullable),
status: DRAFT | APPROVED | RECONCILED,
bankTransactionId → BankTransaction (nullable),
userId → User (who entered it),
notes, createdAt, updatedAt
```

### `BasPeriod`
```
id, label (e.g. "Q3 FY2026"), startDate, endDate,
quarter (1–4), financialYear (e.g. "FY2026"),
status: DRAFT | REVIEWED | LODGED,
lodgedAt (nullable),
notes,
createdAt, updatedAt
```

> BAS values are calculated dynamically from `SalesInvoice`, `SalesPayment`, `Expense`, and `BankTransaction` records — they are not stored. A `BasPeriod` is a date range container + lodgement status tracker only.

---

## Seed Data — Default Chart of Accounts

The migration will seed a standard Australian small-business chart. Abbreviated example:

| Code | Name | Type | Tax |
|------|------|------|-----|
| 1-0000 | Bank Accounts | ASSET | BAS_EXCLUDED |
| 1-1000 | Accounts Receivable | ASSET | GST |
| 2-0000 | Accounts Payable | LIABILITY | GST |
| 3-0000 | Owner's Equity | EQUITY | BAS_EXCLUDED |
| 4-0000 | Sales Income | INCOME | GST |
| 4-1000 | Other Income | INCOME | GST |
| 5-0000 | Cost of Goods Sold | COGS | GST |
| 6-0000 | Advertising & Marketing | EXPENSE | GST |
| 6-1000 | Bank Charges | EXPENSE | GST_FREE |
| 6-2000 | Motor Vehicle | EXPENSE | GST |
| 6-3000 | Office Supplies | EXPENSE | GST |
| 6-4000 | Software & Subscriptions | EXPENSE | GST |
| 6-5000 | Professional Services | EXPENSE | GST |
| 6-6000 | Travel & Accommodation | EXPENSE | GST |
| 6-7000 | Wages & Salaries | EXPENSE | BAS_EXCLUDED |
| 6-8000 | Superannuation | EXPENSE | BAS_EXCLUDED |
| 6-9000 | Insurance | EXPENSE | GST_FREE |

System accounts (ASSET bank, AR, AP, equity) will be flagged `isSystemAccount = true` and cannot be deleted.

---

## BAS Fields — ATO Reference

The quarterly BAS worksheet will calculate and display the following ATO labels:

### GST
| Label | Description | Source |
|-------|-------------|--------|
| G1 | Total sales (inc GST) | Sum of paid/sent invoices in period |
| G2 | Export sales | (manual override, 0 by default) |
| G3 | Other GST-free sales | Invoices with GST-free items |
| G10 | Capital purchases (inc GST) | Expenses on capital accounts |
| G11 | Non-capital purchases (inc GST) | All other GST expenses |
| 1A | GST on sales (G1 − G2 − G3) ÷ 11 | Calculated |
| 1B | GST credits on purchases | Sum of GST on approved expenses |

### PAYG Withholding (optional, future stage)
| Label | Description |
|-------|-------------|
| W1 | Total salary & wages |
| W2 | Amount withheld from W1 |

### Net BAS position
`1A − 1B` = GST payable (or refund if negative)

---

## Stages

---

### Stage 1 — Chart of Accounts

**Goal:** Allow the business to define and manage the accounts that all transactions, expenses, and reports will reference.

**Deliverables:**
- New Prisma model: `Account`
- Migration with seeded default Australian chart
- `/admin/accounting/chart-of-accounts` — list view with type filters, search, active/inactive toggle
- `/admin/accounting/chart-of-accounts/new` — form: code, name, type, subType, taxCode, description, parent account
- `/admin/accounting/chart-of-accounts/[id]` — edit form; deletion blocked for system accounts and any account with linked transactions/expenses
- API routes: `GET/POST /api/admin/accounting/accounts`, `GET/PUT/DELETE /api/admin/accounting/accounts/[id]`
- Basic accounting admin navigation shell (sidebar entry, layout)

**UI reference (QuickBooks):** QBO's Chart of Accounts table with Type/Detail Type columns and a New account drawer.

**Dependencies:** None. This is foundational — all later stages reference Account records.

---

### Stage 2 — Expenses

**Goal:** Record business expenses on desktop and mobile (PWA), with receipt photo capture.

**Deliverables:**
- New Prisma model: `Expense`
- Migration
- `/admin/accounting/expenses` — list with filters: date range, account/category, status, supplier
- `/admin/accounting/expenses/new` — expense entry form:
  - Date, supplier name, description
  - Account picker (Chart of Accounts — EXPENSE/COGS types only)
  - Tax code selector (GST / GST Free / BAS Excluded / Input Taxed)
  - Amount fields: auto-calculate ex-GST ↔ inc-GST based on tax code
  - Receipt image: camera capture (`<input type="file" accept="image/*" capture="environment">`) or file upload
  - Receipt stored in `/uploads/accounting/receipts/` (same pattern as existing video/album assets)
- `/admin/accounting/expenses/[id]` — edit/view with inline receipt image preview
- API routes: `GET/POST /api/admin/accounting/expenses`, `GET/PUT/DELETE /api/admin/accounting/expenses/[id]`
- Receipt serving route: `/api/admin/accounting/receipts/[id]` (authenticated, streams file)
- Mobile-optimised layout: full-screen camera on small viewports, large tap targets

**UI reference (QuickBooks):** QBO mobile app expense capture flow; desktop expense list with category + tax breakdowns.

**Dependencies:** Stage 1 (Account model required for category picker).

---

### Stage 3 — Bank Accounts & CSV Import

**Goal:** Define bank accounts and import transactions from bank-exported CSV files with a flexible field mapper.

**Deliverables:**
- New Prisma models: `BankAccount`, `BankImportBatch`, `BankTransaction`
- Migration
- `/admin/accounting/bank-accounts` — list of configured accounts (name, BSB, last 4 digits, balance indicator)
- `/admin/accounting/bank-accounts/new` and `/[id]` — account form
- `/admin/accounting/transactions/import` — multi-step CSV import wizard:
  - **Step 1:** Select bank account, upload CSV file
  - **Step 2:** Field mapper — auto-detect common bank CSV formats (CommBank, ANZ, Westpac, NAB, Bendigo); manual override for date column, description column, debit column, credit column (or single amount column with sign), reference column
  - **Step 3:** Preview first 10 rows with parsed result; warn on date parse failures
  - **Step 4:** Confirm & import — deduplicate against existing transactions (by date + description + amount)
- `/admin/accounting/transactions` — transaction list across all accounts, filterable by account, date, status (UNMATCHED / MATCHED / EXCLUDED)
- API routes: `GET/POST /api/admin/accounting/bank-accounts`, `GET/PUT/DELETE /api/admin/accounting/bank-accounts/[id]`
- API routes: `GET /api/admin/accounting/transactions`, `POST /api/admin/accounting/transactions/import`, `GET/PUT /api/admin/accounting/transactions/[id]`

**UI reference (QuickBooks):** QBO Bank Feeds import flow with column mapper; transaction list with match status indicators.

**Dependencies:** Stages 1 & 2 (accounts needed for matching; expenses needed as match targets).

---

### Stage 4 — Transaction Matching

**Goal:** Link imported bank transactions to existing invoices (as payments), to existing expenses, or to new manually created expenses.

**Deliverables:**
- `/admin/accounting/transactions/[id]` — transaction detail / match panel:
  - Left: transaction details (date, description, amount, raw CSV row)
  - Right: match panel with three tabs:
    - **Match to Invoice** — search open/partially-paid invoices, displays client name, invoice number, outstanding balance; on confirm → creates a `SalesPayment` record (source: `MANUAL`) and links `bankTransactionId`
    - **Match to Expense** — search unreconciled expenses by date proximity ± 7 days and similar amount; on confirm → links `bankTransactionId` on `Expense` and marks expense `RECONCILED`
    - **Create Expense** — inline quick-entry form (pre-fills amount from transaction); creates `Expense` and immediately links it
  - **Exclude** option — marks transaction as `EXCLUDED` (e.g. transfers between own accounts)
- Unmatched transaction count badge on nav item
- API: `POST /api/admin/accounting/transactions/[id]/match`, `POST /api/admin/accounting/transactions/[id]/unmatch`, `POST /api/admin/accounting/transactions/[id]/exclude`

**Sales integration note:** Matching to invoice calls the existing `SalesPayment` creation logic. The new `BankTransaction.invoicePaymentId` field references the resulting `SalesPayment` record. No changes are made to any Sales API or model.

**UI reference (QuickBooks):** QBO Bank Feed matching panel — the side-by-side transaction + suggested matches layout.

**Dependencies:** Stage 3 (transactions must exist); Sales module (invoice lookup).

---

### Stage 5 — Reports

**Goal:** Generate the two core financial reports a small business needs: Profit & Loss and Balance Sheet.

**Deliverables:**
- `/admin/accounting/reports` — report selector page (cards for P&L, Balance Sheet; future: Cash Flow)
- `/admin/accounting/reports/profit-loss` — Profit & Loss report:
  - Date range picker (presets: This Month, Last Month, This Quarter, Last Quarter, This FY, Last FY, Custom)
  - Comparison period toggle (e.g. vs prior year)
  - **Income** section: Sales revenue from `SalesInvoice` (paid/partial, by issue date or payment date — accrual vs cash toggle)
  - **Cost of Goods Sold** section: Expenses on COGS accounts
  - **Gross Profit** subtotal
  - **Expenses** section: Grouped by Account, with per-account totals
  - **Net Profit / Loss** total
  - GST-exclusive figures throughout
  - Export to PDF (using existing `pdf-lib`) and CSV
- `/admin/accounting/reports/balance-sheet` — Balance Sheet:
  - As-at date picker
  - **Assets:** Bank account balances + Accounts Receivable (outstanding invoice totals)
  - **Liabilities:** Accounts Payable (unpaid expense totals) + GST Payable (net BAS position)
  - **Equity:** calculated
  - Export to PDF and CSV
- API routes: `GET /api/admin/accounting/reports/profit-loss?from=&to=&basis=accrual|cash`, `GET /api/admin/accounting/reports/balance-sheet?asAt=`

**UI reference (QuickBooks):** QBO P&L report layout — collapsible account groups, subtotals, comparison columns.

**Dependencies:** Stages 1–4 (needs accounts, expenses, transactions, and invoice data).

---

### Stage 6 — GST / BAS

**Goal:** Automate preparation of the quarterly Business Activity Statement (BAS) for ATO lodgement, with a review worksheet to identify issues.

**Deliverables:**
- New Prisma model: `BasPeriod`
- Migration
- `/admin/accounting/gst` — BAS periods list:
  - Auto-generate periods based on fiscal year start (from `SalesSettings.fiscalYearStart`)
  - Status indicators: DRAFT / REVIEWED / LODGED
  - Current period highlighted; upcoming period shown as greyed future
- `/admin/accounting/gst/[period]` — BAS worksheet page:
  - **Period summary bar** — quarter label, date range, lodgement due date (28th of month following quarter end), status badge
  - **Sales (GST on Sales) panel** — Label G1 through G3; sourced from `SalesInvoice` records (cash or accrual basis setting); line-by-line invoice list expandable; flags: invoices with mixed tax codes, invoices with no tax code set
  - **Purchases (GST Credits) panel** — Labels G10, G11; sourced from `Expense` records in period; line-by-line expense list expandable; flags: expenses missing tax code, large expenses without receipts, mismatched amounts
  - **Calculated totals** — 1A (GST on sales), 1B (GST credits), Net GST position (payable or refund)
  - **Issues panel** — automatically lists potential problems:
    - Invoices sent but not yet paid (cash vs accrual difference)
    - Expenses with `DRAFT` status (not yet approved)
    - Expenses without receipts over $82.50 (ATO substantiation threshold)
    - Bank transactions in period still `UNMATCHED`
    - Tax codes missing on income or expense items
  - **Mark as Reviewed** button — sets status to `REVIEWED`; prompts to confirm figures before locking
  - **Mark as Lodged** button — sets status to `LODGED`, records `lodgedAt` timestamp; locks period (no further auto-recalculation, figures frozen at a snapshot)
  - **Print / Export** — PDF summary matching ATO BAS form layout (labels 1A, 1B, G1, G10, G11 in standard positions)
- API routes: `GET/POST /api/admin/accounting/bas`, `GET/PUT /api/admin/accounting/bas/[id]`, `GET /api/admin/accounting/bas/[id]/calculate`

**ATO compliance notes:**
- Quarterly periods: Jul–Sep (Q1), Oct–Dec (Q2), Jan–Mar (Q3), Apr–Jun (Q4)
- Lodgement due: 28 Oct, 28 Feb, 28 Apr, 28 Jul (approximately — app will display but not auto-lodge)
- GST registration threshold: $75,000 AUD p.a. (app does not enforce, but reports turnover as G1 reference)
- Cash vs accrual: toggled per BAS period; default matches `SalesSettings` preference
- The app **does not lodge** with the ATO — it prepares the figures for manual lodgement via ATO Business Portal or tax agent

**UI reference (QuickBooks):** QBO GST report + the ATO's own BAS form layout (two-column label/amount table).

**Dependencies:** All prior stages.

---

### Stage 7 — Accounting Dashboard

**Goal:** A consolidated `/admin/accounting` home page giving at-a-glance financial health.

**Deliverables:**
- KPI cards: Total Income (MTD, QTD), Total Expenses (MTD, QTD), Net Profit (MTD, QTD), Outstanding Invoices, Unmatched Transactions count, Next BAS due date + amount estimate
- Mini P&L chart (recharts bar chart, last 6 months income vs expenses)
- Quick actions: Add Expense, Import Transactions, View Current BAS
- Recent expenses list (last 5)
- Unmatched transactions alert banner (if count > 0)

**Dependencies:** All prior stages.

---

## API Route Summary

```
/api/admin/accounting/
  accounts                    GET list, POST create
  accounts/[id]               GET, PUT, DELETE
  bank-accounts               GET list, POST create  
  bank-accounts/[id]          GET, PUT, DELETE
  transactions                GET list (with filters)
  transactions/import         POST (multipart CSV)
  transactions/[id]           GET, PUT
  transactions/[id]/match     POST
  transactions/[id]/unmatch   POST
  transactions/[id]/exclude   POST
  expenses                    GET list, POST create
  expenses/[id]               GET, PUT, DELETE
  receipts/[id]               GET (authenticated file stream)
  reports/profit-loss         GET (query: from, to, basis)
  reports/balance-sheet       GET (query: asAt)
  bas                         GET list, POST create period
  bas/[id]                    GET, PUT
  bas/[id]/calculate          GET (live calculation)
```

---

## Navigation Integration

Add **Accounting** as a new top-level section in the admin sidebar, between Sales and Settings. Sub-items:

- Dashboard
- Chart of Accounts
- Bank Transactions
- Expenses
- Reports
- GST / BAS

---

## File & Folder Structure

```
src/app/admin/accounting/
  layout.tsx
  page.tsx                          ← Stage 7 dashboard
  chart-of-accounts/
    page.tsx
    new/page.tsx
    [id]/page.tsx
  bank-accounts/
    page.tsx
    new/page.tsx
    [id]/page.tsx
  transactions/
    page.tsx
    import/page.tsx
    [id]/page.tsx
  expenses/
    page.tsx
    new/page.tsx
    [id]/page.tsx
  reports/
    page.tsx
    profit-loss/page.tsx
    balance-sheet/page.tsx
  gst/
    page.tsx
    [period]/page.tsx

src/app/api/admin/accounting/
  accounts/route.ts
  accounts/[id]/route.ts
  bank-accounts/route.ts
  bank-accounts/[id]/route.ts
  transactions/route.ts
  transactions/import/route.ts
  transactions/[id]/route.ts
  transactions/[id]/match/route.ts
  transactions/[id]/unmatch/route.ts
  transactions/[id]/exclude/route.ts
  expenses/route.ts
  expenses/[id]/route.ts
  receipts/[id]/route.ts
  reports/profit-loss/route.ts
  reports/balance-sheet/route.ts
  bas/route.ts
  bas/[id]/route.ts
  bas/[id]/calculate/route.ts

src/lib/accounting/
  types.ts
  db-mappers.ts
  chart-of-accounts.ts             ← seed data, account helpers
  csv-parser.ts                    ← bank CSV parsing + format detection
  gst.ts                           ← BAS calculation logic
  reports.ts                       ← P&L and Balance Sheet calculation
  receipt-storage.ts               ← receipt upload/serve helpers

src/components/accounting/
  AccountingNav.tsx
  AccountPicker.tsx
  TaxCodeSelect.tsx
  TransactionMatchPanel.tsx
  BasWorksheet.tsx
  ReportTable.tsx
  ExpenseForm.tsx

prisma/migrations/
  YYYYMMDD_add_chart_of_accounts/migration.sql
  YYYYMMDD_add_expenses/migration.sql
  YYYYMMDD_add_bank_accounts_and_transactions/migration.sql
  YYYYMMDD_add_bas_periods/migration.sql
```

---

## Implementation Order

| Stage | Section | Effort (est.) | Depends on |
|-------|---------|---------------|------------|
| 1 | Chart of Accounts | Small | — |
| 2 | Expenses | Medium | 1 |
| 3 | Bank Accounts & CSV Import | Medium | 1, 2 |
| 4 | Transaction Matching | Medium | 3, Sales |
| 5 | Reports | Large | 1–4 |
| 6 | GST / BAS | Large | 1–5 |
| 7 | Accounting Dashboard | Small | 1–6 |

---

## Out of Scope (for now)

- ATO direct lodgement / SBR2 integration
- PAYG withholding (W1/W2 labels) — BAS structure prepared to accommodate later
- Payroll
- Inventory / stock management
- Multi-currency (AUD only; currency field reserved for future)
- Xero import / migration from QuickBooks (data export helpers could be a future stage)
- Recurring expenses / subscriptions
