import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireMenuAccess } from '@/lib/rbac-api'
import { getQuickBooksConfig, qboQuery, refreshQuickBooksAccessToken, toQboDateTime } from '@/lib/quickbooks/qbo'
import { mergeQboInvoicesIntoSalesTables } from '@/lib/sales/server-qbo-merge'

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

function normalizeInvoiceLines(raw: any): Array<{ description: string; quantity: number; unitPriceCents: number }> {
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
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 5,
      message: 'Too many pulls. Please wait a moment.'
    },
    'sales-qbo-pull-invoices',
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
      const query = `SELECT * FROM Invoice${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
      const result = await qboQuery<any>(auth, query)
      const page = (result?.QueryResponse?.Invoice ?? []) as any[]
      all.push(...page)
      if (page.length < pageSize) break
      startPosition += pageSize
    }

    let created = 0
    let updated = 0
    let skipped = 0

    for (const inv of all) {
      const qboId = typeof inv?.Id === 'string' ? inv.Id.trim() : ''
      if (!qboId) {
        skipped += 1
        continue
      }

      const existing = await (prisma as any).quickBooksInvoiceImport.findUnique({
        where: { qboId },
        select: { id: true },
      })

      const data = {
        qboId,
        docNumber: typeof inv?.DocNumber === 'string' ? inv.DocNumber.trim() : null,
        txnDate: parseQboDate(inv?.TxnDate),
        dueDate: parseQboDate(inv?.DueDate),
        totalAmt: typeof inv?.TotalAmt === 'number' ? inv.TotalAmt : null,
        balance: typeof inv?.Balance === 'number' ? inv.Balance : null,
        customerQboId: typeof inv?.CustomerRef?.value === 'string' ? inv.CustomerRef.value.trim() : null,
        customerName: typeof inv?.CustomerRef?.name === 'string' ? inv.CustomerRef.name.trim() : null,
        privateNote: typeof inv?.PrivateNote === 'string' ? inv.PrivateNote.trim() : null,
        lastUpdatedTime: parseQboDateTime(inv?.MetaData?.LastUpdatedTime),
        raw: inv,
      }

      await (prisma as any).quickBooksInvoiceImport.upsert({
        where: { qboId },
        create: data,
        update: data,
      })

      if (existing) updated += 1
      else created += 1
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

    const nativeInvoices = all.map((inv) => {
      const qboId = typeof inv?.Id === 'string' ? inv.Id.trim() : ''
      const customerQboId = typeof inv?.CustomerRef?.value === 'string' ? inv.CustomerRef.value.trim() : null
      const clientId = customerQboId ? (clientIdByCustomerQboId.get(customerQboId) ?? null) : null

      const txnDateYmd = toYmd(parseQboDate(inv?.TxnDate))
      const dueDateYmd = toYmd(parseQboDate(inv?.DueDate))

      const rawDocNumber = typeof inv?.DocNumber === 'string' && inv.DocNumber.trim() ? inv.DocNumber.trim() : `QBO-INV-${qboId}`
      const docNumber = ensurePrefix(rawDocNumber, 'INV-')

      return {
        qboId,
        docNumber,
        txnDate: txnDateYmd,
        dueDate: dueDateYmd,
        customerQboId,
        clientId,
        customerName: typeof inv?.CustomerRef?.name === 'string' ? inv.CustomerRef.name.trim() : null,
        privateNote: typeof inv?.PrivateNote === 'string' ? inv.PrivateNote.trim() : null,
        lines: normalizeInvoiceLines(inv),
      }
    }).filter((i) => i.qboId)

    const preview = all.slice(0, 20).map((inv) => ({
      id: inv?.Id ?? null,
      docNumber: inv?.DocNumber ?? null,
      txnDate: inv?.TxnDate ?? null,
      dueDate: inv?.DueDate ?? null,
      totalAmt: inv?.TotalAmt ?? null,
      balance: inv?.Balance ?? null,
      customerName: inv?.CustomerRef?.name ?? null,
    }))

    let vitransfer: any = null
    try {
      const merged = await mergeQboInvoicesIntoSalesTables(nativeInvoices)
      vitransfer = {
        ingestedInvoices: merged.ingested,
        skippedInvoicesMissingClient: merged.skippedMissingClient,
        serverSync: { ok: true, updatedAt: merged.updatedAt },
      }
    } catch (e) {
      vitransfer = {
        ingestedInvoices: 0,
        skippedInvoicesMissingClient: 0,
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
      stored: { created, updated, skipped },
      native: {
        invoices: nativeInvoices,
      },
      vitransfer,
      preview,
      note: lookbackDays > 0
        ? `Stored as imports. Invoices modified in last ${lookbackDays} days.`
        : 'Stored as imports. Invoices (all).',
    })
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (error) {
    console.error('QuickBooks pull invoices failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'QuickBooks pull failed' },
      { status: 500 }
    )
  }
}
