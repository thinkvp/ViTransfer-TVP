import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenuAction } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAX_CODES = ['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED'] as const

const splitLineSchema = z.object({
  accountId: z.string().min(1),
  description: z.string().trim().max(2000).optional().default(''),
  amountCents: z.number().int(),
  taxCode: z.enum(TAX_CODES).default('BAS_EXCLUDED'),
})

const splitSchema = z.object({
  lines: z.array(splitLineSchema).min(2, 'At least 2 split lines required'),
})

const editSplitSchema = splitSchema.extend({
  confirmLodgedPeriod: z.boolean().optional(),
})

type SplitLineInput = z.infer<typeof splitLineSchema>

// Shared by posting and editing a split. Returns an error response, or null when valid.
async function validateSplitLines(lines: SplitLineInput[], txnAmountCents: number, ownCoaAccountId: string | null): Promise<NextResponse | null> {
  // Verify lines sum to the transaction amount
  const lineSum = lines.reduce((sum, l) => sum + l.amountCents, 0)
  if (lineSum !== txnAmountCents) {
    return NextResponse.json({
      error: `Split lines must sum to the transaction amount. Expected ${txnAmountCents}, got ${lineSum}.`,
    }, { status: 400 })
  }

  // Verify all accounts exist
  const accountIds = [...new Set(lines.map(l => l.accountId))]
  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true },
  })
  if (accounts.length !== accountIds.length) {
    return NextResponse.json({ error: 'One or more accounts not found' }, { status: 400 })
  }

  // Split lines cannot post back to the bank account's own Chart of Accounts account —
  // the balance already counts the transaction as raw cash, so this would double it.
  if (ownCoaAccountId && accountIds.includes(ownCoaAccountId)) {
    return NextResponse.json(
      { error: "A split line cannot use this bank account's own Chart of Accounts account. Choose the accounts the money moved to or from." },
      { status: 400 }
    )
  }

  return null
}

// Order-independent fingerprint of what a split posts (account, amount, GST code per line);
// descriptions don't affect the books, so they don't count as a change.
function splitPostingKey(lines: Array<{ accountId: string; amountCents: number; taxCode: string }>): string {
  return lines.map(l => `${l.accountId}|${l.amountCents}|${l.taxCode}`).sort().join(';')
}

const splitResponseInclude = {
  bankAccount: { select: { id: true, name: true } },
  expense: { include: { account: true } },
  account: true,
  invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true } },
  splitLines: { include: { account: true } },
  accountingAttachments: { orderBy: { uploadedAt: 'asc' } },
} as const

// POST /api/admin/accounting/transactions/[id]/split
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenuAction(request, 'accounting', 'manageAccounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transaction-split',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params

  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      bankAccount: { select: { id: true, name: true, coaAccountId: true } },
      expense: { include: { account: true } },
      account: true,
      invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true } },
      splitLines: { include: { account: true } },
    },
  })

  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (txn.status === 'MATCHED') return NextResponse.json({ error: 'Transaction is already posted' }, { status: 409 })
  const ownCoaAccountId = (txn.bankAccount as unknown as { coaAccountId?: string | null } | null)?.coaAccountId ?? null

  const body = await request.json().catch(() => null)
  const parsed = splitSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })

  const { lines } = parsed.data

  const invalid = await validateSplitLines(lines, txn.amountCents, ownCoaAccountId)
  if (invalid) return invalid

  await prisma.$transaction(async (tx) => {
    // Create split lines
    for (const line of lines) {
      await tx.splitLine.create({
        data: {
          bankTransactionId: id,
          accountId: line.accountId,
          description: line.description || '',
          amountCents: line.amountCents,
          taxCode: line.taxCode,
        },
      })
    }

    // Mark transaction as MATCHED with SPLIT type
    await tx.bankTransaction.update({
      where: { id },
      data: {
        status: 'MATCHED',
        matchType: 'SPLIT',
        transactionType: txn.amountCents < 0 ? 'Expense' : 'Deposit',
      },
    })
  })

  // Reload and return
  const updated = await prisma.bankTransaction.findUnique({ where: { id }, include: splitResponseInclude })

  const res = NextResponse.json({ transaction: bankTransactionFromDb(updated!) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// PUT /api/admin/accounting/transactions/[id]/split
// Replaces the lines of an already-posted split in place, so a correction doesn't need
// Undo + re-split (which also deletes the transaction's attachments).
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenuAction(request, 'accounting', 'manageAccounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transaction-split-edit',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params

  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      bankAccount: { select: { coaAccountId: true } },
      splitLines: { select: { accountId: true, amountCents: true, taxCode: true } },
    },
  })

  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (txn.status !== 'MATCHED' || txn.matchType !== 'SPLIT') {
    return NextResponse.json({ error: 'Only posted split transactions can be edited here' }, { status: 409 })
  }

  const body = await request.json().catch(() => null)
  const parsed = editSplitSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })

  const { lines, confirmLodgedPeriod } = parsed.data

  const invalid = await validateSplitLines(lines, txn.amountCents, txn.bankAccount?.coaAccountId ?? null)
  if (invalid) return invalid

  // Changing what a split posts inside a lodged BAS quarter alters figures already
  // reported to the ATO. Allowed, but only once the user confirms.
  if (!confirmLodgedPeriod && splitPostingKey(lines) !== splitPostingKey(txn.splitLines)) {
    const lodged = await prisma.basPeriod.findFirst({
      where: { status: 'LODGED', startDate: { lte: txn.date }, endDate: { gte: txn.date } },
      select: { label: true, quarter: true, financialYear: true },
    })
    if (lodged) {
      return NextResponse.json({
        error: `This transaction falls in a lodged BAS period (${lodged.label || `Q${lodged.quarter} ${lodged.financialYear}`}). Changing its split will alter lodged figures.`,
        code: 'LODGED_BAS_PERIOD',
      }, { status: 409 })
    }
  }

  await prisma.$transaction([
    prisma.splitLine.deleteMany({ where: { bankTransactionId: id } }),
    prisma.splitLine.createMany({
      data: lines.map(line => ({
        bankTransactionId: id,
        accountId: line.accountId,
        description: line.description || '',
        amountCents: line.amountCents,
        taxCode: line.taxCode,
      })),
    }),
  ])

  const updated = await prisma.bankTransaction.findUnique({ where: { id }, include: splitResponseInclude })

  const res = NextResponse.json({ transaction: bankTransactionFromDb(updated!) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
