import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAnyMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/lookups — minimal client/project directory for name resolution.
 *
 * Sales and Accounting store clients and projects by id, so without a way to
 * resolve those ids the UI (and generated PDFs) fall back to showing raw cuids.
 * The Clients and Projects list endpoints require their own menus, which a
 * finance-only role (e.g. an accountant) does not have.
 *
 * This returns only what is needed to label a document — client name/address as
 * printed on invoices, and project titles. Deliberately excludes notes,
 * recipients, contact details and every other client/project field.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAnyMenu(request, ['clients', 'projects', 'sales', 'accounting'])
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-lookups-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const [clients, projects] = await Promise.all([
    prisma.client.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, address: true },
      orderBy: { name: 'asc' },
    }),
    prisma.project.findMany({
      select: { id: true, title: true, clientId: true, startDate: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  const res = NextResponse.json({
    clients,
    projects: projects.map((p) => ({
      id: p.id,
      title: p.title,
      clientId: p.clientId,
      startDate: p.startDate,
      createdAt: p.createdAt,
    })),
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
