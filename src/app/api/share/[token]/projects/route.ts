import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { getShareContext, signShareToken } from '@/lib/auth'
import { getShareTokenTtlSeconds } from '@/lib/settings'
import { rateLimit } from '@/lib/rate-limit'
import { trackSharePageAccess } from '@/lib/share-access-tracking'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SWITCHABLE_PROJECT_STATUSES = ['IN_PROGRESS', 'IN_REVIEW', 'REVIEWED', 'ON_HOLD', 'APPROVED'] as const

async function getAuthorizedShareSession(request: NextRequest, token: string) {
  const [currentProject, globalSettings] = await Promise.all([
    prisma.project.findUnique({
      where: { slug: token },
      select: {
        id: true,
        title: true,
        clientId: true,
        allowAuthenticatedProjectSwitching: true,
      },
    }),
    prisma.settings.findUnique({
      where: { id: 'default' },
      select: { defaultAllowAuthenticatedProjectSwitching: true },
    }),
  ])

  if (!currentProject) {
    return {
      currentProject: null,
      shareContext: null,
      errorResponse: NextResponse.json({ error: 'Not found' }, { status: 404 }),
    }
  }

  const shareContext = await getShareContext(request)
  if (!shareContext || shareContext.projectId !== currentProject.id) {
    return {
      currentProject,
      shareContext: null,
      errorResponse: NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    }
  }

  if (shareContext.guest) {
    return {
      currentProject,
      shareContext,
      errorResponse: NextResponse.json({ error: 'Guest users cannot switch projects' }, { status: 403 }),
    }
  }

  if (shareContext.accessMethod !== 'PASSWORD' && shareContext.accessMethod !== 'OTP') {
    return {
      currentProject,
      shareContext,
      errorResponse: NextResponse.json({ error: 'Project switching is not available for this session' }, { status: 403 }),
    }
  }

  if ((globalSettings?.defaultAllowAuthenticatedProjectSwitching ?? true) !== true) {
    return {
      currentProject,
      shareContext,
      errorResponse: NextResponse.json({ error: 'Project switching is disabled' }, { status: 403 }),
    }
  }

  if (currentProject.allowAuthenticatedProjectSwitching !== true) {
    return {
      currentProject,
      shareContext,
      errorResponse: NextResponse.json({ error: 'Project switching is disabled for this project' }, { status: 403 }),
    }
  }

  return {
    currentProject,
    shareContext,
    errorResponse: null,
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    `share-project-switch-list:${token}`
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { currentProject, errorResponse } = await getAuthorizedShareSession(request, token)
    if (errorResponse) return errorResponse

    if (!currentProject?.clientId) {
      const response = NextResponse.json({ projects: [] })
      response.headers.set('Cache-Control', 'no-store')
      response.headers.set('Pragma', 'no-cache')
      return response
    }

    const projects = await prisma.project.findMany({
      where: {
        clientId: currentProject.clientId,
        id: { not: currentProject.id },
        status: { in: [...SWITCHABLE_PROJECT_STATUSES] as any },
        allowAuthenticatedProjectSwitching: true,
      },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        updatedAt: true,
      },
      orderBy: [
        { updatedAt: 'desc' },
        { title: 'asc' },
      ],
    })

    const response = NextResponse.json({
      projects: projects.map((project) => ({
        ...project,
        updatedAt: project.updatedAt.toISOString(),
      })),
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch {
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    `share-project-switch:${token}`
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { currentProject, shareContext, errorResponse } = await getAuthorizedShareSession(request, token)
    if (errorResponse || !currentProject || !shareContext) return errorResponse

    const accessMethod = shareContext.accessMethod
    if (accessMethod !== 'PASSWORD' && accessMethod !== 'OTP') {
      return NextResponse.json({ error: 'Project switching is not available for this session' }, { status: 403 })
    }

    if (!currentProject.clientId) {
      return NextResponse.json({ error: 'No other client projects are available' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const targetProjectId = typeof body?.projectId === 'string' ? body.projectId.trim() : ''
    const targetSlug = typeof body?.slug === 'string' ? body.slug.trim() : ''

    if (!targetProjectId && !targetSlug) {
      return NextResponse.json({ error: 'A target project is required' }, { status: 400 })
    }

    const targetProject = await prisma.project.findFirst({
      where: {
        clientId: currentProject.clientId,
        id: targetProjectId ? targetProjectId : undefined,
        slug: targetSlug ? targetSlug : undefined,
        status: { in: [...SWITCHABLE_PROJECT_STATUSES] as any },
        allowAuthenticatedProjectSwitching: true,
      },
      select: {
        id: true,
        slug: true,
        title: true,
      },
    })

    if (!targetProject || targetProject.id === currentProject.id) {
      return NextResponse.json({ error: 'Project not available' }, { status: 404 })
    }

    const sessionId = crypto.randomBytes(16).toString('base64url')
    const ttlSeconds = await getShareTokenTtlSeconds()
    const shareToken = signShareToken({
      shareId: targetProject.slug,
      projectId: targetProject.id,
      permissions: ['view', 'comment', 'download'],
      guest: false,
      sessionId,
      accessMethod,
      email: shareContext.email,
      ttlSeconds,
    })

    await trackSharePageAccess({
      projectId: currentProject.id,
      accessMethod,
      eventType: 'SWITCH_AWAY',
      email: accessMethod === 'OTP' ? shareContext.email : undefined,
      targetProjectTitle: targetProject.title,
      sessionId: shareContext.sessionId,
      request,
    })

    await trackSharePageAccess({
      projectId: targetProject.id,
      accessMethod,
      email: accessMethod === 'OTP' ? shareContext.email : undefined,
      originProjectTitle: currentProject.title,
      sessionId,
      request,
    })

    const response = NextResponse.json({
      success: true,
      shareToken,
      project: {
        id: targetProject.id,
        slug: targetProject.slug,
        title: targetProject.title,
      },
      accessMethod,
      email: accessMethod === 'OTP' ? (shareContext.email || null) : null,
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch {
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}