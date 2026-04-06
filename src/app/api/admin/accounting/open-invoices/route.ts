import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { recomputeInvoiceStoredStatus } from '@/lib/sales/server-invoice-status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/accounting/open-invoices
// Returns lightweight invoice data for the invoice-matching dialog in Bank Accounts.
// Falls back to any open/sent/overdue/partially-paid invoices.
export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-open-invoices',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const search = searchParams.get('q')?.trim()

  // Heal step: find PAID invoices with no remaining payment balance and recompute their
  // stored status. This silently fixes invoices that became stuck as PAID after a payment
  // was deleted before the auto-recompute fix was in place. Capped at 10 per call so it
  // never meaningfully delays the response.
  try {
    const stuckInvoices = await prisma.salesInvoice.findMany({
      where: { status: 'PAID' },
      select: {
        id: true,
        _count: { select: { payments: true } },
      },
      take: 10,
    })
    const orphaned = stuckInvoices.filter((inv: any) => inv._count.payments === 0)
    for (const inv of orphaned) {
      await recomputeInvoiceStoredStatus(prisma as any, inv.id, { createdByUserId: authResult.id })
    }
  } catch {
    // Best-effort only — never fail the main query over this
  }

  const rows = await prisma.salesInvoice.findMany({
    where: {
      status: { in: ['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID'] },
      ...(search
        ? {
            OR: [
              { invoiceNumber: { contains: search, mode: 'insensitive' } },
              { client: { name: { contains: search, mode: 'insensitive' } } },
              { project: { title: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: {
      client: { select: { id: true, name: true } },
      project: { select: { id: true, title: true } },
      payments: { where: { excludeFromInvoiceBalance: false }, select: { amountCents: true } },
    },
    orderBy: [{ issueDate: 'desc' }],
    take: 50,
  })

  const invoices = rows.map((r: any) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    status: r.status,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    clientName: r.client?.name ?? null,
    projectTitle: r.project?.title ?? null,
    itemsJson: r.itemsJson,
    taxEnabled: r.taxEnabled,
    totalPaidCents: (r.payments as Array<{ amountCents: number }>).reduce((sum, p) => sum + (p.amountCents ?? 0), 0),
  }))

  const res = NextResponse.json({ invoices })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
