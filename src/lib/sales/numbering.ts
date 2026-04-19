import type { Prisma } from '@prisma/client'

type SalesDocumentType = 'invoice' | 'quote'

type HighestNumberRow = {
  value: number | bigint | null
  width: number | bigint | null
}

const SALES_NUMBER_CONFIG = {
  invoice: {
    field: 'invoice',
    prefix: 'INV-',
    label: 'invoice',
    defaultWidth: 6,
  },
  quote: {
    field: 'quote',
    prefix: 'EST-',
    label: 'quote',
    defaultWidth: 6,
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
): Promise<{ value: number; width: number }> {
  const rows = type === 'invoice'
    ? await tx.$queryRaw<HighestNumberRow[]>`
        SELECT
          CAST(regexp_replace("invoiceNumber", '^INV-', '') AS INTEGER) AS value,
          length(regexp_replace("invoiceNumber", '^INV-', '')) AS width
        FROM "SalesInvoice"
        WHERE "invoiceNumber" ~ '^INV-[0-9]+$'
        ORDER BY value DESC, width DESC, "createdAt" DESC
        LIMIT 1
      `
    : await tx.$queryRaw<HighestNumberRow[]>`
        SELECT
          CAST(regexp_replace("quoteNumber", '^EST-', '') AS INTEGER) AS value,
          length(regexp_replace("quoteNumber", '^EST-', '')) AS width
        FROM "SalesQuote"
        WHERE "quoteNumber" ~ '^EST-[0-9]+$'
        ORDER BY value DESC, width DESC, "createdAt" DESC
        LIMIT 1
      `

  const row = Array.isArray(rows) ? rows[0] : null
  return {
    value: toSafeInteger(row?.value),
    width: toSafeInteger(row?.width),
  }
}

export async function nextSalesDocumentNumber(
  tx: Prisma.TransactionClient,
  type: SalesDocumentType
): Promise<string> {
  const config = SALES_NUMBER_CONFIG[type]
  const highestExisting = await findHighestExistingNumber(tx, type)
  const numberWidth = highestExisting.width > 0 ? highestExisting.width : config.defaultWidth

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const seq = await tx.salesSequence.upsert({
      where: { id: 'default' },
      create: { id: 'default', quote: 0, invoice: 0 },
      update: { [config.field]: { increment: 1 } },
      select: { [config.field]: true },
    } as any)

    const reservedValue = toSafeInteger((seq as any)[config.field])
    if (reservedValue > highestExisting.value) {
      return formatDocumentNumber(config.prefix, reservedValue, numberWidth)
    }

    const nextValue = highestExisting.value + 1
    const jumped = await tx.salesSequence.updateMany({
      where: { id: 'default', [config.field]: reservedValue },
      data: { [config.field]: nextValue },
    } as any)

    if (jumped.count === 1) {
      return formatDocumentNumber(config.prefix, nextValue, numberWidth)
    }
  }

  throw new Error(`Failed to allocate next ${config.label} number`)
}