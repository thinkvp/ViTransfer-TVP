/**
 * Warn before a write changes figures in a lodged BAS period.
 *
 * A route lists the BAS-relevant dates its change touches, before and after (see the
 * *Effects helpers). If any falls inside a LODGED period of the matching basis, the route
 * answers 409 `code: 'LODGED_BAS_PERIOD'` until the request is repeated with the
 * `X-Confirm-Lodged-Period: 1` header. apiFetch handles that round trip for every caller:
 * it shows the confirmation and retries, so pages need no handling of their own.
 *
 * The confirmation is a heads-up, not a lock: whatever is changed shows on the lodged period
 * as "changed since lodgement" (bas-adjustments.ts) and can be carried into the next BAS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSalesTaxRate } from '@/lib/settings'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import type { SalesLineItem } from '@/lib/sales/types'

export const LODGED_PERIOD_CONFIRM_HEADER = 'x-confirm-lodged-period'

type Basis = 'CASH' | 'ACCRUAL'

/** A date this change reports on; `basis` limits it to periods lodged on that basis. */
export interface BasEffect {
  date: string | null | undefined
  basis?: Basis
}

const BAS_ACCOUNT_TYPES = new Set(['INCOME', 'EXPENSE', 'COGS'])

/**
 * Expense rows: on cash basis only RECONCILED expenses count, dated by the paying bank
 * transaction; on accrual, APPROVED + RECONCILED by expense date (mirrors calculateBas).
 */
export function expenseBasEffects(e: {
  date: string
  status: string
  taxCode?: string | null
  bankTransactionDate?: string | null
} | null | undefined): BasEffect[] {
  if (!e) return []
  const out: BasEffect[] = []
  if (e.status === 'RECONCILED') out.push({ date: e.bankTransactionDate ?? e.date, basis: 'CASH' })
  if (e.status === 'APPROVED' || e.status === 'RECONCILED') out.push({ date: e.date, basis: 'ACCRUAL' })
  return out
}

/**
 * A ledger posting (manual bank posting, journal, split line): reported on both bases on its
 * own date when it sits on an income/expense/COGS account. BAS Excluded postings never reach
 * a BAS label, so they don't count.
 */
export function postingBasEffects(p: {
  date: string
  accountType?: string | null
  taxCode?: string | null
} | null | undefined): BasEffect[] {
  if (!p || !p.accountType || !BAS_ACCOUNT_TYPES.has(p.accountType)) return []
  if (!p.taxCode || p.taxCode === 'BAS_EXCLUDED') return []
  return [{ date: p.date }]
}

/** Invoices are reported on accrual basis by issue date (every status except VOID). */
export function salesInvoiceBasEffects(inv: { issueDate: string; status: string } | null | undefined): BasEffect[] {
  if (!inv || inv.status === 'VOID') return []
  return [{ date: inv.issueDate, basis: 'ACCRUAL' }]
}

/** Payments received are reported on cash basis by payment date. */
export function salesPaymentBasEffects(p: {
  paymentDate: string
  excludeFromInvoiceBalance?: boolean
  source?: string
} | null | undefined): BasEffect[] {
  if (!p) return []
  if (p.excludeFromInvoiceBalance && p.source !== 'STRIPE') return []
  return [{ date: p.paymentDate, basis: 'CASH' }]
}

/**
 * An edit, void or delete of an existing invoice. Accrual reports it on its issue date;
 * cash basis reports its receipts, whose GST split comes from the invoice's items — so an
 * amount change also touches every counted payment's date. Edits that change neither the
 * totals nor the issue date (notes, terms, status, reminders) don't count.
 */
export async function salesInvoiceChangeBasEffects(
  invoiceId: string,
  change: { issueDate?: string; items?: SalesLineItem[]; removing?: boolean }
): Promise<BasEffect[]> {
  const current = await prisma.salesInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      status: true,
      issueDate: true,
      itemsJson: true,
      taxEnabled: true,
      payments: { select: { paymentDate: true, excludeFromInvoiceBalance: true, source: true } },
    },
  })
  if (!current || current.status === 'VOID') return []

  let amountsChanged = !!change.removing
  if (!amountsChanged && change.items) {
    const rate = await getSalesTaxRate()
    const totals = (items: SalesLineItem[]) => {
      const subtotal = sumLineItemsSubtotal(items)
      return `${subtotal}|${current.taxEnabled ? sumLineItemsTax(items, rate) : 0}`
    }
    amountsChanged = totals((current.itemsJson as SalesLineItem[] | null) ?? []) !== totals(change.items)
  }
  const dateChanged = !!change.issueDate && change.issueDate !== current.issueDate
  if (!amountsChanged && !dateChanged) return []

  return [
    ...salesInvoiceBasEffects(current),
    ...(dateChanged ? salesInvoiceBasEffects({ issueDate: change.issueDate!, status: current.status }) : []),
    ...(amountsChanged ? current.payments.flatMap((p) => salesPaymentBasEffects(p)) : []),
  ]
}

/** postingBasEffects for lines that only carry an account id (split lines, new postings). */
export async function postingLinesBasEffects(
  date: string,
  lines: Array<{ accountId: string | null; taxCode: string | null }>
): Promise<BasEffect[]> {
  const ids = Array.from(new Set(lines.map((l) => l.accountId).filter((id): id is string => !!id)))
  if (ids.length === 0) return []
  const accounts = await prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, type: true } })
  const typeById = new Map(accounts.map((a) => [a.id, a.type as string]))
  return lines.flatMap((l) => postingBasEffects({
    date,
    accountType: l.accountId ? typeById.get(l.accountId) : null,
    taxCode: l.taxCode,
  }))
}

export function isLodgedPeriodConfirmed(request: NextRequest, bodyFlag?: boolean): boolean {
  return bodyFlag === true || request.headers.get(LODGED_PERIOD_CONFIRM_HEADER) === '1'
}

/**
 * Returns a 409 response when the change touches a lodged BAS period and the user has not
 * confirmed yet; null when the write may go ahead.
 */
export async function lodgedPeriodGuard(
  request: NextRequest,
  effects: BasEffect[],
  what: string,
  options?: { confirmed?: boolean }
): Promise<NextResponse | null> {
  if (options?.confirmed ?? isLodgedPeriodConfirmed(request)) return null
  const dated = effects.filter((e): e is BasEffect & { date: string } => !!e.date)
  if (dated.length === 0) return null

  const dates = Array.from(new Set(dated.map((e) => e.date)))
  const periods = await prisma.basPeriod.findMany({
    where: {
      status: 'LODGED',
      OR: dates.map((d) => ({ startDate: { lte: d }, endDate: { gte: d } })),
    },
    select: { label: true, quarter: true, financialYear: true, basis: true, startDate: true, endDate: true },
    orderBy: { startDate: 'asc' },
  })
  const hit = periods.find((p) => dated.some((e) =>
    e.date >= p.startDate && e.date <= p.endDate && (!e.basis || e.basis === (p.basis === 'ACCRUAL' ? 'ACCRUAL' : 'CASH'))
  ))
  if (!hit) return null

  const label = hit.label || `Q${hit.quarter} ${hit.financialYear}`
  return NextResponse.json({
    error: `${what} changes figures in ${label}, which has already been lodged. If you go ahead, the difference will be flagged on that BAS so you can carry it into your next one.`,
    code: 'LODGED_BAS_PERIOD',
    periodLabel: label,
  }, { status: 409 })
}
