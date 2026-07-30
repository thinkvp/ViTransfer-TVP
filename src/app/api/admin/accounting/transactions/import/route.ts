import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenuAction } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { parseCSV, deduplicateTransactions } from '@/lib/accounting/csv-parser'
import { bankImportBatchFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CSV_BYTES = 5 * 1024 * 1024 // 5MB

const bodySchema = z.object({
  bankAccountId: z.string().trim().min(1),
})

// POST /api/admin/accounting/transactions/import
// Accepts multipart/form-data: bankAccountId (field) + file (CSV file)
export async function POST(request: NextRequest) {
  const authResult = await requireApiMenuAction(request, 'accounting', 'manageAccounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many import requests. Please slow down.' },
    'admin-accounting-import',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

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
  if (!bankAccount.isActive) {
    return NextResponse.json({ error: 'Bank account is inactive' }, { status: 400 })
  }

  const csvText = await file.text()
  const parseResult = parseCSV(csvText)

  if (parseResult.transactions.length === 0) {
    return NextResponse.json({ error: 'No valid transactions found in CSV file' }, { status: 400 })
  }

  // Optional: caller may pass selectedIndices (JSON array) to restrict which rows to import
  const selectedIndicesRaw = formData.get('selectedIndices') as string | null
  let selectedSet: Set<number> | null = null
  if (selectedIndicesRaw) {
    try {
      const parsed = JSON.parse(selectedIndicesRaw)
      if (Array.isArray(parsed)) selectedSet = new Set(parsed.map(Number))
    } catch { /* ignore, treat as import all */ }
  }

  // If selectedSet provided, filter to those indices only
  const candidateTransactions = selectedSet
    ? parseResult.transactions.filter((_, i) => selectedSet!.has(i))
    : parseResult.transactions

  if (candidateTransactions.length === 0) {
    return NextResponse.json({ error: 'No transactions selected for import' }, { status: 400 })
  }

  // When the caller passed an explicit selection it came from the preview step, where
  // suspected duplicates are shown and deselected by default. Re-ticking a flagged row
  // is a deliberate decision, so import exactly what was selected. Auto-deduplication
  // only applies to the import-everything path, which has had no such review.
  let toInsert = candidateTransactions
  let duplicates = 0

  if (!selectedSet) {
    // Scope to the date range of the import +/- 7 days to avoid loading the entire table
    const importDates = candidateTransactions.map(t => t.date).sort()
    const minDate = importDates[0]
    const maxDate = importDates[importDates.length - 1]
    const pad = (d: string, days: number) => {
      const dt = new Date(d)
      dt.setDate(dt.getDate() + days)
      return dt.toISOString().split('T')[0]
    }
    const existingTxns = await prisma.bankTransaction.findMany({
      where: {
        bankAccountId: bankAccountId!,
        date: { gte: pad(minDate, -7), lte: pad(maxDate, 7) },
      },
      select: { date: true, amountCents: true, description: true },
    })

    const result = deduplicateTransactions(candidateTransactions, existingTxns)
    toInsert = result.toInsert
    duplicates = result.duplicates
  }

  // Rows the user left unticked in the preview — not duplicates, not parse failures
  const deselected = parseResult.transactions.length - candidateTransactions.length

  // Create batch + insert transactions in a transaction
  const batch = await prisma.$transaction(async (tx) => {
    const importBatch = await tx.bankImportBatch.create({
      data: {
        bankAccountId: bankAccountId!,
        fileName: file.name,
        rowCount: toInsert.length,
        matchedCount: 0,
        skippedCount: duplicates + parseResult.skipped + deselected,
        importedById: authResult.id,
        importedByName: authResult.name ?? authResult.email ?? null,
      },
    })

    if (toInsert.length > 0) {
      await tx.bankTransaction.createMany({
        data: toInsert.map(t => ({
          bankAccountId: bankAccountId!,
          importBatchId: importBatch.id,
          date: t.date,
          description: t.description,
          reference: t.reference,
          amountCents: t.amountCents,
          rawCsv: t.rawRow,
          status: 'UNMATCHED',
        })),
      })
    }

    return importBatch
  })

  const res = NextResponse.json({
    batch: bankImportBatchFromDb(batch),
    inserted: toInsert.length,
    duplicates,
    deselected,
    skipped: parseResult.skipped,
    format: parseResult.format,
  }, { status: 201 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
