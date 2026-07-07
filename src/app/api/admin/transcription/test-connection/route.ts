import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getTranscriptionQueue } from '@/lib/queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Whisper connection tests run through the worker queue — the web app (VPS)
 * has no network path to the Whisper server on the NAS, and this also
 * exercises the actual call path. The UI polls
 * /api/admin/assistant/requests/{id} for the result (same row shape as the
 * AI assistant connection test).
 *
 * Gated on the 'assistant' menu (not 'settings') so the poll route — which
 * requires 'assistant' — is guaranteed to be accessible to whoever can start
 * a test.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'assistant')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many requests. Please slow down.' },
    'admin-transcription-test-connection',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const row = await prisma.aiAssistantRequest.create({
    data: {
      kind: 'whisper_connection_test',
      status: 'QUEUED',
      prompt: '(whisper connection test)',
      createdById: authResult.id,
    },
    select: { id: true },
  })

  await getTranscriptionQueue().add(
    'whisper-test',
    { kind: 'whisper-test', requestId: row.id },
    { jobId: row.id, attempts: 1 }
  )

  return NextResponse.json({ ok: true, id: row.id })
}
