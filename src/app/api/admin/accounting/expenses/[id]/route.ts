import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { expenseFromDb } from '@/lib/accounting/db-mappers'
import { deleteAccountingFile, moveAccountingFile } from '@/lib/accounting/file-storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  supplierName: z.string().trim().max(300).optional().nullable(),
  description: z.string().trim().min(1).max(5000).optional(),
  accountId: z.string().trim().min(1).optional(),
  taxCode: z.enum(['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED']).optional(),
  amountIncGst: z.number().positive().describe('Amount including GST in dollars').optional(),
  notes: z.string().trim().max(5000).optional().nullable(),
  status: z.enum(['DRAFT', 'APPROVED', 'RECONCILED']).optional(),
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-expense-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const expense = await prisma.expense.findUnique({
    where: { id },
    include: {
      account: true,
      user: { select: { id: true, name: true, email: true } },
      accountingAttachments: { orderBy: { uploadedAt: 'asc' } },
    },
  })

  if (!expense) {
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
  }

  const res = NextResponse.json({ expense: expenseFromDb(expense) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-expense-put',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.expense.findUnique({
    where: { id },
    include: {
      accountingAttachments: { select: { id: true, storagePath: true, originalName: true } },
    },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data

  // Reconciled expenses: date and amount are immutable
  const isReconciled = existing.status === 'RECONCILED'
  if (isReconciled) {
    if (data.date !== undefined && data.date !== existing.date) {
      return NextResponse.json({ error: 'Cannot change the date of a reconciled expense' }, { status: 400 })
    }
    if (data.amountIncGst !== undefined) {
      return NextResponse.json({ error: 'Cannot change the amount of a reconciled expense' }, { status: 400 })
    }
  }

  if (data.accountId) {
    const account = await prisma.account.findUnique({ where: { id: data.accountId } })
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }
    if (!['EXPENSE', 'COGS'].includes(account.type)) {
      return NextResponse.json({ error: 'Account must be of type EXPENSE or COGS' }, { status: 400 })
    }
  }

  const updated = await prisma.expense.update({
    where: { id },
    data: {
      ...(data.date !== undefined ? { date: data.date } : {}),
      ...(data.supplierName !== undefined ? { supplierName: data.supplierName ?? null } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.accountId !== undefined ? { accountId: data.accountId } : {}),
      ...(data.taxCode !== undefined ? { taxCode: data.taxCode } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      // Recalculate GST split if taxCode changed (amount stays fixed for reconciled)
      ...((data.amountIncGst !== undefined || data.taxCode !== undefined) ? await (async () => {
        const resolvedTaxCode = data.taxCode ?? existing.taxCode
        const amountIncGstCents = data.amountIncGst !== undefined ? Math.round(data.amountIncGst * 100) : existing.amountIncGst
        let gstAmountCents = 0
        if (resolvedTaxCode === 'GST') {
          const settings = await prisma.salesSettings.findUnique({ where: { id: 'default' }, select: { taxRatePercent: true } })
          const taxRate = (settings?.taxRatePercent ?? 10) / 100
          gstAmountCents = Math.round(amountIncGstCents * taxRate / (1 + taxRate))
        }
        const amountExGstCents = amountIncGstCents - gstAmountCents
        return { amountIncGst: amountIncGstCents, gstAmount: gstAmountCents, amountExGst: amountExGstCents }
      })() : {}),
    },
    include: { account: true, user: { select: { id: true, name: true, email: true } } },
  })

  const accountChanged = data.accountId !== undefined && data.accountId !== existing.accountId
  const taxCodeChanged = data.taxCode !== undefined && data.taxCode !== existing.taxCode

  // Move expense attachments to the new account folder when account changes
  if (accountChanged && existing.accountingAttachments.length > 0) {
    for (const attachment of existing.accountingAttachments) {
      try {
        const newPath = await moveAccountingFile(
          attachment.storagePath,
          existing.date as string,
          data.accountId!,
          attachment.originalName,
        )
        if (newPath !== attachment.storagePath) {
          await prisma.accountingAttachment.update({
            where: { id: attachment.id },
            data: { storagePath: newPath },
          })
        }
      } catch {
        // Non-fatal — file may already be in right place or missing
      }
    }
  }

  // Sync account and/or taxCode to the linked bank transaction
  if ((accountChanged || taxCodeChanged) && existing.bankTransactionId) {
    await prisma.bankTransaction.update({
      where: { id: existing.bankTransactionId },
      data: {
        ...(accountChanged ? { accountId: data.accountId } : {}),
        ...(taxCodeChanged ? { taxCode: data.taxCode } : {}),
      },
    })
  }

  const res = NextResponse.json({ expense: expenseFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-expense-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.expense.findUnique({
    where: { id },
    select: {
      id: true,
      bankTransactionId: true,
      accountingAttachments: { select: { storagePath: true } },
    },
  })

  if (!existing) {
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
  }

  if (existing.bankTransactionId) {
    return NextResponse.json(
      { error: 'Cannot delete expense — it is matched to a bank transaction. Unmatch it first.' },
      { status: 409 }
    )
  }

  // Delete all attachment files from disk before removing the DB record (CASCADE handles DB rows)
  const filesToDelete = [
    ...existing.accountingAttachments.map(a => a.storagePath),
  ]
  await Promise.all(filesToDelete.map(p => deleteAccountingFile(p).catch(() => {})))

  await prisma.expense.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
