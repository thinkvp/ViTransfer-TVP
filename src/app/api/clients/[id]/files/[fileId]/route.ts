import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getTransferTuningSettings } from '@/lib/settings'
import { deleteFile, getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
// CLIENT_FILE → Client → many Projects — no single project association.
// eslint-disable-next-line no-restricted-imports
import { deleteStoredFile, getStoredFilePath } from '@/lib/stored-file'
import { isS3Mode, s3GetPresignedDownloadUrl } from '@/lib/s3-storage'
import fs from 'fs'
import { createReadStream } from 'fs'

export const runtime = 'nodejs'

function isValidMimeType(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(trimmed)
}

// GET /api/clients/[id]/files/[fileId] - download client file
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id: clientId, fileId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageClientFiles')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many download requests. Please slow down.' },
    'client-file-download'
  )
  if (rateLimitResult) return rateLimitResult

  const file = await prisma.clientFile.findFirst({
    where: {
      id: fileId,
      clientId,
      client: { deletedAt: null },
    },
    select: {
      id: true,
      fileName: true,
      fileType: true,
    },
  })

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  // Get storage path from StoredFile
  const { getStoredFilePath } = await import('@/lib/stored-file')
  const storagePath = await getStoredFilePath('CLIENT_FILE', fileId, 'ORIGINAL')
  if (!storagePath) return NextResponse.json({ error: 'File not found' }, { status: 404 })

  const sanitizedFilename = sanitizeFilenameForHeader(file.fileName)
  const contentType = isValidMimeType(file.fileType) ? file.fileType : 'application/octet-stream'

  if (isS3Mode()) {
    const presignedUrl = await s3GetPresignedDownloadUrl(storagePath, 300, file.fileName, contentType)
    return NextResponse.redirect(presignedUrl, { status: 302, headers: { 'Cache-Control': 'no-store' } })
  }

  const fullPath = getFilePath(storagePath)
  const stat = await fs.promises.stat(fullPath)
  if (!stat.isFile()) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const { downloadChunkSizeBytes } = await getTransferTuningSettings()
  const fileStream = createReadStream(fullPath, { highWaterMark: downloadChunkSizeBytes })
  let closed = false
  const readableStream = new ReadableStream({
    start(controller) {
      fileStream.on('data', (chunk) => {
        if (!closed) controller.enqueue(chunk)
      })
      fileStream.on('end', () => {
        if (!closed) { closed = true; controller.close() }
      })
      fileStream.on('error', (err) => {
        if (!closed) { closed = true; controller.error(err) }
      })
    },
    cancel() {
      closed = true
      fileStream.destroy()
    },
  })

  return new NextResponse(readableStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${sanitizedFilename}"`,
      'Content-Length': stat.size.toString(),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
    },
  })
}

// DELETE /api/clients/[id]/files/[fileId] - delete client file
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id: clientId, fileId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageClientFiles')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    'client-file-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const file = await prisma.clientFile.findFirst({
    where: {
      id: fileId,
      clientId,
      client: { deletedAt: null },
    },
    select: {
      id: true,
    },
  })

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const storagePath = await getStoredFilePath('CLIENT_FILE', fileId, 'ORIGINAL')
  await prisma.clientFile.delete({ where: { id: fileId } })
  try {
    if (storagePath) await deleteFile(storagePath)
  } catch {
    // Ignore storage delete errors; DB is source of truth.
  }
  await deleteStoredFile('CLIENT_FILE', fileId, 'ORIGINAL').catch(() => {})

  return NextResponse.json({ ok: true })
}
