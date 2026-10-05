import type { AccountTaxCode } from '@/lib/accounting/types'

type GstCode = AccountTaxCode | null | undefined

export function amountExcludingGst(amountCents: number, taxCode: GstCode, taxRatePercent: number): number {
  if (taxCode !== 'GST' || amountCents === 0) return amountCents

  const sign = Math.sign(amountCents)
  const absoluteAmount = Math.abs(amountCents)
  const gstAmount = Math.round((absoluteAmount * taxRatePercent) / (100 + taxRatePercent))

  return sign * (absoluteAmount - gstAmount)
}
/**
 * Split a GST-inclusive amount into ex-GST + GST parts, the way posted expenses store them.
 * Shared by bank-transaction posting/editing and the expense editor so they can't drift.
 */
export function splitGstInclusive(
  amountIncGst: number,
  taxCode: GstCode,
  taxRatePercent: number,
): { amountExGst: number; gstAmount: number } {
  if (taxCode !== 'GST') return { amountExGst: amountIncGst, gstAmount: 0 }
  const taxRate = taxRatePercent / 100
  const gstAmount = Math.round(amountIncGst * taxRate / (1 + taxRate))
  return { amountExGst: amountIncGst - gstAmount, gstAmount }
}
