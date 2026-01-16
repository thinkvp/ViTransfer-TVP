import type { MoneyCents } from '@/lib/sales/types'

export function calcStripeGrossUpCents(
  invoiceTotalCents: MoneyCents,
  feePercent: number,
  feeFixedCents: MoneyCents
): { chargeCents: MoneyCents; feeCents: MoneyCents } {
  const invoiceCents = Number.isFinite(invoiceTotalCents) ? Math.max(0, Math.trunc(invoiceTotalCents)) : 0
  const fixedCents = Number.isFinite(feeFixedCents) ? Math.max(0, Math.trunc(feeFixedCents)) : 0

  const pct = Number.isFinite(feePercent) ? feePercent : 0
  const p = Math.max(0, pct) / 100

  if (invoiceCents <= 0) return { chargeCents: 0, feeCents: 0 }
  if (p <= 0 && fixedCents <= 0) return { chargeCents: invoiceCents, feeCents: 0 }

  // Guard against nonsense configuration.
  if (p >= 1) {
    // Can't gross-up if Stripe takes 100%+; fall back to charging invoice + fixed.
    const chargeCents = invoiceCents + fixedCents
    return { chargeCents, feeCents: chargeCents - invoiceCents }
  }

  // Stripe fee is: p*C + fixed. Net is: C - (p*C + fixed) = C*(1-p) - fixed.
  // We want net == invoice => C = (invoice + fixed) / (1 - p).
  // Round up to cents so we don't come up short.
  const raw = (invoiceCents + fixedCents) / (1 - p)
  const chargeCents = Math.max(invoiceCents, Math.ceil(raw - 1e-9))
  const feeCents = Math.max(0, chargeCents - invoiceCents)
  return { chargeCents, feeCents }
}
