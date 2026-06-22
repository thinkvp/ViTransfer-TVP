import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { generateVideoAccessToken } from '@/lib/video-access'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireAnyActionAccess } from '@/lib/rbac-api'
import { getStoredFileRecords } from '@/lib/stored-file'
import { isS3Mode, s3GetPresignedStreamUrl } from '@/lib/s3-storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Batch sibling of ../route.ts (the single-token GET). Mints access tokens for many
// (videoId, quality) pairs in one request so the admin share page doesn't fire one
// GET per video for sidebar/grid thumbnails. Mirrors the single route's authorization
// (auth gate + action gate + per-project visibility) and per-quality availability check.
const MAX_ITEMS = 300

function canIssueAdminVideoToken(storedRoles: Set<string>, quality: string): boolean {
  const canUseOriginal = storedRoles.has('ORIGINAL')
  switch (quality) {
    case '480p':
      return storedRoles.has('PREVIEW_480') || storedRoles.has('PREVIEW_720') || storedRoles.has('PREVIEW_1080') || canUseOriginal
    case '720p':
      return storedRoles.has('PREVIEW_720') || storedRoles.has('PREVIEW_1080') || storedRoles.has('PREVIEW_480') || canUseOriginal
    case '1080p':
      return storedRoles.has('PREVIEW_1080') || storedRoles.has('PREVIEW_720') || storedRoles.has('PREVIEW_480') || canUseOriginal
    case 'thumbnail':
      return storedRoles.has('THUMBNAIL')
    case 'timeline-vtt':
      return storedRoles.has('TIMELINE_VTT')
    case 'timeline-sprite':
      return storedRoles.has('TIMELINE_SPRITES')
    case 'original':
    case 'download':
      return canUseOriginal
    default:
      return false
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenAction = requireAnyActionAccess(authResult, ['accessSharePage', 'uploadVideosOnProjects', 'manageProjectAlbums', 'accessProjectSettings'])
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 120,
    message: 'Too many token generation requests. Please slow down.'
  }, 'admin-video-token-batch')
  if (rateLimitResult) return rateLimitResult

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const projectId = String(body?.projectId || '').trim()
  const sessionId = String(body?.sessionId || '').trim()
  const rawItems = Array.isArray(body?.items) ? body.items : []

  if (!projectId || !sessionId) {
    return NextResponse.json({ error: 'projectId and sessionId are required' }, { status: 400 })
  }

  const items: Array<{ videoId: string; quality: string }> = rawItems
    .map((it: any) => ({ videoId: String(it?.videoId || '').trim(), quality: String(it?.quality || '').trim() }))
    .filter((it: { videoId: string; quality: string }) => it.videoId.length > 0 && it.quality.length > 0)

  if (items.length === 0) {
    return NextResponse.json({ error: 'items is required' }, { status: 400 })
  }
  if (items.length > MAX_ITEMS) {
    return NextResponse.json({ error: `Too many items (max ${MAX_ITEMS})` }, { status: 400 })
  }

  // Non-system-admins must be assigned to the project and able to see its status.
  if (authResult.appRoleIsSystemAdmin !== true) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true, assignedUsers: { select: { userId: true } } },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const assigned = project.assignedUsers?.some((u) => u.userId === authResult.id)
    if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const videoIds: string[] = Array.from(new Set(items.map((it) => it.videoId)))

  // Only mint for videos that actually belong to this project.
  const videos = await prisma.video.findMany({
    where: { id: { in: videoIds }, projectId },
    select: { id: true },
  })
  const validVideoIds = new Set(videos.map((v) => v.id))

  // Resolve available file roles (and thumbnail storage paths) for every video in one query.
  const storedFiles = await getStoredFileRecords('VIDEO', videoIds, {
    select: { entityId: true, fileRole: true, storagePath: true },
  })
  const rolesByVideoId = new Map<string, Set<string>>()
  const thumbnailPathByVideoId = new Map<string, string>()
  for (const f of storedFiles) {
    if (!rolesByVideoId.has(f.entityId)) rolesByVideoId.set(f.entityId, new Set())
    rolesByVideoId.get(f.entityId)!.add(f.fileRole)
    if (f.fileRole === 'THUMBNAIL' && f.storagePath) {
      thumbnailPathByVideoId.set(f.entityId, f.storagePath)
    }
  }

  const results: Record<string, string> = {}
  // S3 mode: hand back presigned R2 URLs for thumbnails so the admin grid loads each
  // <img> directly from R2 — skipping the per-thumbnail round-trip through /api/content
  // (token verify + DB lookups + existence HEAD + 302 redirect). Tokens are still minted
  // below for backward compatibility with callers that proxy via /api/content.
  const directUrls: Record<string, string> = {}
  const s3 = isS3Mode()

  await Promise.all(
    items.map(async (it: { videoId: string; quality: string }) => {
      if (!validVideoIds.has(it.videoId)) return
      const roles = rolesByVideoId.get(it.videoId) ?? new Set<string>()
      if (!canIssueAdminVideoToken(roles, it.quality)) return

      const pairKey = `${it.videoId}:${it.quality}`

      if (s3 && it.quality === 'thumbnail') {
        const thumbPath = thumbnailPathByVideoId.get(it.videoId)
        if (thumbPath) {
          try {
            // 4h validity so a presigned URL cached in the grid for an open page doesn't expire.
            directUrls[pairKey] = await s3GetPresignedStreamUrl(thumbPath, 14400, 'image/jpeg')
          } catch (error) {
            console.error('[API] Failed to presign thumbnail URL (batch)', { videoId: it.videoId, error })
          }
        }
      }

      try {
        const token = await generateVideoAccessToken(it.videoId, projectId, it.quality, request, sessionId)
        if (token) results[pairKey] = token
      } catch (error) {
        console.error('[API] Failed to mint admin video token (batch)', { videoId: it.videoId, quality: it.quality, error })
      }
    }),
  )

  const response = NextResponse.json({ results, directUrls })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}
