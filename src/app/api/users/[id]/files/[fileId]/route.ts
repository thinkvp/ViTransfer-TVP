import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getTransferTuningSettings } from '@/lib/settings'
import { deleteFile, getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import fs from 'fs'
import { createReadStream } from 'fs'

export const runtime = 'nodejs'

function isValidMimeType(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(trimmed)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id: userId, fileId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'users')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageUsers')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many download requests. Please slow down.' },
    'user-file-download'
  )
  if (rateLimitResult) return rateLimitResult

  const file = await prisma.userFile.findFirst({
    where: {
      id: fileId,
      userId,
    },
    select: {
      id: true,
      fileName: true,
      fileType: true,
      storagePath: true,
    },
  })

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const fullPath = getFilePath(file.storagePath)
  const stat = await fs.promises.stat(fullPath)
  if (!stat.isFile()) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const sanitizedFilename = sanitizeFilenameForHeader(file.fileName)
  const contentType = isValidMimeType(file.fileType) ? file.fileType : 'application/octet-stream'

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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id: userId, fileId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'users')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageUsers')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    'user-file-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const file = await prisma.userFile.findFirst({
    where: {
      id: fileId,
      userId,
    },
    select: {
      id: true,
      storagePath: true,
    },
  })

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  await prisma.userFile.delete({ where: { id: fileId } })
  try {
    await deleteFile(file.storagePath)
  } catch {
    // Ignore storage delete errors; DB is source of truth.
  }

  return NextResponse.json({ ok: true })
}
