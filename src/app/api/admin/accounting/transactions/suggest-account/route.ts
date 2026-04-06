import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

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

  // Extract significant words (4+ chars) from the description for fuzzy matching
  const words = description
    .split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(w => w.length >= 4)
    .slice(0, 5)

  const whereDescription =
    words.length > 0
      ? { OR: words.map((w: string) => ({ description: { contains: w, mode: 'insensitive' as const } })) }
      : description.length > 0
        ? { description: { contains: description.slice(0, 15), mode: 'insensitive' as const } }
        : {}

  const matched = await prisma.bankTransaction.findMany({
    where: {
      bankAccountId,
      status: 'MATCHED',
      accountId: { not: null },
      ...whereDescription,
    },
    select: { accountId: true },
    orderBy: { date: 'desc' },
    take: 50,
  })

  if (matched.length === 0) {
    return NextResponse.json({ accountId: null })
  }

  // Find the most commonly used accountId
  const counts: Record<string, number> = {}
  for (const t of matched) {
    if (t.accountId) counts[t.accountId] = (counts[t.accountId] ?? 0) + 1
  }
  const topAccountId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  const res = NextResponse.json({ accountId: topAccountId })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
