import type { AccountTaxCode } from '@/lib/accounting/types'

type GstCode = AccountTaxCode | null | undefined

export function amountExcludingGst(amountCents: number, taxCode: GstCode, taxRatePercent: number): number {
  if (taxCode !== 'GST' || amountCents === 0) return amountCents

  const sign = Math.sign(amountCents)
  const absoluteAmount = Math.abs(amountCents)
  const gstAmount = Math.round((absoluteAmount * taxRatePercent) / (100 + taxRatePercent))

  return sign * (absoluteAmount - gstAmount)
}