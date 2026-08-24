/**
 * Read-only diagnostic for the "Reconcile Stripe bank deposit" section of Match to Invoice.
 *
 * Per-invoice reconcile arrived in v1.6.7 (2026-05-06). Any invoice paid via Stripe before that
 * has no reconcile payment and never will, so the list filter — which keys on the existence of
 * an excludeFromInvoiceBalance payment linked to a bank transaction — cannot hide it. This
 * script quantifies that backlog so the fix can be chosen on numbers rather than impressions.
 *
 * Performs no writes.
 *
 * Usage:
 *   npx tsx scripts/diagnose-stripe-reconcile-list.ts [cutoffYYYY-MM-DD]
 */

import 'dotenv/config'
import { prisma } from '@/lib/db'
import { reconciledBankDepositPaymentWhere } from '@/lib/accounting/stripe-reconcile'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'

const CUTOFF = process.argv[2] || '2026-05-06' // v1.6.7 — per-invoice reconcile shipped
const reconciledWhere = reconciledBankDepositPaymentWhere()

function aud(cents: number) { return `$${(cents / 100).toFixed(2)}` }

async function main() {
  const settings = await prisma.salesSettings.findUnique({
    where: { id: 'default' }, select: { taxRatePercent: true },
  }).catch(() => null)
  const taxRate = Number.isFinite(Number(settings?.taxRatePercent)) ? Number(settings!.taxRatePercent) : 10

  // Earliest Stripe payment per invoice — the date the money actually arrived.
  const stripePayments = await prisma.salesInvoiceStripePayment.findMany({
    select: { invoiceDocId: true, createdAt: true, invoiceAmountCents: true },
    orderBy: { createdAt: 'asc' },
  })
  const paidAtByInvoice = new Map<string, Date>()
  for (const p of stripePayments) {
    if (p.invoiceDocId && !paidAtByInvoice.has(p.invoiceDocId)) paidAtByInvoice.set(p.invoiceDocId, p.createdAt)
  }
  const stripeIds = [...paidAtByInvoice.keys()]

  // Every PAID Stripe invoice, with its reconcile state.
  const all = await prisma.salesInvoice.findMany({
    where: { status: 'PAID', id: { in: stripeIds } },
    select: {
      id: true, invoiceNumber: true, issueDate: true, itemsJson: true, taxEnabled: true,
      client: { select: { name: true } },
      payments: { where: reconciledWhere, select: { id: true } },
    },
    orderBy: [{ issueDate: 'asc' }],
  })

  const cutoffMs = new Date(`${CUTOFF}T00:00:00Z`).getTime()
  const buckets = {
    preFeatureUnreconciled: [] as typeof all,
    preFeatureReconciled: [] as typeof all,
    postFeatureUnreconciled: [] as typeof all,
    postFeatureReconciled: [] as typeof all,
  }

  for (const inv of all) {
    const paidAt = paidAtByInvoice.get(inv.id)
    const pre = !paidAt || paidAt.getTime() < cutoffMs
    const reconciled = inv.payments.length > 0
    if (pre && reconciled) buckets.preFeatureReconciled.push(inv)
    else if (pre) buckets.preFeatureUnreconciled.push(inv)
    else if (reconciled) buckets.postFeatureReconciled.push(inv)
    else buckets.postFeatureUnreconciled.push(inv)
  }

  const total = (rows: typeof all) => rows.reduce((sum, inv) => {
    const items = Array.isArray(inv.itemsJson) ? inv.itemsJson : []
    return sum + sumLineItemsSubtotal(items as any) + (inv.taxEnabled ? sumLineItemsTax(items as any, taxRate) : 0)
  }, 0)

  console.log(`=== PAID Stripe invoices, split at the v1.6.7 cutoff (${CUTOFF}) ===\n`)
  console.log(`pre-feature,  NOT reconciled : ${String(buckets.preFeatureUnreconciled.length).padStart(4)}  ${aud(total(buckets.preFeatureUnreconciled))}   <-- permanent backlog, cannot ever be filtered out`)
  console.log(`pre-feature,  reconciled     : ${String(buckets.preFeatureReconciled.length).padStart(4)}  ${aud(total(buckets.preFeatureReconciled))}   (reconciled retrospectively)`)
  console.log(`post-feature, NOT reconciled : ${String(buckets.postFeatureUnreconciled.length).padStart(4)}  ${aud(total(buckets.postFeatureUnreconciled))}   <-- genuinely outstanding work`)
  console.log(`post-feature, reconciled     : ${String(buckets.postFeatureReconciled.length).padStart(4)}  ${aud(total(buckets.postFeatureReconciled))}   (correctly hidden today)`)

  const offered = [...buckets.preFeatureUnreconciled, ...buckets.postFeatureUnreconciled]
  console.log(`\nthe section offers ${offered.length} invoice(s); it renders the newest 30 by issue date`)
  if (offered.length > 0) {
    const dates = offered.map(i => i.issueDate).sort()
    console.log(`offered issue dates span ${dates[0]} .. ${dates[dates.length - 1]}`)
  }

  console.log('\n=== the pre-feature backlog (oldest first, max 40 shown) ===')
  for (const inv of buckets.preFeatureUnreconciled.slice(0, 40)) {
    const items = Array.isArray(inv.itemsJson) ? inv.itemsJson : []
    const t = sumLineItemsSubtotal(items as any) + (inv.taxEnabled ? sumLineItemsTax(items as any, taxRate) : 0)
    const paidAt = paidAtByInvoice.get(inv.id)
    console.log(`  ${inv.invoiceNumber.padEnd(16)} ${aud(t).padStart(11)}  issued ${inv.issueDate}  stripe-paid ${paidAt ? paidAt.toISOString().slice(0, 10) : 'unknown'}  ${inv.client?.name ?? '-'}`)
  }

  console.log('\n=== how many of the offered invoices could even match a deposit? ===')
  console.log('(reconcile only posts a rounding line when the deposit is within $1.00 of the invoice total)')
  let withCandidateDeposit = 0
  for (const inv of offered) {
    const items = Array.isArray(inv.itemsJson) ? inv.itemsJson : []
    const t = sumLineItemsSubtotal(items as any) + (inv.taxEnabled ? sumLineItemsTax(items as any, taxRate) : 0)
    const n = await prisma.bankTransaction.count({
      where: { amountCents: { gte: t - 100, lte: t + 100 }, status: 'UNMATCHED' },
    })
    if (n > 0) withCandidateDeposit++
  }
  console.log(`${withCandidateDeposit} of ${offered.length} have an UNMATCHED deposit within $1.00 of their total`)
  console.log(`${offered.length - withCandidateDeposit} have no matching deposit waiting — pure noise in the picker`)
}

main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
