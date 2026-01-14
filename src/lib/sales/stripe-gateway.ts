import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/encryption'

export type StripeGatewaySettings = {
  enabled: boolean
  label: string
  feePercent: number
  publishableKey: string | null
  secretKey: string | null
  secretKeySource: 'env' | 'db' | 'none'
  dashboardPaymentDescription: string
  currencies: string[]
}

function parseCurrencies(raw: string | null | undefined): string[] {
  const value = typeof raw === 'string' ? raw : ''
  const parts = value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)

  const out = parts.filter((c) => /^[A-Z]{3}$/.test(c))
  return out.length ? out : ['AUD']
}

export async function getStripeGatewaySettings(): Promise<StripeGatewaySettings> {
  const rows = await prisma.$queryRaw<any[]>`
    SELECT *
    FROM "SalesStripeGatewaySettings"
    WHERE "id" = 'default'
    LIMIT 1
  `
  const row = rows?.[0] as any

  const enabled = row?.enabled ?? false
  const label = (row?.label ?? 'Pay by Credit Card (attracts merchant fees of 1.70%)').trim()
  const feePercent = Number.isFinite(Number(row?.feePercent)) ? Number(row?.feePercent) : 1.7
  const publishableKey = row?.publishableKey ?? null
  const dashboardPaymentDescription = (row?.dashboardPaymentDescription ?? 'Payment for Invoice {invoice_number}').trim()
  const currencies = parseCurrencies(row?.currencies)

  const envSecret = typeof process.env.STRIPE_SECRET_KEY === 'string' ? process.env.STRIPE_SECRET_KEY.trim() : ''
  if (envSecret) {
    return {
      enabled,
      label,
      feePercent,
      publishableKey,
      secretKey: envSecret,
      secretKeySource: 'env',
      dashboardPaymentDescription,
      currencies,
    }
  }

  const encrypted = row?.secretKeyEncrypted
  if (encrypted) {
    const secret = decrypt(encrypted)
    const trimmed = typeof secret === 'string' ? secret.trim() : ''
    return {
      enabled,
      label,
      feePercent,
      publishableKey,
      secretKey: trimmed || null,
      secretKeySource: trimmed ? 'db' : 'none',
      dashboardPaymentDescription,
      currencies,
    }
  }

  return {
    enabled,
    label,
    feePercent,
    publishableKey,
    secretKey: null,
    secretKeySource: 'none',
    dashboardPaymentDescription,
    currencies,
  }
}

export function formatStripeDashboardDescription(template: string, invoiceNumber: string): string {
  const t = typeof template === 'string' ? template : ''
  const inv = typeof invoiceNumber === 'string' ? invoiceNumber : ''
  return t.replaceAll('{invoice_number}', inv)
}
