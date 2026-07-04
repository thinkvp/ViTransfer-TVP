import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { isS3Mode } from '@/lib/s3-storage'
import { getFolderRenameQueue } from '@/lib/queue'
import {
  allocateUniqueStorageName,
  buildProjectStorageRoot,
  getStoragePathBasename,
} from '@/lib/project-storage-paths'
import { z } from 'zod'

export const runtime = 'nodejs'

const bodySchema = z.object({
  /** The new project title to apply. */
  title: z.string().min(1).max(255).trim(),
  /** Optional: new clientId if the client is also changing. */
  clientId: z.string().optional(),
})

/**
 * POST /api/projects/[id]/rename-confirm
 *
 * Called after the user accepts the S3 rename warning modal.
 * - Updates Project.title immediately (visible right away).
 * - Creates a FolderRenameJob DB record.
 * - Enqueues a BullMQ folder-rename job.
 * - Does NOT yet update Project.storagePath — the worker does that upon completion.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10 },
    'project-rename-confirm',
  )
  if (rateLimitResult) return rateLimitResult

  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not active' }, { status: 400 })
  }

  try {
    const body = await request.json()
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })
    }

    const { title: newTitle, clientId: newClientId } = parsed.data

    const project = await prisma.project.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        storagePath: true,
        clientId: true,
        client: { select: { name: true } },
      },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Reject if a rename job is already in progress
    const activeJob = await prisma.folderRenameJob.findFirst({
      where: { entityType: 'PROJECT', entityId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    })
    if (activeJob) {
      return NextResponse.json({ error: 'A rename is already in progress for this project' }, { status: 423 })
    }

    const targetClientId = newClientId !== undefined ? newClientId : project.clientId

    // Resolve target client name
    let targetClientName: string
    if (targetClientId && targetClientId !== project.clientId) {
      const targetClient = await prisma.client.findFirst({
        where: { id: targetClientId, deletedAt: null },
        select: { name: true },
      })
      if (!targetClient) {
        return NextResponse.json({ error: 'Target client not found' }, { status: 404 })
      }
      targetClientName = targetClient.name
    } else {
      targetClientName = project.client?.name ?? ''
    }

    // Compute old and new storage paths (same logic as project PATCH)
    const currentStoragePath = project.storagePath
      || buildProjectStorageRoot(project.client?.name ?? '', project.title)

    const siblingProjects = await prisma.project.findMany({
      where: { clientId: targetClientId, NOT: { id } },
      select: { storagePath: true, title: true },
    })

    const newFolderName = allocateUniqueStorageName(
      newTitle,
      siblingProjects
        .map((p) => getStoragePathBasename(p.storagePath) || p.title)
        .filter(Boolean) as string[],
    )
    const newStoragePath = buildProjectStorageRoot(targetClientName, newFolderName)

    if (newStoragePath === currentStoragePath) {
      // Paths didn't actually change — just update the title directly
      await prisma.project.update({ where: { id }, data: { title: newTitle } })
      return NextResponse.json({ jobId: null, message: 'No S3 move required — title updated directly' })
    }

    // Create the FolderRenameJob record
    const renameJob = await prisma.folderRenameJob.create({
      data: {
        entityType: 'PROJECT',
        entityId: id,
        entityName: newTitle,
        oldPrefix: currentStoragePath,
        newPrefix: newStoragePath,
      },
    })

    // Update project title immediately (storagePath is updated by the worker on completion)
    await prisma.project.update({
      where: { id },
      data: { title: newTitle },
    })

    // Enqueue the BullMQ job
    const queue = getFolderRenameQueue()
    await queue.add('folder-rename', { folderRenameJobId: renameJob.id })

    return NextResponse.json({ jobId: renameJob.id })
  } catch (err: any) {
    console.error('[project-rename-confirm]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
