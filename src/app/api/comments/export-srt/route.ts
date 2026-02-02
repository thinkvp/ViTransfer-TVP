import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { timecodeToSeconds } from '@/lib/timecode'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type CommentRow = {
  id: string
  parentId: string | null
  timecode: string
  content: string
  createdAt: Date
  files: Array<{ fileName: string }>
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function toSrtTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds)

  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = Math.floor(safe % 60)

  let ms = Math.round((safe - Math.floor(safe)) * 1000)
  if (ms >= 1000) ms = 999
  if (ms < 0) ms = 0

  const hh = String(hours).padStart(2, '0')
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  const mmm = String(ms).padStart(3, '0')
  return `${hh}:${mm}:${ss},${mmm}`
}

function safeFilenamePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function buildCommentText(comment: CommentRow, kind: 'comment' | 'reply'): string {
  // Requirement: do not show timecode in the text.
  const content = (comment.content || '').trim()
  const fileNames = (comment.files || []).map(f => f.fileName).filter(Boolean)

  const prefix = kind === 'reply' ? 'Reply: ' : ''
  const lines: string[] = []

  if (content) lines.push(`${prefix}${content}`)
  else lines.push(`${prefix}(no text)`) // defensive

  if (fileNames.length > 0) {
    lines.push(`Attachments: ${fileNames.join(', ')}`)
  }

  return lines.join('\n')
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'accessProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get('projectId')
  const videoId = searchParams.get('videoId')

  if (!projectId || !videoId) {
    return NextResponse.json({ error: 'projectId and videoId are required' }, { status: 400 })
  }

  if (authResult.appRoleIsSystemAdmin !== true) {
    const projectAccess = await prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true, assignedUsers: { select: { userId: true } } },
    })

    if (!projectAccess) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const assigned = projectAccess.assignedUsers?.some((u) => u.userId === authResult.id)
    if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (!isVisibleProjectStatusForUser(authResult, projectAccess.status)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const [project, video] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, slug: true, title: true },
    }),
    prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, name: true, versionLabel: true, fps: true },
    }),
  ])

  if (!project || !video) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Ensure the requested video belongs to the requested project.
  const videoProject = await prisma.video.findUnique({
    where: { id: videoId },
    select: { projectId: true },
  })
  if (!videoProject || videoProject.projectId !== projectId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const fps = typeof video.fps === 'number' && Number.isFinite(video.fps) && video.fps > 0 ? video.fps : 24

  // Fetch ALL comments for this project/video.
  // This ensures we include replies even if they are nested > 1 deep.
  const allComments = await prisma.comment.findMany({
    where: {
      projectId,
      videoId,
    },
    select: {
      id: true,
      parentId: true,
      timecode: true,
      content: true,
      createdAt: true,
      files: { select: { fileName: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const byId = new Map<string, CommentRow>()
  for (const c of allComments as any[]) {
    byId.set(c.id, c)
  }

  const childrenByParentId = new Map<string, CommentRow[]>()
  for (const c of allComments as any[]) {
    if (!c.parentId) continue
    const existing = childrenByParentId.get(c.parentId)
    if (existing) existing.push(c)
    else childrenByParentId.set(c.parentId, [c])
  }

  const roots = (allComments as any[]).filter(c => !c.parentId)

  // Flatten comments in a parent->reply order (pre-order traversal).
  // Each descendant is grouped under the top-level parent's timecode cue.
  const items: Array<{ row: CommentRow; kind: 'comment' | 'reply'; groupTimecode: string }> = []

  const pushThread = (root: CommentRow) => {
    const rootTimecode = root.timecode || '00:00:00:00'
    items.push({ row: root, kind: 'comment', groupTimecode: rootTimecode })

    const stack: CommentRow[] = [...(childrenByParentId.get(root.id) || [])].reverse()
    while (stack.length > 0) {
      const node = stack.pop()!
      items.push({ row: node, kind: 'reply', groupTimecode: rootTimecode })

      const kids = childrenByParentId.get(node.id)
      if (kids && kids.length > 0) {
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push(kids[i])
        }
      }
    }
  }

  for (const root of roots as any[]) {
    pushThread(root)
  }

  // Handle orphaned replies (shouldn't happen, but keeps export complete).
  for (const c of allComments as any[]) {
    if (!c.parentId) continue
    if (!byId.has(c.parentId)) {
      const tc = c.timecode || '00:00:00:00'
      items.push({ row: c, kind: 'reply', groupTimecode: tc })
    }
  }

  // Group by exact timecode string.
  const grouped = new Map<
    string,
    {
      timecode: string
      startSeconds: number
      texts: string[]
    }
  >()

  for (const item of items) {
    const tc = item.groupTimecode || item.row.timecode || '00:00:00:00'
    let startSeconds = 0
    try {
      startSeconds = timecodeToSeconds(tc, fps)
    } catch {
      startSeconds = 0
    }

    const existing = grouped.get(tc)
    const text = buildCommentText(item.row, item.kind)

    if (existing) {
      existing.texts.push(text)
    } else {
      grouped.set(tc, { timecode: tc, startSeconds, texts: [text] })
    }
  }

  const cues = Array.from(grouped.values()).sort((a, b) => {
    const delta = a.startSeconds - b.startSeconds
    if (delta !== 0) return delta
    return a.timecode.localeCompare(b.timecode)
  })

  const defaultDurationSeconds = 4
  const minDurationSeconds = 0.5

  let index = 1
  const srtBlocks: string[] = []

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]
    const next = cues[i + 1]

    const start = Math.max(0, cue.startSeconds)

    let end = start + defaultDurationSeconds
    if (next && next.startSeconds > start) {
      end = Math.min(end, next.startSeconds - 0.001)
    }

    if (!(end > start)) {
      end = start + minDurationSeconds
    }

    // Keep within sane bounds.
    end = clamp(end, start + 0.001, start + 60 * 60)

    // Separate multiple comments/replies with a blank line.
    const text = cue.texts.join('\n\n')

    srtBlocks.push(
      String(index++),
      `${toSrtTimestamp(start)} --> ${toSrtTimestamp(end)}`,
      text,
      ''
    )
  }

  const srt = srtBlocks.join('\r\n')

  const filename = `${safeFilenamePart(video.name)}${video.versionLabel ? `-${safeFilenamePart(video.versionLabel)}` : ''}-comments.srt`

  return new NextResponse(srt, {
    status: 200,
    headers: {
      'content-type': 'application/x-subrip; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
    },
  })
}
