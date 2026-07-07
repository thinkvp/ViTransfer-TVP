import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { buildProjectActivity } from '@/lib/project-activity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

/**
 * GET /api/share/[token]/activity-feed
 *
 * Project Activity feed for the share page. Named activity-feed because
 * /api/share/[token]/activity is the realtime client-presence endpoint.
 *
 * Always applies client-level content filtering (READY-only content,
 * non-internal comments) regardless of session type, so this surface can
 * never leak internal content. Guests additionally get generic actor names.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params

    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.',
    }, `share-activity-feed:${token}`)
    if (rateLimitResult) return rateLimitResult

    const project = await prisma.project.findUnique({
      where: { slug: token },
      select: {
        id: true,
        sharePassword: true,
        authMode: true,
        hideFeedback: true,
        enableUploads: true,
        enableClientUploads: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403, headers: noStoreHeaders })
    }

    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)
    if (!accessCheck.authorized) {
      return accessCheck.errorResponse || NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const isGuest = !accessCheck.isAdmin && (accessCheck.isGuest === true || !accessCheck.isAuthenticated)

    const { searchParams } = new URL(request.url)
    const offset = Number(searchParams.get('offset')) || 0
    const limit = Number(searchParams.get('limit')) || undefined

    // Mirror the downloadable-files UPLOADS gate: master switch off hides it from
    // everyone; otherwise clients only see it when client uploads are enabled.
    const includeUploads =
      project.enableUploads !== false &&
      (accessCheck.isAdmin || project.enableClientUploads !== false)

    const page = await buildProjectActivity(project.id, {
      audience: isGuest ? 'guest' : 'client',
      includeComments: !project.hideFeedback,
      includeUploads,
      offset,
      limit,
    })

    return NextResponse.json(page, { headers: noStoreHeaders })
  } catch (error) {
    console.error('[ACTIVITY FEED] Error building share activity feed:', error)
    return NextResponse.json({ error: 'Failed to load activity' }, { status: 500, headers: noStoreHeaders })
  }
}
