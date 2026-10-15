import type { Prisma } from '@prisma/client'

// Predicate for "a bank deposit has already been reconciled against this invoice".
//
// A Stripe-paid invoice always carries an `excludeFromInvoiceBalance` mirror payment created
// by the Stripe webhook (src/app/api/stripe/webhook/route.ts) with no bank-transaction link.
// Reconciling a bank deposit against that invoice adds a *second* excludeFromInvoiceBalance
// payment, this one linked to the BankTransaction — so the link, not the exclude flag, is what
// separates "paid via Stripe" from "paid via Stripe and already reconciled".
//
// Both link directions are checked: SalesPayment.bankTransactionId (set on every invoice match)
// and the BankTransaction.invoicePaymentId back-relation (set on single-invoice matches only).
//
// Two call sites depend on this agreeing exactly: the Match-to-Invoice list hides invoices that
// satisfy it, and the match-invoice route rejects them. Keep both on this helper — if the list
// were the looser of the two, it would offer invoices the API then refuses.

export function reconciledBankDepositPaymentWhere(): Prisma.SalesPaymentWhereInput {
  return {
    excludeFromInvoiceBalance: true,
    OR: [
      { bankTransactionId: { not: null } },
      { bankTransaction: { isNot: null } },
    ],
  }
}

// Reconcile start date — the point from which per-invoice Stripe reconciliation is considered
// to be in use on this install.
//
// Per-invoice reconcile shipped in v1.6.7 (2026-05-06). Every Stripe-paid invoice settled
// before that was reconciled some other way (categorised via Split, posted straight to an
// income account, or handled outside the app entirely), and none of them carry the marker
// payment `reconciledBankDepositPaymentWhere()` looks for. Nothing will ever create one, so
// without a cutoff they sit in the "Reconcile Stripe bank deposit" picker permanently, burying
// the handful of invoices that are genuinely outstanding.
//
// There is no database state that separates "reconciled in February by other means" from
// "never touched", so this cannot be inferred — it has to be declared. It is read from the
// environment rather than stored, deliberately: it is set once when an install adopts the
// feature and then never changes, which is configuration, not data.
//
// Set STRIPE_RECONCILE_START_DATE=YYYY-MM-DD to override. The default is the release date of
// the feature itself, which is the earliest value that can ever be correct — no install can
// hold reconcile data from before the code existed — so it is safe but conservative. An
// install that adopted the feature later should set its own adoption date to clear the
// backlog in between.
//
// This only narrows what the picker offers. The match-invoice route does not apply it, so an
// older invoice reconciled deliberately still succeeds; the list stays stricter than the API,
// never looser, which is the safe direction (see the note on the predicate above).

export const DEFAULT_STRIPE_RECONCILE_START_DATE = '2026-05-06' // v1.6.7

const YMD = /^\d{4}-\d{2}-\d{2}$/

// Parsed as local midnight, matching how the rest of the sales/accounting code treats a
// YYYY-MM-DD (see endOfDayLocal in src/lib/sales/server-document-share.ts). A cutoff is
// chosen at month granularity in practice, so the timezone offset is immaterial to it.
export function parseReconcileStartDate(value: string | undefined): Date {
  const raw = (value ?? '').trim()
  const ymd = YMD.test(raw) ? raw : DEFAULT_STRIPE_RECONCILE_START_DATE
  if (raw && ymd !== raw) {
    console.warn(`[STRIPE_RECONCILE] Ignoring malformed STRIPE_RECONCILE_START_DATE="${raw}" — expected YYYY-MM-DD. Falling back to ${DEFAULT_STRIPE_RECONCILE_START_DATE}.`)
  }
  const parsed = toLocalMidnight(ymd)
  if (parsed) return parsed

  // Well-formed but impossible (2026-13-45). Date() rolls those over silently rather than
  // returning NaN, so the components are compared back rather than checked for NaN.
  console.warn(`[STRIPE_RECONCILE] STRIPE_RECONCILE_START_DATE="${raw}" is not a real date. Falling back to ${DEFAULT_STRIPE_RECONCILE_START_DATE}.`)
  return toLocalMidnight(DEFAULT_STRIPE_RECONCILE_START_DATE)!
}

function toLocalMidnight(ymd: string): Date | null {
  const [y, m, d] = ymd.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const roundTrips = date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
  return roundTrips ? date : null
}

export function stripeReconcileStartDate(): Date {
  return parseReconcileStartDate(process.env.STRIPE_RECONCILE_START_DATE)
}

// Difference between a Stripe bank deposit and the invoice it settles, and what reconciling
// it posts to the Stripe Fees Account (AccountingSettings.stripeRoundingAccountId).
//
// Once card fees stopped being surcharged to the client, Stripe pays out the invoice total
// less its processing fee, so the shortfall is a real expense rather than rounding. A
// shortfall up to MAX_STRIPE_FEE_PERCENT of the invoice is posted as a fee; anything larger,
// or a deposit more than $1.00 above the invoice, is almost certainly the wrong invoice (or a
// batched payout), so it is refused rather than written off.
//
// Shared by the Match-to-Invoice dialog (preview) and the match-invoice route (enforcement)
// so the two can't disagree. Client-safe: the only import above is type-only.

export const STRIPE_ROUNDING_TOLERANCE_CENTS = 100
export const MAX_STRIPE_FEE_PERCENT = 10

export type StripeDepositDifference =
  | { kind: 'none' }
  // amountCents is signed in bank convention: negative = fee (money Stripe kept),
  // positive = deposit slightly above the invoice
  | { kind: 'fee' | 'rounding'; amountCents: number }
  | { kind: 'tooLarge'; amountCents: number; error: string }

export function stripeDepositDifference(depositCents: number, invoiceTotalCents: number): StripeDepositDifference {
  const diff = depositCents - invoiceTotalCents
  if (diff === 0) return { kind: 'none' }
  if (Math.abs(diff) <= STRIPE_ROUNDING_TOLERANCE_CENTS) return { kind: diff < 0 ? 'fee' : 'rounding', amountCents: diff }
  const fmt = (c: number) => `$${(Math.abs(c) / 100).toFixed(2)}`
  if (diff > 0) {
    return {
      kind: 'tooLarge',
      amountCents: diff,
      error: `The deposit is ${fmt(diff)} more than the invoice — check you picked the right invoice.`,
    }
  }
  if (-diff * 100 > invoiceTotalCents * MAX_STRIPE_FEE_PERCENT) {
    return {
      kind: 'tooLarge',
      amountCents: diff,
      error: `The deposit is ${fmt(diff)} less than the invoice (more than ${MAX_STRIPE_FEE_PERCENT}%) — too large to be a Stripe fee. Check you picked the right invoice.`,
    }
  }
  return { kind: 'fee', amountCents: diff }
}
