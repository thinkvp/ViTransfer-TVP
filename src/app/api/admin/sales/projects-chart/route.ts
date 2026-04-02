import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import type { SalesLineItem } from '@/lib/sales/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-projects-chart-get',
    authResult.id,
  )
  if (rateLimitResult) return rateLimitResult

  const projects = await prisma.project.findMany({
    where: { status: 'CLOSED' },
    select: {
      id: true,
      startDate: true,
      createdAt: true,
      clientId: true,
      client: {
        select: { name: true },
      },
      salesInvoices: {
        select: {
          itemsJson: true,
          taxEnabled: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const result = projects.map((p) => {
    const totalInvoicedCents = p.salesInvoices.reduce((projectAcc, inv) => {
      const items = (inv.itemsJson ?? []) as SalesLineItem[]
      const subtotal = items.reduce((s, item) => {
        const qty = Number.isFinite(item.quantity) ? item.quantity : 0
        const unit = Number.isFinite(item.unitPriceCents) ? item.unitPriceCents : 0
        return s + Math.round(qty * unit)
      }, 0)
      const tax = inv.taxEnabled
        ? items.reduce((s, item) => {
            const qty = Number.isFinite(item.quantity) ? item.quantity : 0
            const unit = Number.isFinite(item.unitPriceCents) ? item.unitPriceCents : 0
            const rate = Number.isFinite(item.taxRatePercent) ? item.taxRatePercent : 0
            const lineSubtotal = Math.round(qty * unit)
            return s + Math.round(lineSubtotal * (rate / 100))
          }, 0)
        : 0
      return projectAcc + subtotal + tax
    }, 0)

    return {
      id: p.id,
      startDate: p.startDate ?? p.createdAt.toISOString().slice(0, 10),
      totalInvoicedCents,
      clientId: p.clientId ?? null,
      clientName: p.client?.name ?? null,
    }
  })

  return NextResponse.json({ projects: result })
}
