import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { normalizeDescription, scoreDescriptionMatch } from '@/lib/accounting/description-match'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 300, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transactions-suggest-account',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const bankAccountId = url.searchParams.get('bankAccountId')
  const description = url.searchParams.get('description') ?? ''

  if (!bankAccountId) {
    return NextResponse.json({ accountId: null })
  }

  const normalizedDescription = normalizeDescription(description)
  if (!normalizedDescription) {
    return NextResponse.json({ accountId: null })
  }

  const matched = await prisma.bankTransaction.findMany({
    where: {
      bankAccountId,
      status: 'MATCHED',
      OR: [
        { accountId: { not: null } },
        { expense: { isNot: null } },
      ],
    },
    select: {
      date: true,
      description: true,
      accountId: true,
      expense: { select: { accountId: true } },
    },
    orderBy: [{ date: 'desc' }, { updatedAt: 'desc' }],
    take: 250,
  })

  if (matched.length === 0) {
    return NextResponse.json({ accountId: null })
  }

  const accountScores = new Map<string, { score: number; matches: number; latestDate: string }>()
  for (const t of matched) {
    const accountId = t.expense?.accountId ?? t.accountId
    if (!accountId) continue

    const score = scoreDescriptionMatch(description, t.description)
    if (score <= 0) continue

    const existing = accountScores.get(accountId)
    if (existing) {
      existing.score += score
      existing.matches += 1
      if (t.date > existing.latestDate) existing.latestDate = t.date
    } else {
      accountScores.set(accountId, { score, matches: 1, latestDate: t.date })
    }
  }

  const topAccountId = [...accountScores.entries()]
    .sort((left, right) => {
      const byScore = right[1].score - left[1].score
      if (byScore !== 0) return byScore
      const byMatches = right[1].matches - left[1].matches
      if (byMatches !== 0) return byMatches
      return right[1].latestDate.localeCompare(left[1].latestDate)
    })[0]?.[0] ?? null

  const res = NextResponse.json({ accountId: topAccountId })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
