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
