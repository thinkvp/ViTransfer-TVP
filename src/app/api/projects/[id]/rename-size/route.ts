import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { isS3Mode, s3GetDirectorySizeInfo } from '@/lib/s3-storage'
import { buildProjectStorageRoot, getStoragePathBasename } from '@/lib/project-storage-paths'

export const runtime = 'nodejs'

/**
 * GET /api/projects/[id]/rename-size
 *
 * Returns the number of S3 objects and total bytes under the project's current
 * storage prefix. Used to inform the user before confirming a heavy S3 rename.
 */
export async function GET(
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
    'project-rename-size',
  )
  if (rateLimitResult) return rateLimitResult

  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not active' }, { status: 400 })
  }

  try {
    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true, title: true, storagePath: true, clientId: true, client: { select: { name: true } } },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const clientName = project.client?.name ?? ''
    const prefix = project.storagePath
      || buildProjectStorageRoot(clientName, getStoragePathBasename(project.storagePath) || project.title)

    const { totalObjects, totalBytes } = await s3GetDirectorySizeInfo(prefix)

    return NextResponse.json({
      totalObjects,
      totalBytes: totalBytes.toString(), // BigInt → string for JSON
    })
  } catch (err: any) {
    console.error('[project-rename-size]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
