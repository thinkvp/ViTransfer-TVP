import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireMenuAccess } from '@/lib/rbac-api'
import { getQuickBooksConfig, qboQuery, refreshQuickBooksAccessToken, toQboDateTime } from '@/lib/quickbooks/qbo'
import { mergeQboPaymentsIntoSalesTables } from '@/lib/sales/server-qbo-merge'

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

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function extractAppliedInvoiceQboIds(payment: any): Array<{ invoiceQboId: string; amount: number | null }> {
  const lines = Array.isArray(payment?.Line) ? payment.Line : []
  const out: Array<{ invoiceQboId: string; amount: number | null }> = []

  for (const line of lines) {
    if (!line) continue
    const linked = Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : []
    const linkedInvoices = linked
      .map((lt: any) => {
        const txnType = typeof lt?.TxnType === 'string' ? lt.TxnType.trim() : ''
        const txnId = typeof lt?.TxnId === 'string' ? lt.TxnId.trim() : ''
        if (txnType !== 'Invoice' || !txnId) return null
        return txnId
      })
      .filter(Boolean) as string[]

    if (linkedInvoices.length === 0) continue

    // If a line is tied to exactly one invoice, we can safely treat Amount as the applied amount.
    const maybeAmount = linkedInvoices.length === 1 ? coerceNumber(line?.Amount) : null

    for (const invoiceQboId of linkedInvoices) {
      out.push({ invoiceQboId, amount: maybeAmount })
    }
  }

  // De-dupe by invoiceQboId (keep the first occurrence; amounts can be refined later if needed).
  const seen = new Set<string>()
  const deduped: Array<{ invoiceQboId: string; amount: number | null }> = []
  for (const row of out) {
    if (seen.has(row.invoiceQboId)) continue
    seen.add(row.invoiceQboId)
    deduped.push(row)
  }
  return deduped
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
    'sales-qbo-pull-payments',
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
      // Use SELECT * to avoid missing-field query errors, and to capture line/link details.
      const query = `SELECT * FROM Payment${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
      const result = await qboQuery<any>(auth, query)
      const page = (result?.QueryResponse?.Payment ?? []) as any[]
      all.push(...page)
      if (page.length < pageSize) break
      startPosition += pageSize
    }

    let created = 0
    let skipped = 0
    let skippedUnmatchedInvoice = 0
    let appliedLinksCreated = 0

    const allAppliedInvoiceQboIds = Array.from(
      new Set(
        all
          .flatMap((p) => extractAppliedInvoiceQboIds(p).map((x) => x.invoiceQboId))
          .filter(Boolean)
      )
    )

    const invoiceImports = allAppliedInvoiceQboIds.length
      ? await (prisma as any).quickBooksInvoiceImport.findMany({
          where: { qboId: { in: allAppliedInvoiceQboIds } },
          select: { id: true, qboId: true, customerQboId: true },
        })
      : []
    const invoiceImportIdByQboId = new Map<string, string>(invoiceImports.map((i: any) => [String(i.qboId), i.id]))

    const customerQboIds = Array.from(
      new Set<string>(
        invoiceImports
          .map((i: any) => (typeof i?.customerQboId === 'string' ? i.customerQboId.trim() : null))
          .filter((v: any): v is string => typeof v === 'string' && Boolean(v))
      )
    )
    const clients = customerQboIds.length
      ? await prisma.client.findMany({
          where: { quickbooksCustomerId: { in: customerQboIds } },
          select: { id: true, quickbooksCustomerId: true },
        })
      : []
    const clientIdByCustomerQboId = new Map(clients.map((c) => [String(c.quickbooksCustomerId), c.id]))

    const customerQboIdByInvoiceQboId = new Map<string, string | null>(
      invoiceImports.map((i: any) => [String(i.qboId), typeof i?.customerQboId === 'string' ? i.customerQboId.trim() : null])
    )

    const nativePayments: Array<{
      paymentQboId: string
      invoiceQboId: string
      txnDate: string | null
      amountCents: number
      method: string
      reference: string
      clientId: string | null
    }> = []

    let nativeOmittedMissingAmount = 0

    for (const p of all) {
      const qboId = typeof p?.Id === 'string' ? p.Id.trim() : ''
      if (!qboId) {
        skipped += 1
        continue
      }

       // Only import payments we can associate with at least one known invoice.
      const appliedAll = extractAppliedInvoiceQboIds(p)
      const appliedMatched = appliedAll.filter((row) => invoiceImportIdByQboId.has(row.invoiceQboId))
      if (appliedMatched.length === 0) {
        skippedUnmatchedInvoice += 1
        continue
      }

      // Build native payment rows (one per invoice, because native SalesPayment only supports one invoiceId).
      const txnDateYmd = toYmd(parseQboDate(p?.TxnDate))
      const paymentMethod = typeof p?.PaymentMethodRef?.name === 'string' ? p.PaymentMethodRef.name.trim() : 'QuickBooks'
      const reference = typeof p?.PaymentRefNum === 'string' && p.PaymentRefNum.trim() ? p.PaymentRefNum.trim() : `QBO-PAY-${qboId}`
      const totalAmt = typeof p?.TotalAmt === 'number' ? p.TotalAmt : null

      for (const row of appliedMatched) {
        let amount: number | null = row.amount
        if (amount === null) {
          if (appliedMatched.length === 1 && totalAmt !== null) amount = totalAmt
          else {
            nativeOmittedMissingAmount += 1
            continue
          }
        }

        if (amount === null) {
          nativeOmittedMissingAmount += 1
          continue
        }

        const invoiceCustomerQboId = customerQboIdByInvoiceQboId.get(row.invoiceQboId) ?? null
        const clientId = invoiceCustomerQboId ? (clientIdByCustomerQboId.get(invoiceCustomerQboId) ?? null) : null

        nativePayments.push({
          paymentQboId: qboId,
          invoiceQboId: row.invoiceQboId,
          txnDate: txnDateYmd,
          amountCents: Math.round(amount * 100),
          method: paymentMethod || 'QuickBooks',
          reference,
          clientId,
        })
      }

      const existing = await (prisma as any).quickBooksPaymentImport.findUnique({
        where: { qboId },
        select: { id: true },
      })

      // Match daily pull semantics: we only store NEW imports.
      // Existing imports are treated as skipped (no update/write), and we do not
      // rewrite applied-invoice links.
      if (existing) {
        skipped += 1
        continue
      }

      const data = {
        qboId,
        txnDate: parseQboDate(p?.TxnDate),
        totalAmt: typeof p?.TotalAmt === 'number' ? p.TotalAmt : null,
        customerQboId: typeof p?.CustomerRef?.value === 'string' ? p.CustomerRef.value.trim() : null,
        customerName: typeof p?.CustomerRef?.name === 'string' ? p.CustomerRef.name.trim() : null,
        paymentRefNum: typeof p?.PaymentRefNum === 'string' ? p.PaymentRefNum.trim() : null,
        privateNote: typeof p?.PrivateNote === 'string' ? p.PrivateNote.trim() : null,
        lastUpdatedTime: parseQboDateTime(p?.MetaData?.LastUpdatedTime),
        raw: p,
      }

      let savedId: string
      try {
        const saved = await (prisma as any).quickBooksPaymentImport.create({
          data,
          select: { id: true },
        })
        savedId = saved.id
        created += 1
      } catch (e: any) {
        // If another pull created it concurrently, count as skipped.
        if (e?.code === 'P2002') {
          skipped += 1
          continue
        }
        throw e
      }

      for (const row of appliedMatched) {
        const invoiceImportId = invoiceImportIdByQboId.get(row.invoiceQboId) ?? null
        await (prisma as any).quickBooksPaymentAppliedInvoice.create({
          data: {
            paymentImportId: savedId,
            invoiceQboId: row.invoiceQboId,
            invoiceImportId,
            amount: row.amount,
          },
        })
        appliedLinksCreated += 1
      }
    }

    const preview = all.slice(0, 20).map((p) => ({
      id: p?.Id ?? null,
      txnDate: p?.TxnDate ?? null,
      totalAmt: p?.TotalAmt ?? null,
      paymentRefNum: p?.PaymentRefNum ?? null,
      customerId: p?.CustomerRef?.value ?? null,
      customerName: p?.CustomerRef?.name ?? null,
    }))

    let vitransfer: any = null
    try {
      const merged = await mergeQboPaymentsIntoSalesTables(nativePayments)
      vitransfer = {
        ingestedPayments: merged.ingested,
        skippedPaymentsMissingNativeInvoice: merged.skippedMissingInvoice,
        skippedPaymentsMissingAmount: merged.skippedMissingAmount,
        serverSync: { ok: true, updatedAt: merged.updatedAt },
      }
    } catch (e) {
      vitransfer = {
        ingestedPayments: 0,
        skippedPaymentsMissingNativeInvoice: 0,
        skippedPaymentsMissingAmount: 0,
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
      stored: { created, updated: 0, skipped, skippedUnmatchedInvoice, appliedInvoiceLinks: appliedLinksCreated },
      native: {
        payments: nativePayments,
        omittedMissingAmount: nativeOmittedMissingAmount,
      },
      vitransfer,
      preview,
      note: lookbackDays > 0
        ? `Stored as imports. Payments modified in last ${lookbackDays} days.`
        : 'Stored as imports. Payments (all).',
    })
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (error) {
    console.error('QuickBooks pull payments failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'QuickBooks pull failed' },
      { status: 500 }
    )
  }
}
