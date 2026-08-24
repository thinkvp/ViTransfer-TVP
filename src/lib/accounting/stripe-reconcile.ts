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
