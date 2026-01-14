import type { MoneyCents, SalesLineItem } from '@/lib/sales/types'

export function dollarsToCents(input: string): MoneyCents {
  const cleaned = input.replace(/[^0-9.\-]/g, '')
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100)
}

export function centsToDollars(cents: MoneyCents): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const dollars = (abs / 100).toFixed(2)
  return `${sign}${dollars}`
}

export function sumLineItems(items: SalesLineItem[]): MoneyCents {
  return items.reduce((acc, it) => acc + Math.round(it.quantity * it.unitPriceCents), 0)
}

export function calcTaxCents(subtotalCents: MoneyCents, taxRatePercent: number): MoneyCents {
  const rate = Number.isFinite(taxRatePercent) ? taxRatePercent : 0
  return Math.round(subtotalCents * (rate / 100))
}

export function calcLineSubtotalCents(item: SalesLineItem): MoneyCents {
  const qty = Number.isFinite(item.quantity) ? item.quantity : 0
  const unit = Number.isFinite(item.unitPriceCents) ? item.unitPriceCents : 0
  return Math.round(qty * unit)
}

export function calcLineTaxCents(item: SalesLineItem, defaultTaxRatePercent: number): MoneyCents {
  const rate = Number.isFinite(item.taxRatePercent) ? item.taxRatePercent : defaultTaxRatePercent
  return calcTaxCents(calcLineSubtotalCents(item), rate)
}

export function sumLineItemsSubtotal(items: SalesLineItem[]): MoneyCents {
  return items.reduce((acc, it) => acc + calcLineSubtotalCents(it), 0)
}

export function sumLineItemsTax(items: SalesLineItem[], defaultTaxRatePercent: number): MoneyCents {
  return items.reduce((acc, it) => acc + calcLineTaxCents(it, defaultTaxRatePercent), 0)
}

export function sumLineItemsTotal(items: SalesLineItem[], defaultTaxRatePercent: number): MoneyCents {
  return sumLineItemsSubtotal(items) + sumLineItemsTax(items, defaultTaxRatePercent)
}
