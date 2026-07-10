import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { getAiAssistantQueue } from '@/lib/queue'
import { isSuspiciousFilename, sanitizeFilename } from '@/lib/file-validation'
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BASE64_LENGTH,
  ALLOWED_ATTACHMENT_EXTENSIONS,
  EXPENSE_ATTACHMENT_EXTENSIONS,
  attachmentKindForFileName,
  attachmentContentLooksValid,
  isReceiptAttachment,
  type AiRequestAttachment,
} from '@/lib/ai/attachments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  // May be empty when attachments carry the brief (e.g. a PDF brief with no extra text)
  prompt: z.string().trim().max(20000).default(''),
  attachments: z
    .array(
      z.object({
        fileName: z.string().min(1).max(255),
        base64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_LENGTH, 'Attachment is too large (10 MB max per file)'),
      })
    )
    .max(MAX_ATTACHMENTS, `At most ${MAX_ATTACHMENTS} attachments`)
    .default([]),
  wantProject: z.boolean().default(true),
  wantSales: z.boolean().default(true),
  wantReply: z.boolean().default(false),
  // Expense (receipt extraction) mode — exclusive of the flags above
  wantExpense: z.boolean().default(false),
  docType: z.enum(['QUOTE', 'INVOICE', 'BOTH']).default('QUOTE'),
  // Refine mode: prior proposal JSON + the change request lives in `prompt`
  refineOf: z.unknown().optional(),
})

// Cap the serialized prior-proposal size on a refine request
const MAX_REFINE_JSON_LENGTH = 200_000

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'assistant')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-assistant-requests-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const rows = await prisma.aiAssistantRequest.findMany({
    where: { kind: 'combined' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      status: true,
      prompt: true,
      provider: true,
      error: true,
      createdAt: true,
      completedAt: true,
    },
  })

  const requests = rows.map((r) => ({
    ...r,
    prompt: r.prompt.length > 160 ? `${r.prompt.slice(0, 160)}…` : r.prompt,
  }))

  const res = NextResponse.json({ requests })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'assistant')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many AI requests. Please slow down.' },
    'admin-assistant-requests-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const input = parsed.data
  const isRefine = input.refineOf != null

  if (input.wantExpense) {
    // Expense mode is accounting territory — the assistant menu alone isn't enough
    const forbidden = requireMenuAccess(authResult, 'accounting', request)
    if (forbidden) return forbidden
    if (input.wantProject || input.wantSales || input.wantReply) {
      return NextResponse.json({ error: "Expense mode can't be combined with other drafts." }, { status: 400 })
    }
  }

  if (!isRefine && !input.wantExpense && !input.wantProject && !input.wantSales && !input.wantReply) {
    return NextResponse.json({ error: 'Select at least one thing to draft (project, quote, invoice or response).' }, { status: 400 })
  }
  if (isRefine) {
    if (!input.prompt) {
      return NextResponse.json({ error: 'Describe the change you want.' }, { status: 400 })
    }
    if (JSON.stringify(input.refineOf).length > MAX_REFINE_JSON_LENGTH) {
      return NextResponse.json({ error: 'The proposal being refined is too large.' }, { status: 400 })
    }
  } else if (input.wantExpense && input.attachments.length === 0) {
    return NextResponse.json({ error: 'Attach at least one receipt (photo or PDF).' }, { status: 400 })
  } else if (!input.prompt && input.attachments.length === 0) {
    return NextResponse.json({ error: 'Provide a brief or attach at least one file.' }, { status: 400 })
  }

  const attachments: AiRequestAttachment[] = []
  for (const raw of input.attachments) {
    if (isSuspiciousFilename(raw.fileName)) {
      return NextResponse.json({ error: `"${raw.fileName}": filename contains suspicious patterns` }, { status: 400 })
    }
    const fileName = sanitizeFilename(raw.fileName)
    const kind = attachmentKindForFileName(fileName)
    if (input.wantExpense) {
      // Receipts only: photos or PDFs
      if (!kind || !isReceiptAttachment(fileName)) {
        return NextResponse.json(
          { error: `"${raw.fileName}": expense mode accepts receipts only. Allowed: ${EXPENSE_ATTACHMENT_EXTENSIONS.join(', ')}` },
          { status: 400 }
        )
      }
    } else if (!kind || kind === 'image') {
      // Images are receipt-only — they have no text-extraction path
      return NextResponse.json(
        { error: `"${raw.fileName}": unsupported type. Allowed: ${ALLOWED_ATTACHMENT_EXTENSIONS.join(', ')}` },
        { status: 400 }
      )
    }
    let bytes: Buffer
    try {
      bytes = Buffer.from(raw.base64, 'base64')
    } catch {
      return NextResponse.json({ error: `"${raw.fileName}" could not be decoded.` }, { status: 400 })
    }
    if (!attachmentContentLooksValid(fileName, bytes)) {
      return NextResponse.json(
        { error: `"${raw.fileName}": file content does not match its extension.` },
        { status: 400 }
      )
    }
    attachments.push({ fileName, kind, size: bytes.length, contentBase64: raw.base64 })
  }

  const row = await prisma.aiAssistantRequest.create({
    data: {
      kind: 'combined',
      status: 'QUEUED',
      prompt: input.prompt,
      attachmentsJson: attachments.length > 0 ? (attachments as unknown as Prisma.InputJsonValue) : undefined,
      contextJson: {
        request: {
          wantProject: input.wantProject,
          wantSales: input.wantSales,
          wantReply: input.wantReply,
          wantExpense: input.wantExpense,
          docType: input.docType,
        },
        ...(isRefine ? { refine: { instruction: input.prompt, of: input.refineOf } } : {}),
      } as unknown as Prisma.InputJsonValue,
      createdById: authResult.id,
    },
    select: { id: true },
  })

  await getAiAssistantQueue().add('ai-assistant-request', { requestId: row.id }, { jobId: row.id })

  return NextResponse.json({ ok: true, id: row.id })
}
