import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { recordClientActivity } from '@/lib/client-activity'
import { getClientIpAddress } from '@/lib/utils'
import { isLikelyAdminIp } from '@/lib/admin-ip-match'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  activityType: z.enum(['VIEWING_SHARE_PAGE', 'VIEWING_ALBUM']),
  albumId: z.string().optional().nullable(),
  albumName: z.string().optional().nullable(),
})

// PATCH /api/share/[token]/activity — update the client's current activity context
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    `share-activity:${token}`
  )
  if (rateLimitResult) return rateLimitResult

  const projectMeta = await prisma.project.findUnique({
    where: { slug: token },
    select: { id: true, sharePassword: true, authMode: true, title: true },
  })

  if (!projectMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const accessCheck = await verifyProjectAccess(request, projectMeta.id, projectMeta.sharePassword, projectMeta.authMode, {
    allowAnonymousNone: true,
  })

  if (!accessCheck.authorized) {
    return accessCheck.errorResponse || NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const sessionId = accessCheck.shareTokenSessionId
  if (!sessionId || sessionId.startsWith('admin:')) {
    return NextResponse.json({ ok: true })
  }

  const ipAddress = getClientIpAddress(request)
  const likelyAdmin = await isLikelyAdminIp(ipAddress).catch(() => false)
  if (likelyAdmin) {
    return NextResponse.json({ ok: true })
  }

  let body: z.infer<typeof bodySchema>
  try {
    const raw = await request.json()
    body = bodySchema.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  await recordClientActivity({
    sessionId,
    projectId: projectMeta.id,
    projectTitle: projectMeta.title,
    activityType: body.activityType,
    albumId: body.albumId ?? null,
    albumName: body.albumName ?? null,
    ipAddress: ipAddress || null,
  })

  return NextResponse.json({ ok: true })
}
