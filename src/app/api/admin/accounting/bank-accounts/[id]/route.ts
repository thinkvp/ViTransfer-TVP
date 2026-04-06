import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankAccountFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  bsb: z.string().trim().regex(/^\d{3}-?\d{3}$/, 'BSB must be 6 digits').optional().nullable(),
  accountNumber: z.string().trim().min(1).max(50).optional(),
  bankName: z.string().trim().max(100).optional().nullable(),
  currency: z.string().trim().length(3).optional(),
  openingBalance: z.number().min(0).optional(),
  openingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  isActive: z.boolean().optional(),
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bank-account-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const account = await prisma.bankAccount.findUnique({
    where: { id },
    include: { _count: { select: { transactions: true } } },
  })

  if (!account) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
  }

  const res = NextResponse.json({ bankAccount: bankAccountFromDb(account) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bank-account-put',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.bankAccount.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data

  const updated = await prisma.bankAccount.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.bsb !== undefined ? { bsb: data.bsb } : {}),
      ...(data.accountNumber !== undefined ? { accountNumber: data.accountNumber } : {}),
      ...(data.bankName !== undefined ? { bankName: data.bankName } : {}),
      ...(data.currency !== undefined ? { currency: data.currency } : {}),
      ...(data.openingBalance !== undefined ? { openingBalance: Math.round(data.openingBalance * 100) } : {}),
      ...(data.openingBalanceDate !== undefined ? { openingBalanceDate: data.openingBalanceDate } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
    include: { _count: { select: { transactions: true } } },
  })

  const res = NextResponse.json({ bankAccount: bankAccountFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bank-account-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.bankAccount.findUnique({
    where: { id },
    include: { _count: { select: { transactions: true } } },
  })

  if (!existing) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
  }

  if (existing._count.transactions > 0) {
    return NextResponse.json(
      { error: 'Cannot delete bank account — it has imported transactions. Deactivate it instead.' },
      { status: 409 }
    )
  }

  await prisma.bankAccount.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
