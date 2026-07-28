import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { parseCSV } from '@/lib/accounting/csv-parser'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CSV_BYTES = 5 * 1024 * 1024

const bodySchema = z.object({
  bankAccountId: z.string().trim().min(1),
})

// POST /api/admin/accounting/transactions/import/preview
// Parses a CSV and returns rows with isDuplicate flags — does NOT insert anything.
export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 20, message: 'Too many preview requests. Please slow down.' },
    'admin-accounting-import-preview',
    authResult.id
  )
  if (rl) return rl

  const formData = await request.formData()
  const bankAccountId = (formData.get('bankAccountId') as string | null)?.trim()
  const file = formData.get('file') as File | null

  const bodyParsed = bodySchema.safeParse({ bankAccountId })
  if (!bodyParsed.success) {
    return NextResponse.json({ error: 'bankAccountId is required' }, { status: 400 })
  }

  if (!file) {
    return NextResponse.json({ error: 'No CSV file provided' }, { status: 400 })
  }

  if (file.size > MAX_CSV_BYTES) {
    return NextResponse.json({ error: 'CSV file too large (max 5MB)' }, { status: 413 })
  }

  const bankAccount = await prisma.bankAccount.findUnique({ where: { id: bankAccountId! } })
  if (!bankAccount) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
  }

  const csvText = await file.text()
  const parseResult = parseCSV(csvText)

  if (parseResult.transactions.length === 0) {
    return NextResponse.json({ error: 'No valid transactions found in CSV file' }, { status: 400 })
  }

  // Load existing transactions to check duplicates. A duplicate requires an exact
  // date match, so scoping the query to the file's date range is lossless.
  const importDates = parseResult.transactions.map(t => t.date).sort()
  const existingTxns = await prisma.bankTransaction.findMany({
    where: {
      bankAccountId: bankAccountId!,
      date: { gte: importDates[0], lte: importDates[importDates.length - 1] },
    },
    select: { date: true, amountCents: true, description: true },
  })

  const keyOf = (t: { date: string; amountCents: number; description: string }) =>
    `${t.date}|${t.amountCents}|${t.description.trim().toLowerCase()}`

  const existingSet = new Set(existingTxns.map(keyOf))

  // Count how often each key appears in the file itself. Repeated rows are NOT
  // duplicates — a statement legitimately lists two identical purchases on the
  // same day — so they stay selected and are only surfaced as a note.
  const batchCounts = new Map<string, number>()
  for (const t of parseResult.transactions) {
    const key = keyOf(t)
    batchCounts.set(key, (batchCounts.get(key) ?? 0) + 1)
  }

  const rows = parseResult.transactions.map((t, index) => {
    const key = keyOf(t)
    return {
      index,
      date: t.date,
      description: t.description,
      reference: t.reference,
      amountCents: t.amountCents,
      // Already present in this bank account — deselected by default.
      isDuplicate: existingSet.has(key),
      // Appears more than once in this file — informational only.
      isRepeat: (batchCounts.get(key) ?? 0) > 1,
    }
  })

  const res = NextResponse.json({
    rows,
    format: parseResult.format,
    skipped: parseResult.skipped,
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
