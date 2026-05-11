import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { isS3Mode } from '@/lib/s3-storage'
import { getFolderRenameQueue } from '@/lib/queue'
import { buildClientStorageRoot } from '@/lib/project-storage-paths'
import { z } from 'zod'

export const runtime = 'nodejs'

const bodySchema = z.object({
  name: z.string().min(1).max(255).trim(),
})

/**
 * POST /api/clients/[id]/rename-confirm
 *
 * Called after the user accepts the S3 rename warning modal for a client rename.
 * - Updates Client.name immediately.
 * - Creates a FolderRenameJob DB record.
 * - Enqueues a BullMQ folder-rename job.
 * - Project storagePaths are updated by the worker upon completion.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'clients')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'manageClients')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10 },
    'client-rename-confirm',
  )
  if (rateLimitResult) return rateLimitResult

  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not active' }, { status: 400 })
  }

  try {
    const body = await request.json()
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
    }

    const { name: newName } = parsed.data

    const client = await prisma.client.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true },
    })
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const trimmedOld = client.name.trim()
    const trimmedNew = newName.trim()

    if (trimmedOld === trimmedNew) {
      // Name unchanged — update only (no S3 move needed)
      await prisma.client.update({ where: { id }, data: { name: newName } })
      return NextResponse.json({ jobId: null, message: 'No S3 move required' })
    }

    // Reject if a rename job is already in progress for this client
    const activeJob = await prisma.folderRenameJob.findFirst({
      where: { entityType: 'CLIENT', entityId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    })
    if (activeJob) {
      return NextResponse.json({ error: 'A rename is already in progress for this client' }, { status: 423 })
    }

    const oldPrefix = buildClientStorageRoot(trimmedOld)
    const newPrefix = buildClientStorageRoot(trimmedNew)

    // Create the FolderRenameJob record
    const renameJob = await prisma.folderRenameJob.create({
      data: {
        entityType: 'CLIENT',
        entityId: id,
        entityName: newName,
        oldPrefix,
        newPrefix,
      },
    })

    // Update client name and sync companyName on linked projects immediately
    // (storage paths are updated by the worker on completion)
    await prisma.$transaction([
      prisma.client.update({
        where: { id },
        data: { name: newName },
      }),
      prisma.project.updateMany({
        where: { clientId: id },
        data: { companyName: newName },
      }),
    ])

    // Enqueue the BullMQ job
    const queue = getFolderRenameQueue()
    await queue.add('folder-rename', { folderRenameJobId: renameJob.id })

    return NextResponse.json({ jobId: renameJob.id })
  } catch (err: any) {
    console.error('[client-rename-confirm]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
