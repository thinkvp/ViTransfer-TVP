import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import crypto from 'crypto'
import { getAuthContext } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000

function isExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now()
}

function randomToken(): string {
  // 24 bytes => 32 chars base64url-ish, non-guessable.
  return crypto.randomBytes(24).toString('base64url')
}

async function requireGuestVideoLinkContext(
  request: NextRequest,
  ids: { projectId: string; videoId: string }
): Promise<
  | {
      ok: true
      isAdmin: boolean
      userId: string | null
      project: { id: string; title: string; status: string; guestMode: boolean }
      video: { id: string; name: string | null; version: number | null; versionLabel: string | null }
    }
  | { ok: false; response: NextResponse }
> {
  const { user, isAdmin, shareContext } = await getAuthContext(request)
  if (!isAdmin && !shareContext) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const projectId = typeof ids.projectId === 'string' ? ids.projectId.trim() : ''
  const videoId = typeof ids.videoId === 'string' ? ids.videoId.trim() : ''

  if (!projectId || !videoId) {
    return { ok: false, response: NextResponse.json({ error: 'projectId and videoId are required' }, { status: 400 }) }
  }

  if (shareContext && shareContext.projectId !== projectId) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      status: true,
      guestMode: true,
    },
  })

  if (!project) {
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }

  if (!project.guestMode) {
    return { ok: false, response: NextResponse.json({ error: 'Guest access is not enabled for this project' }, { status: 403 }) }
  }

  if (project.status === 'CLOSED') {
    return { ok: false, response: NextResponse.json({ error: 'Project is closed' }, { status: 403 }) }
  }

  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      projectId: true,
      status: true,
      name: true,
      version: true,
      versionLabel: true,
    },
  })

  if (!video || video.projectId !== project.id) {
    return { ok: false, response: NextResponse.json({ error: 'Video not found' }, { status: 404 }) }
  }

  if (video.status !== 'READY') {
    return { ok: false, response: NextResponse.json({ error: 'Video is not ready' }, { status: 409 }) }
  }

  return {
    ok: true,
    isAdmin,
    userId: user?.id || null,
    project,
    video,
  }
}

/**
 * GET /api/guest-video-links?projectId=...&videoId=...
 *
 * Returns the currently stored guest link (if any) for this video version.
 * Requires either admin auth OR a share JWT (from /share/* pages).
 */
export async function GET(request: NextRequest) {
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please try again later.' },
    'guest-video-link-get'
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const projectId = url.searchParams.get('projectId') || ''
  const videoId = url.searchParams.get('videoId') || ''

  const ctx = await requireGuestVideoLinkContext(request, { projectId, videoId })
  if (!ctx.ok) return ctx.response

  const row = await (prisma as any).guestVideoShareLink.findUnique({
    where: { projectId_videoId: { projectId: ctx.project.id, videoId: ctx.video.id } },
    select: { token: true, expiresAt: true },
  })

  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const response = NextResponse.json({
    token: row.token,
    urlPath: `/gv/${row.token}`,
    expiresAt: row.expiresAt,
    isExpired: isExpired(row.expiresAt),
    video: {
      id: ctx.video.id,
      name: ctx.video.name,
      version: ctx.video.version,
      versionLabel: ctx.video.versionLabel,
    },
    project: {
      id: ctx.project.id,
      title: ctx.project.title,
    },
  })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}

/**
 * POST /api/guest-video-links
 *
 * Creates (or regenerates) a per-video-version guest-only share link.
 * Requires either admin auth OR a share JWT (from /share/* pages).
 */
export async function POST(request: NextRequest) {
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please try again later.' },
    'guest-video-link-gen'
  )
  if (rateLimitResult) return rateLimitResult

  let body: any = null
  try {
    body = await request.json()
  } catch {
    body = null
  }

  const action = typeof body?.action === 'string' ? String(body.action) : 'generate'
  const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : ''
  const videoId = typeof body?.videoId === 'string' ? body.videoId.trim() : ''

  const ctx = await requireGuestVideoLinkContext(request, { projectId, videoId })
  if (!ctx.ok) return ctx.response

  const expiresAt = new Date(Date.now() + FOURTEEN_DAYS_MS)

  // action:
  // - generate: rotate token + reset expiry
  // - refreshExpiry: keep token (if exists) + reset expiry
  const existing = await (prisma as any).guestVideoShareLink.findUnique({
    where: { projectId_videoId: { projectId: ctx.project.id, videoId: ctx.video.id } },
    select: { token: true },
  })

  if (action === 'refreshExpiry' && existing) {
    const row = await (prisma as any).guestVideoShareLink.update({
      where: { projectId_videoId: { projectId: ctx.project.id, videoId: ctx.video.id } },
      data: { expiresAt },
      select: { token: true, expiresAt: true },
    })

    const response = NextResponse.json({
      token: row.token,
      urlPath: `/gv/${row.token}`,
      expiresAt: row.expiresAt,
      video: {
        id: ctx.video.id,
        name: ctx.video.name,
        version: ctx.video.version,
        versionLabel: ctx.video.versionLabel,
      },
      project: {
        id: ctx.project.id,
        title: ctx.project.title,
      },
      updatedBy: ctx.isAdmin ? { type: 'ADMIN', userId: ctx.userId } : { type: 'SHARE', userId: null },
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  }

  // Generate (or refresh without existing): create/rotate token.
  let lastError: any = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomToken()
    try {
      const row = await (prisma as any).guestVideoShareLink.upsert({
        where: { projectId_videoId: { projectId: ctx.project.id, videoId: ctx.video.id } },
        create: {
          token,
          projectId: ctx.project.id,
          videoId: ctx.video.id,
          expiresAt,
        },
        update: {
          token,
          expiresAt,
        },
        select: { token: true, expiresAt: true },
      })

      const response = NextResponse.json({
        token: row.token,
        urlPath: `/gv/${row.token}`,
        expiresAt: row.expiresAt,
        video: {
          id: ctx.video.id,
          name: ctx.video.name,
          version: ctx.video.version,
          versionLabel: ctx.video.versionLabel,
        },
        project: {
          id: ctx.project.id,
          title: ctx.project.title,
        },
        generatedBy: ctx.isAdmin ? { type: 'ADMIN', userId: ctx.userId } : { type: 'SHARE', userId: null },
      })
      response.headers.set('Cache-Control', 'no-store')
      response.headers.set('Pragma', 'no-cache')
      return response
    } catch (e: any) {
      lastError = e
      // Unique constraint collisions are extremely unlikely, but retry if they happen.
      continue
    }
  }

  console.error('[GUEST-VIDEO-LINK] Failed to generate token', lastError)
  return NextResponse.json({ error: 'Unable to generate link' }, { status: 500 })
}
