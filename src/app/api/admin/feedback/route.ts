import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions } from '@/lib/rbac-api'
import { projectStatusSortPriority } from '@/lib/project-status'

// Order a version's comments by video timecode (chronological position in the video),
// keeping each reply immediately after its parent.
function orderThreaded(comments: FeedbackComment[]): FeedbackComment[] {
  const parents = comments.filter((c) => !c.parentId)
  const replies = comments.filter((c) => c.parentId)
  const byParent = new Map<string, FeedbackComment[]>()
  for (const r of replies) {
    const arr = byParent.get(r.parentId as string) ?? []
    arr.push(r)
    byParent.set(r.parentId as string, arr)
  }
  const byCreated = (a: FeedbackComment, b: FeedbackComment) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  parents.sort((a, b) => {
    const t = (a.timecode || '').localeCompare(b.timecode || '')
    return t !== 0 ? t : byCreated(a, b)
  })
  for (const arr of byParent.values()) arr.sort(byCreated)

  const parentIds = new Set(parents.map((p) => p.id))
  const ordered: FeedbackComment[] = []
  for (const p of parents) {
    ordered.push(p)
    const rs = byParent.get(p.id)
    if (rs) ordered.push(...rs)
  }
  // Orphan replies whose parent isn't in this version (shouldn't normally happen).
  for (const r of replies) {
    if (!r.parentId || !parentIds.has(r.parentId)) ordered.push(r)
  }
  return ordered
}

// Comment content is stored as sanitized HTML. The feedback list only needs a compact
// text preview, so strip tags and decode the handful of entities the editor produces.
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type FeedbackComment = {
  id: string
  content: string
  authorName: string
  isInternal: boolean
  timecode: string
  parentId: string | null
  createdAt: Date
  resolvedAt: Date | null
  videoId: string
}

type VersionGroup = {
  videoId: string
  version: number
  versionLabel: string | null
  unresolvedCount: number
  resolvedCount: number
  comments: FeedbackComment[]
}

type VideoGroup = {
  name: string
  videoIds: string[]
  unresolvedCount: number
  versions: VersionGroup[]
}

type ProjectGroup = {
  id: string
  title: string
  companyName: string | null
  status: string
  unresolvedCount: number
  videos: VideoGroup[]
}

/**
 * GET /api/admin/feedback
 * Returns the current admin's video feedback, grouped
 * Project → Video (by name) → Version, for the Projects-page task list.
 *
 * Only open (non-CLOSED, status-visible) projects the user is assigned to, and
 * only those with at least one comment, are returned. All comments (resolved and
 * unresolved) are included so fully-resolved groups remain visible; the UI hides
 * resolved items by default behind a "show done" toggle.
 */
export async function GET(request: NextRequest) {
  const auth = await requireApiMenu(request, 'projects')
  if (auth instanceof Response) return auth
  const user = auth

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.',
  }, 'feedback-list', user.id)
  if (rateLimitResult) return rateLimitResult

  try {
    const permissions = getUserPermissions(user)
    const allowedStatuses = permissions.projectVisibility.statuses
    const isSystemAdmin = user.appRoleIsSystemAdmin === true

    // "Open" = any visible status except CLOSED.
    const openStatuses = (Array.isArray(allowedStatuses) ? allowedStatuses : []).filter(
      (s) => s !== 'CLOSED'
    )
    if (openStatuses.length === 0) {
      return NextResponse.json({ projects: [] }, { headers: { 'Cache-Control': 'no-store' } })
    }

    const projectFilter = {
      status: { in: openStatuses as any },
      ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: user.id } } }),
    }

    // All comments — resolved items are hidden client-side behind "show done".
    const rows = await prisma.comment.findMany({
      where: {
        project: projectFilter,
      },
      select: {
        id: true,
        content: true,
        authorName: true,
        isInternal: true,
        timecode: true,
        parentId: true,
        createdAt: true,
        resolvedAt: true,
        videoId: true,
        videoVersion: true,
        user: { select: { name: true, username: true, email: true } },
        video: { select: { id: true, name: true, version: true, versionLabel: true } },
        project: { select: { id: true, title: true, companyName: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    // Group: project → video name → version (video row).
    const projectsMap = new Map<string, ProjectGroup>()
    const videoMap = new Map<string, VideoGroup>() // key: `${projectId}::${name}`
    const versionMap = new Map<string, VersionGroup>() // key: videoId

    for (const row of rows) {
      if (!row.video || !row.project) continue

      // Project
      let proj = projectsMap.get(row.project.id)
      if (!proj) {
        proj = {
          id: row.project.id,
          title: row.project.title,
          companyName: row.project.companyName,
          status: row.project.status,
          unresolvedCount: 0,
          videos: [],
        }
        projectsMap.set(row.project.id, proj)
      }

      // Video (by name)
      const videoKey = `${row.project.id}::${row.video.name}`
      let vid = videoMap.get(videoKey)
      if (!vid) {
        vid = { name: row.video.name, videoIds: [], unresolvedCount: 0, versions: [] }
        videoMap.set(videoKey, vid)
        proj.videos.push(vid)
      }

      // Version (video row)
      let ver = versionMap.get(row.videoId)
      if (!ver) {
        ver = {
          videoId: row.videoId,
          version: row.video.version,
          versionLabel: row.video.versionLabel,
          unresolvedCount: 0,
          resolvedCount: 0,
          comments: [],
        }
        versionMap.set(row.videoId, ver)
        vid.versions.push(ver)
        if (!vid.videoIds.includes(row.videoId)) vid.videoIds.push(row.videoId)
      }

      const authorName =
        row.authorName ||
        (row.isInternal && row.user ? row.user.name || row.user.username || row.user.email : null) ||
        'Client'

      ver.comments.push({
        id: row.id,
        content: toPlainText(row.content),
        authorName,
        isInternal: row.isInternal,
        timecode: row.timecode,
        parentId: row.parentId,
        createdAt: row.createdAt,
        resolvedAt: row.resolvedAt,
        videoId: row.videoId,
      })

      if (row.resolvedAt) {
        ver.resolvedCount += 1
      } else {
        ver.unresolvedCount += 1
        vid.unresolvedCount += 1
        proj.unresolvedCount += 1
      }
    }

    // Sort + finalise.
    const projects = Array.from(projectsMap.values())
      .map((proj) => {
        for (const vid of proj.videos) {
          vid.versions.sort((a, b) => b.version - a.version)
          for (const ver of vid.versions) {
            ver.comments = orderThreaded(ver.comments)
          }
        }
        proj.videos.sort((a, b) => a.name.localeCompare(b.name))
        return proj
      })
      .sort((a, b) => {
        const pa = projectStatusSortPriority(a.status)
        const pb = projectStatusSortPriority(b.status)
        if (pa !== pb) return pa - pb
        return a.title.localeCompare(b.title)
      })

    return NextResponse.json({ projects }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[FEEDBACK-LIST] Error:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
