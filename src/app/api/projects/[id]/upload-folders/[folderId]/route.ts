import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { authorizeUploadFolders } from '@/lib/project-upload-folders-admin'
import {
  renameUploadFolder,
  deleteUploadFolderTree,
} from '@/lib/share-upload-folder-storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadFolder(projectId: string, folderId: string) {
  return prisma.shareUploadFolder.findFirst({
    where: { id: folderId, projectId },
    select: { id: true, relativePath: true },
  })
}

// PATCH /api/projects/[id]/upload-folders/[folderId] - rename a folder (admin)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; folderId: string }> },
) {
  const { id: projectId, folderId } = await params

  const gate = await authorizeUploadFolders(request, projectId)
  if (gate.response) return gate.response

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'project-upload-folders-rename',
  )
  if (rateLimitResult) return rateLimitResult

  const folder = await loadFolder(projectId, folderId)
  if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 })

  const body = await request.json().catch(() => null)
  const result = await renameUploadFolder({
    projectId,
    folderPath: folder.relativePath,
    folderName: String(body?.folderName || ''),
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error || 'Failed to rename folder' }, { status: result.status || 500 })
  }

  return NextResponse.json({ success: true, folderPath: result.nextFolderPath })
}

// DELETE /api/projects/[id]/upload-folders/[folderId] - delete a folder + contents (admin)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; folderId: string }> },
) {
  const { id: projectId, folderId } = await params

  const gate = await authorizeUploadFolders(request, projectId)
  if (gate.response) return gate.response

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    'project-upload-folders-delete',
  )
  if (rateLimitResult) return rateLimitResult

  const folder = await loadFolder(projectId, folderId)
  if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 })

  const result = await deleteUploadFolderTree({ projectId, folderPath: folder.relativePath })
  if (!result.ok) {
    return NextResponse.json({ error: result.error || 'Failed to delete folder' }, { status: result.status || 500 })
  }

  return NextResponse.json({ success: true })
}
