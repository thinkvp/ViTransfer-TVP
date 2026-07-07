import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'assistant')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    // Generous: the UI polls this every ~2.5s while a request is running
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-assistant-request-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await ctx.params
  const row = await prisma.aiAssistantRequest.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      status: true,
      resultJson: true,
      error: true,
      provider: true,
      createdAt: true,
      completedAt: true,
    },
  })
  if (!row) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 })
  }

  const res = NextResponse.json({ request: row })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
