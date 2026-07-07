import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getAiAssistantQueue } from '@/lib/queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Connection tests run through the worker queue like real requests — the web app
 * (VPS) has no network path to Ollama on the NAS, and this also exercises the
 * actual call path. The UI polls /api/admin/assistant/requests/{id} for the result.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'assistant')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many requests. Please slow down.' },
    'admin-assistant-test-connection',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const row = await prisma.aiAssistantRequest.create({
    data: {
      kind: 'connection_test',
      status: 'QUEUED',
      prompt: '(connection test)',
      createdById: authResult.id,
    },
    select: { id: true },
  })

  await getAiAssistantQueue().add('ai-assistant-connection-test', { requestId: row.id }, { jobId: row.id })

  return NextResponse.json({ ok: true, id: row.id })
}
