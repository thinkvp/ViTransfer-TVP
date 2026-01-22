import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { downloadFile, deleteFile, initStorage, uploadFile } from '../lib/storage'
import { sanitizeFilename } from '../lib/file-validation'
import { simpleParser, type SimpleParserOptions } from 'mailparser'
import type { ProjectEmailProcessingJob } from '../lib/queue'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'

const DEBUG = process.env.DEBUG_WORKER === 'true'

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

function normalizeContentId(contentId: string | null | undefined): string | null {
  if (!contentId) return null
  const trimmed = contentId.trim()
  if (!trimmed) return null
  return trimmed.replace(/^<|>$/g, '')
}

export async function processProjectEmail(job: Job<ProjectEmailProcessingJob>) {
  const { projectEmailId, projectId, rawStoragePath } = job.data

  if (DEBUG) {
    console.log('[WORKER DEBUG] Processing project email:', JSON.stringify(job.data, null, 2))
  }

  await initStorage()

  // Load record and ensure it belongs to the expected project
  const email = await prisma.projectEmail.findUnique({
    where: { id: projectEmailId },
    include: { attachments: true },
  })

  if (!email || email.projectId !== projectId || email.rawStoragePath !== rawStoragePath) {
    console.error(`[WORKER] ProjectEmail not found/mismatch: ${projectEmailId}`)
    return
  }

  // Idempotency: if already processed, no-op.
  if (email.status === 'READY') {
    return
  }

  // Clean up any existing attachments if we are retrying.
  if (email.attachments.length > 0) {
    for (const a of email.attachments) {
      try {
        await deleteFile(a.storagePath)
      } catch {
        // ignore
      }
    }
    await prisma.projectEmailAttachment.deleteMany({ where: { projectEmailId } })
  }

  try {
    await prisma.projectEmail.update({
      where: { id: projectEmailId },
      data: {
        status: 'PROCESSING',
        errorMessage: null,
        attachmentsCount: 0,
        hasAttachments: false,
      },
    })

    const stream = await downloadFile(rawStoragePath)

    const parseOptions: SimpleParserOptions & { streamAttachments: boolean } = {
      // Keep parsing deterministic and avoid expensive conversions.
      skipTextToHtml: true,
      skipHtmlToText: true,
      streamAttachments: true,
    }

    const parsed = await simpleParser(stream as any, parseOptions)

    const subject = toStringOrNull(parsed.subject)

    const fromValue = parsed.from?.value?.[0]
    const fromName = toStringOrNull(fromValue?.name)
    const fromEmail = toStringOrNull(fromValue?.address)

    const sentAt = parsed.date instanceof Date ? parsed.date : null

    const textBody = typeof parsed.text === 'string' ? parsed.text : null

    let htmlBody: string | null = null
    if (typeof parsed.html === 'string') htmlBody = parsed.html
    else if (Buffer.isBuffer(parsed.html)) htmlBody = parsed.html.toString('utf8')

    const htmlForInlineCheck = htmlBody || ''

    const attachments = Array.isArray((parsed as any).attachments) ? (parsed as any).attachments : []

    const createdAttachments: Array<{
      fileName: string
      fileSize: bigint
      fileType: string
      storagePath: string
      isInline: boolean
      contentId: string | null
    }> = []

    const now = Date.now()

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i]

      const rawName = typeof att.filename === 'string' && att.filename.trim().length > 0
        ? att.filename
        : `attachment-${i + 1}`

      const safeName = sanitizeFilename(rawName)

      const contentType = (typeof att.contentType === 'string' && att.contentType.trim().length > 0)
        ? att.contentType
        : 'application/octet-stream'

      const sizeNum = Number(att.size)
      const size = Number.isFinite(sizeNum) && sizeNum >= 0 ? sizeNum : 0

      // Inline images: consider inline disposition or cid referenced in HTML.
      const cid = normalizeContentId(att.contentId || att.cid)
      const referencedByCid = cid ? (htmlForInlineCheck.includes(`cid:${cid}`) || htmlForInlineCheck.includes(`cid:<${cid}>`)) : false
      const isInline = att.contentDisposition === 'inline' || referencedByCid

      const storagePath = `projects/${projectId}/communication/emails/${projectEmailId}/att-${now}-${i + 1}-${safeName}`

      // When streamAttachments=true, att.content is a stream.
      await uploadFile(storagePath, att.content, size, contentType)

      // Release attachment stream resources (mailparser)
      try {
        att.release?.()
      } catch {
        // ignore
      }

      createdAttachments.push({
        fileName: safeName,
        fileSize: BigInt(size),
        fileType: contentType,
        storagePath,
        isInline,
        contentId: cid,
      })
    }

    if (createdAttachments.length > 0) {
      await prisma.projectEmailAttachment.createMany({
        data: createdAttachments.map((a) => ({
          projectEmailId,
          fileName: a.fileName,
          fileSize: a.fileSize,
          fileType: a.fileType,
          storagePath: a.storagePath,
          isInline: a.isInline,
          contentId: a.contentId,
        })),
      })
    }

    await prisma.projectEmail.update({
      where: { id: projectEmailId },
      data: {
        subject,
        fromName,
        fromEmail,
        sentAt: sentAt ?? email.createdAt,
        textBody,
        htmlBody,
        attachmentsCount: createdAttachments.length,
        hasAttachments: createdAttachments.length > 0,
        status: 'READY',
        errorMessage: null,
      },
    })

    await recalculateAndStoreProjectTotalBytes(projectId)
  } catch (err: any) {
    console.error('[WORKER] Project email processing error:', err)

    await prisma.projectEmail.update({
      where: { id: projectEmailId },
      data: {
        status: 'ERROR',
        errorMessage: err instanceof Error ? err.message : 'Email processing failed',
      },
    })

    throw err
  }
}
