import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getTranscriptionQueue } from '@/lib/queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_DICTATION_BYTES = 15 * 1024 * 1024 // ~5 min of opus is well under this
const MAX_DICTATION_BASE64_LENGTH = Math.ceil((MAX_DICTATION_BYTES * 4) / 3) + 4

/**
 * Whisper availability for the assistant page's Dictate button. Kept on this
 * route (assistant-menu gated) because the full settings GET requires the
 * Settings menu, which assistant users may not have.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'assistant')
  if (authResult instanceof Response) return authResult

  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      transcriptionEnabled: true,
      transcriptionProvider: true,
      transcriptionWhisperUrl: true,
      transcriptionOpenaiApiKey: true,
    },
  })
  const configured = (settings?.transcriptionProvider ?? 'LOCAL') === 'OPENAI'
    ? !!settings?.transcriptionOpenaiApiKey
    : !!settings?.transcriptionWhisperUrl
  const available = settings?.transcriptionEnabled === true && configured

  const response = NextResponse.json({ available })
  response.headers.set('Cache-Control', 'no-store')
  return response
}

const BodySchema = z.object({
  audioBase64: z.string().min(1).max(MAX_DICTATION_BASE64_LENGTH),
  mimeType: z.string().regex(/^audio\/(webm|ogg|mp4)$/),
})

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
}

/**
 * Transcribe a dictation clip via Whisper on the worker (the web app cannot
 * reach the NAS). Creates an AiAssistantRequest row (kind: 'dictation') and
 * enqueues it on the transcription queue; the page polls
 * /api/admin/assistant/requests/{id} for resultJson.dictation.text.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'assistant')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many dictations. Please slow down.' },
    'admin-assistant-dictation',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      transcriptionEnabled: true,
      transcriptionProvider: true,
      transcriptionWhisperUrl: true,
      transcriptionOpenaiApiKey: true,
    },
  })
  const configured = (settings?.transcriptionProvider ?? 'LOCAL') === 'OPENAI'
    ? !!settings?.transcriptionOpenaiApiKey
    : !!settings?.transcriptionWhisperUrl
  if (!settings?.transcriptionEnabled || !configured) {
    return NextResponse.json({ error: 'Whisper transcription is not configured' }, { status: 409 })
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid dictation payload' }, { status: 400 })
  }
  const { audioBase64, mimeType } = parsed.data

  const size = Math.floor((audioBase64.length * 3) / 4)
  const row = await prisma.aiAssistantRequest.create({
    data: {
      kind: 'dictation',
      status: 'QUEUED',
      prompt: '(dictation)',
      createdById: authResult.id,
      attachmentsJson: [
        {
          fileName: `dictation.${EXTENSION_BY_MIME[mimeType] ?? 'webm'}`,
          kind: 'audio',
          size,
          mimeType,
          contentBase64: audioBase64,
        },
      ],
    },
    select: { id: true },
  })

  await getTranscriptionQueue().add(
    'dictation',
    { kind: 'dictation', requestId: row.id },
    { jobId: row.id, attempts: 1 }
  )

  return NextResponse.json({ ok: true, id: row.id })
}
