import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { accountFromDb } from '@/lib/accounting/db-mappers'
import { migrateAccountFolderFiles } from '@/lib/accounting/file-storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  code: z.string().trim().min(1).max(20).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COGS', 'EXPENSE']).optional(),
  subType: z.string().trim().max(100).optional().nullable(),
  taxCode: z.enum(['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED']).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  isActive: z.boolean().optional(),
  parentId: z.string().trim().max(100).optional().nullable(),
  sortOrder: z.number().int().min(0).max(99999).optional(),
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-account-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  // Resolve by id or by account code
  const account = await prisma.account.findFirst({
    where: { OR: [{ id }, { code: id }] },
    include: { children: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
  })

  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  const res = NextResponse.json({ account: accountFromDb(account) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-account-put',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.account.findFirst({
    where: { OR: [{ id }, { code: id }] },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data

  // Check code uniqueness if changing code
  if (data.code && data.code !== existing.code) {
    const codeClash = await prisma.account.findUnique({ where: { code: data.code } })
    if (codeClash) {
      return NextResponse.json({ error: 'Account code already in use' }, { status: 409 })
    }
  }

  // Prevent changing type or code on system accounts
  if (existing.isSystem) {
    if (data.code !== undefined && data.code !== existing.code) {
      return NextResponse.json({ error: 'Cannot change the code of a system account' }, { status: 409 })
    }
    if (data.type !== undefined && data.type !== existing.type) {
      return NextResponse.json({ error: 'Cannot change the type of a system account' }, { status: 409 })
    }
  }

  const updated = await prisma.account.update({
    where: { id: existing.id },
    data: {
      ...(data.code !== undefined ? { code: data.code } : {}),
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.type !== undefined ? { type: data.type } : {}),
      ...(data.subType !== undefined ? { subType: data.subType } : {}),
      ...(data.taxCode !== undefined ? { taxCode: data.taxCode } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      ...(data.parentId !== undefined ? { parentId: data.parentId } : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
    },
  })

  // If the name changed, move existing receipt files into the new folder.
  // The DB update has already committed so getAccountFolderSegments will use the new name.
  if (data.name !== undefined && data.name !== existing.name) {
    // Migrate files for this account
    await migrateAccountFolderFiles(existing.id)

    // Migrate files for all direct children — their folder path includes this account's name as the parent segment
    const children = await prisma.account.findMany({
      where: { parentId: existing.id },
      select: { id: true },
    })
    for (const child of children) {
      await migrateAccountFolderFiles(child.id)
    }
  }

  const res = NextResponse.json({ account: accountFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-account-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.account.findFirst({
    where: { OR: [{ id }, { code: id }] },
    include: { _count: { select: { expenses: true, children: true } } },
  })

  if (!existing) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  if (existing.isSystem) {
    return NextResponse.json({ error: 'System accounts cannot be deleted' }, { status: 409 })
  }

  if (existing._count.expenses > 0) {
    return NextResponse.json(
      { error: `Cannot delete account — it has ${existing._count.expenses} linked expense(s)` },
      { status: 409 }
    )
  }

  if (existing._count.children > 0) {
    return NextResponse.json(
      { error: 'Cannot delete account — it has sub-accounts. Delete or reassign them first.' },
      { status: 409 }
    )
  }

  await prisma.account.delete({ where: { id: existing.id } })

  return NextResponse.json({ ok: true })
}
