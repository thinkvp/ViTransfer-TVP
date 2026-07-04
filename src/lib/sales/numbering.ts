import type { Prisma } from '@prisma/client'

type SalesDocumentType = 'invoice' | 'quote'

type HighestNumberRow = {
  value: number | bigint | null
}

const SALES_NUMBER_CONFIG = {
  invoice: {
    field: 'invoice',
    prefix: 'INV-',
    label: 'invoice',
    defaultWidth: 4,
    lockKey: 41001,
  },
  quote: {
    field: 'quote',
    prefix: 'EST-',
    label: 'quote',
    defaultWidth: 4,
    lockKey: 41002,
  },
} as const

function toSafeInteger(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
}

function formatDocumentNumber(prefix: string, value: number, width: number): string {
  const digits = String(value)
  return `${prefix}${digits.padStart(Math.max(width, digits.length), '0')}`
}

async function findHighestExistingNumber(
  tx: Prisma.TransactionClient,
  type: SalesDocumentType
): Promise<{ value: number }> {
  const rows = type === 'invoice'
    ? await tx.$queryRaw<HighestNumberRow[]>`
        SELECT
          CAST(regexp_replace("invoiceNumber", '^INV-', '') AS INTEGER) AS value
        FROM "SalesInvoice"
        WHERE "invoiceNumber" ~ '^INV-[0-9]+$'
        ORDER BY value DESC, "createdAt" DESC
        LIMIT 1
      `
    : await tx.$queryRaw<HighestNumberRow[]>`
        SELECT
          CAST(regexp_replace("quoteNumber", '^EST-', '') AS INTEGER) AS value
        FROM "SalesQuote"
        WHERE "quoteNumber" ~ '^EST-[0-9]+$'
        ORDER BY value DESC, "createdAt" DESC
        LIMIT 1
      `

  const row = Array.isArray(rows) ? rows[0] : null
  return {
    value: toSafeInteger(row?.value),
  }
}

async function lockSalesDocumentNumbering(
  tx: Prisma.TransactionClient,
  type: SalesDocumentType
): Promise<void> {
  const config = SALES_NUMBER_CONFIG[type]
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${config.lockKey})`
}

export async function nextSalesDocumentNumber(
  tx: Prisma.TransactionClient,
  type: SalesDocumentType
): Promise<string> {
  const config = SALES_NUMBER_CONFIG[type]
  await lockSalesDocumentNumbering(tx, type)

  const highestExisting = await findHighestExistingNumber(tx, type)
  const nextValue = Math.max(1, highestExisting.value + 1)

  await tx.salesSequence.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      quote: type === 'quote' ? nextValue : 0,
      invoice: type === 'invoice' ? nextValue : 0,
    },
    update: { [config.field]: { set: nextValue } },
  } as any)

  return formatDocumentNumber(config.prefix, nextValue, config.defaultWidth)
}