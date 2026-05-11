import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { isS3Mode, s3GetDirectorySizeInfo } from '@/lib/s3-storage'
import { buildClientStorageRoot } from '@/lib/project-storage-paths'

export const runtime = 'nodejs'

/**
 * GET /api/clients/[id]/rename-size
 *
 * Returns the number of S3 objects and total bytes under the client's current
 * storage prefix (includes all projects). Used to inform the user before
 * confirming a heavy S3 rename.
 */
export async function GET(
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
    'client-rename-size',
  )
  if (rateLimitResult) return rateLimitResult

  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not active' }, { status: 400 })
  }

  try {
    const client = await prisma.client.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const prefix = buildClientStorageRoot(client.name)

    const { totalObjects, totalBytes } = await s3GetDirectorySizeInfo(prefix)

    return NextResponse.json({
      totalObjects,
      totalBytes: totalBytes.toString(),
    })
  } catch (err: any) {
    console.error('[client-rename-size]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
