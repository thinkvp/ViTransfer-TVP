import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const GENERIC_DESCRIPTION_TOKENS = new Set([
  'australia',
  'sydney',
  'melbourne',
  'brisbane',
  'perth',
  'adelaide',
  'card',
  'cards',
  'value',
  'date',
  'debit',
  'credit',
  'purchase',
  'payment',
  'merchant',
  'bank',
  'transfer',
  'visa',
  'mastercard',
  'eftpos',
  'pos',
  'pending',
])

function normalizeDescription(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractMeaningfulTokens(value: string) {
  const normalized = normalizeDescription(value)
  if (!normalized) return []

  const uniqueTokens: string[] = []
  const seen = new Set<string>()

  for (const token of normalized.split(' ')) {
    if (!token || seen.has(token)) continue
    if (token.length < 3) continue
    if (!/[a-z]/.test(token)) continue
    if (/^x+\d+$/.test(token)) continue
    if (/^\d+$/.test(token)) continue
    if (GENERIC_DESCRIPTION_TOKENS.has(token)) continue
    seen.add(token)
    uniqueTokens.push(token)
    if (uniqueTokens.length >= 6) break
  }

  return uniqueTokens
}

function scoreDescriptionMatch(targetDescription: string, candidateDescription: string) {
  const targetNormalized = normalizeDescription(targetDescription)
  const candidateNormalized = normalizeDescription(candidateDescription)

  if (!targetNormalized || !candidateNormalized) return 0
  if (targetNormalized === candidateNormalized) return 10_000

  const targetTokens = extractMeaningfulTokens(targetDescription)
  const candidateTokens = new Set(extractMeaningfulTokens(candidateDescription))

  if (targetTokens.length === 0) {
    return candidateNormalized.includes(targetNormalized) || targetNormalized.includes(candidateNormalized)
      ? Math.min(targetNormalized.length, candidateNormalized.length)
      : 0
  }

  let score = 0
  let matchedTokenCount = 0

  for (const [index, token] of targetTokens.entries()) {
    if (!candidateTokens.has(token)) continue
    matchedTokenCount += 1
    score += 12 + Math.min(token.length, 12)
    if (index === 0) score += 10
  }

  if (matchedTokenCount === 0) return 0
  if (matchedTokenCount === targetTokens.length) score += 12
  else if (matchedTokenCount >= 2) score += 6

  const targetPrefix = targetTokens.slice(0, 2).join(' ')
  if (targetPrefix && candidateNormalized.includes(targetPrefix)) {
    score += 10
  }

  return score
}

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
