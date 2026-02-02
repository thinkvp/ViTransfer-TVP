import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getQuickBooksConfig, qboQuery, refreshQuickBooksAccessToken, toQboDateTime } from '@/lib/quickbooks/qbo'
import { mergeQboQuotesIntoSalesTables } from '@/lib/sales/server-qbo-merge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function getLookbackDays(request: NextRequest): Promise<number> {
  const body = await request.json().catch(() => null)
  const daysRaw = typeof body?.days === 'number' ? body.days : Number(body?.days)
  const days = Number.isFinite(daysRaw) ? Math.floor(daysRaw) : 7
  return Math.min(Math.max(days, 0), 3650)
}

function parseQboDate(dateStr: unknown): Date | null {
  if (typeof dateStr !== 'string') return null
  const s = dateStr.trim()
  if (!s) return null
  // QBO TxnDate / DueDate are typically YYYY-MM-DD.
  const d = new Date(`${s}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function parseQboDateTime(dateStr: unknown): Date | null {
  if (typeof dateStr !== 'string') return null
  const s = dateStr.trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function toYmd(date: Date | null): string | null {
  if (!date) return null
  try {
    return date.toISOString().slice(0, 10)
  } catch {
    return null
  }
}

function ensurePrefix(value: string, prefix: string): string {
  const v = value.trim()
  if (!v) return prefix
  const upper = v.toUpperCase()
  if (upper.startsWith(prefix.toUpperCase())) return v
  return `${prefix}${v}`
}

function dollarsToCentsSafe(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.round(value * 100)
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeEstimateLines(raw: any): Array<{ description: string; quantity: number; unitPriceCents: number }> {
  const lines = Array.isArray(raw?.Line) ? raw.Line : []
  const out: Array<{ description: string; quantity: number; unitPriceCents: number }> = []

  for (const line of lines) {
    if (!line) continue

    const amount = coerceNumber(line?.Amount)
    const detailType = typeof line?.DetailType === 'string' ? line.DetailType : ''
    const salesDetail = detailType === 'SalesItemLineDetail' ? line?.SalesItemLineDetail : null

    const qtyRaw = salesDetail ? coerceNumber(salesDetail?.Qty) : null
    const qty = qtyRaw && qtyRaw > 0 ? qtyRaw : 1

    const unitPriceRaw = salesDetail ? coerceNumber(salesDetail?.UnitPrice) : null
    const unitPrice = unitPriceRaw ?? (amount !== null ? amount / qty : 0)

    const descFromDetail = typeof salesDetail?.ItemRef?.name === 'string' ? salesDetail.ItemRef.name.trim() : ''
    const descFromLine = typeof line?.Description === 'string' ? line.Description.trim() : ''
    const description = descFromLine || descFromDetail || ''

    // Ignore pure subtotal lines and empty zero-amount noise.
    if (detailType === 'SubTotalLineDetail') continue
    if (!description && (!amount || amount === 0)) continue

    out.push({
      description: description || 'Line item',
      quantity: qty,
      unitPriceCents: dollarsToCentsSafe(unitPrice),
    })
  }

  return out
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 5,
      message: 'Too many pulls. Please wait a moment.'
    },
    'sales-qbo-pull-quotes',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const cfg = await getQuickBooksConfig()
  if (!cfg.configured) {
    return NextResponse.json({ configured: false, missing: cfg.missing }, { status: 400 })
  }

  try {
    const lookbackDays = await getLookbackDays(request)
    const auth = await refreshQuickBooksAccessToken()

    const since = new Date()
    since.setDate(since.getDate() - lookbackDays)
    const sinceQbo = toQboDateTime(since)

    const pageSize = 1000
    let startPosition = 1

    const all: any[] = []
    while (true) {
      const whereClause = lookbackDays > 0 ? ` WHERE MetaData.LastUpdatedTime >= '${sinceQbo}'` : ''
      // NOTE: QBO query language does not allow selecting complex fields explicitly.
      // Use SELECT * to avoid missing-field query errors.
      const query = `SELECT * FROM Estimate${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
      const result = await qboQuery<any>(auth, query)
      const page = (result?.QueryResponse?.Estimate ?? []) as any[]
      all.push(...page)
      if (page.length < pageSize) break
      startPosition += pageSize
    }

    let created = 0
    let skipped = 0

    for (const e of all) {
      const qboId = typeof e?.Id === 'string' ? e.Id.trim() : ''
      if (!qboId) {
        skipped += 1
        continue
      }

      const existing = await (prisma as any).quickBooksEstimateImport.findUnique({
        where: { qboId },
        select: { id: true },
      })

      // Match daily pull semantics: we only store NEW imports.
      // Existing imports are treated as skipped (no update/write).
      if (existing) {
        skipped += 1
        continue
      }

      const data = {
        qboId,
        docNumber: typeof e?.DocNumber === 'string' ? e.DocNumber.trim() : null,
        txnDate: parseQboDate(e?.TxnDate),
        totalAmt: typeof e?.TotalAmt === 'number' ? e.TotalAmt : null,
        customerQboId: typeof e?.CustomerRef?.value === 'string' ? e.CustomerRef.value.trim() : null,
        customerName: typeof e?.CustomerRef?.name === 'string' ? e.CustomerRef.name.trim() : null,
        privateNote: typeof e?.PrivateNote === 'string' ? e.PrivateNote.trim() : null,
        lastUpdatedTime: parseQboDateTime(e?.MetaData?.LastUpdatedTime),
        raw: e,
      }

      try {
        await (prisma as any).quickBooksEstimateImport.create({ data })
        created += 1
      } catch (e: any) {
        // If another pull created it concurrently, count as skipped.
        if (e?.code === 'P2002') {
          skipped += 1
          continue
        }
        throw e
      }
    }

    const customerQboIds = Array.from(
      new Set(
        all
          .map((e) => (typeof e?.CustomerRef?.value === 'string' ? e.CustomerRef.value.trim() : ''))
          .filter(Boolean)
      )
    )

    const clients = customerQboIds.length
      ? await prisma.client.findMany({
          where: { quickbooksCustomerId: { in: customerQboIds } },
          select: { id: true, quickbooksCustomerId: true },
        })
      : []
    const clientIdByCustomerQboId = new Map(clients.map((c) => [String(c.quickbooksCustomerId), c.id]))

    const nativeQuotes = all.map((e) => {
      const qboId = typeof e?.Id === 'string' ? e.Id.trim() : ''
      const customerQboId = typeof e?.CustomerRef?.value === 'string' ? e.CustomerRef.value.trim() : null
      const clientId = customerQboId ? (clientIdByCustomerQboId.get(customerQboId) ?? null) : null

      const txnDateYmd = toYmd(parseQboDate(e?.TxnDate))
      const validUntilYmd = toYmd(parseQboDate(e?.ExpirationDate))

      const rawDocNumber = typeof e?.DocNumber === 'string' && e.DocNumber.trim() ? e.DocNumber.trim() : `QBO-EST-${qboId}`
      const docNumber = ensurePrefix(rawDocNumber, 'EST-')

      return {
        qboId,
        docNumber,
        txnDate: txnDateYmd,
        validUntil: validUntilYmd,
        customerQboId,
        clientId,
        customerName: typeof e?.CustomerRef?.name === 'string' ? e.CustomerRef.name.trim() : null,
        customerMemo: typeof e?.CustomerMemo?.value === 'string' ? e.CustomerMemo.value.trim() : null,
        privateNote: typeof e?.PrivateNote === 'string' ? e.PrivateNote.trim() : null,
        lines: normalizeEstimateLines(e),
      }
    }).filter((q) => q.qboId)

    const preview = all.slice(0, 20).map((e) => ({
      id: e?.Id ?? null,
      docNumber: e?.DocNumber ?? null,
      txnDate: e?.TxnDate ?? null,
      totalAmt: e?.TotalAmt ?? null,
      customerId: e?.CustomerRef?.value ?? null,
      customerName: e?.CustomerRef?.name ?? null,
    }))

    let vitransfer: any = null
    try {
      const merged = await mergeQboQuotesIntoSalesTables(nativeQuotes)
      vitransfer = {
        ingestedQuotes: merged.ingested,
        skippedQuotesMissingClient: merged.skippedMissingClient,
        serverSync: { ok: true, updatedAt: merged.updatedAt },
      }
    } catch (e) {
      vitransfer = {
        ingestedQuotes: 0,
        skippedQuotesMissingClient: 0,
        serverSync: { ok: false, error: e instanceof Error ? e.message : String(e) },
      }
    }

    const res = NextResponse.json({
      configured: true,
      rotatedRefreshToken: auth.rotatedRefreshToken,
      refreshTokenSource: auth.refreshTokenSource,
      refreshTokenPersisted: auth.refreshTokenPersisted,
      lookbackDays,
      fetched: all.length,
      stored: { created, updated: 0, skipped },
      native: {
        quotes: nativeQuotes,
      },
      vitransfer,
      preview,
      note: lookbackDays > 0
        ? `Stored as imports. Quotes modified in last ${lookbackDays} days.`
        : 'Stored as imports. Quotes (all).',
    })
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (error) {
    console.error('QuickBooks pull quotes failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'QuickBooks pull failed' },
      { status: 500 }
    )
  }
}
