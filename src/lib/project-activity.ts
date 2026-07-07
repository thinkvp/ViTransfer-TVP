import { prisma } from '@/lib/db'

/**
 * Project Activity feed — derived live from existing tables so deleted
 * entities automatically disappear. No separate activity-log table.
 *
 * Visibility rules:
 * - audience 'admin'  → everything (all video/album/photo statuses, internal comments).
 * - audience 'client' → READY content only, non-internal comments, real actor names.
 * - audience 'guest'  → same content filter as 'client', but generic actor names
 *                       ('Admin'/'Client') — guests must not learn recipient identities.
 */

export type ProjectActivityAudience = 'admin' | 'client' | 'guest'

export type ProjectActivityEventType =
  | 'VIDEO_ADDED'
  | 'VIDEO_VERSION_ADDED'
  | 'VIDEO_APPROVED'
  | 'VIDEO_UNAPPROVED'
  | 'COMMENT_ADDED'
  | 'ALBUM_ADDED'
  | 'PHOTOS_ADDED'
  | 'UPLOADS_ADDED'
  | 'UPLOAD_FOLDER_ADDED'

export interface ProjectActivityActor {
  name: string
  kind: 'USER' | 'RECIPIENT' | 'UNKNOWN'
  color: string | null
  /**
   * Admin-user id, for avatar-image lookup (`/api/users/{id}/avatar`). Only present for named
   * USER actors on non-guest audiences; null for recipients, unknown actors, and guests (who
   * must not be able to resolve an admin's identity).
   */
  userId?: string | null
  /**
   * True when the actor is a real, named person (not a generic "Admin"/"Client" fallback).
   * Drives whether the UI shows an initials/photo avatar or falls back to the event-type icon.
   */
  named?: boolean
}

export interface ProjectActivityEvent {
  id: string
  type: ProjectActivityEventType
  timestamp: string // ISO; for grouped events this is the newest item in the bucket
  actor: ProjectActivityActor
  count?: number
  target: {
    videoId?: string
    videoName?: string
    versionLabel?: string
    albumId?: string
    albumName?: string
    folderPath?: string
    sampleFileNames?: string[]
    /** Single-line truncated preview of a comment's text (COMMENT_ADDED only). */
    commentPreview?: string
  }
}

export interface BuildProjectActivityOptions {
  audience: ProjectActivityAudience
  includeComments: boolean
  /** Whether to include share-upload events. Off for clients who can't see the UPLOADS area. Default true. */
  includeUploads?: boolean
  /** Zero-based index into the merged+grouped list (for infinite scroll). Default 0. */
  offset?: number
  /** Page size. Default 30. */
  limit?: number
}

export interface ProjectActivityPage {
  events: ProjectActivityEvent[]
  hasMore: boolean
}

// Raw rows fetched per source before grouping. Grouping only shrinks the set,
// so this bounds query cost while keeping bulk uploads intact.
const RAW_TAKE = 300
// Hard ceiling on the merged feed. Pagination windows into this; older activity
// beyond it is not scrollable (this is a feed, not an audit log).
const MAX_EVENTS = 300
const DEFAULT_LIMIT = 30
// Gap between successive items that starts a new grouped bucket.
const GROUP_GAP_MS = 10 * 60 * 1000
// Window for suppressing the implicit sibling unapproval that accompanies
// approving a different version of the same video.
const APPROVAL_SWAP_WINDOW_MS = 60 * 1000

interface RawActorRef {
  userId: string | null
  recipientId: string | null
  name: string | null
  color?: string | null
}

/**
 * Resolve an event's actor for display.
 * `defaultKind` is the actor type for rows with no stored attribution (e.g. videos
 * uploaded before the attribution migration): 'USER' for admin-only actions
 * (videos/albums/photos — clients can never do these), 'RECIPIENT' otherwise.
 */
function resolveActor(
  raw: RawActorRef,
  audience: ProjectActivityAudience,
  defaultKind: 'USER' | 'RECIPIENT' = 'RECIPIENT',
): ProjectActivityActor {
  const kind: ProjectActivityActor['kind'] = raw.userId
    ? 'USER'
    : raw.recipientId
      ? 'RECIPIENT'
      : defaultKind
  const generic = kind === 'USER' ? 'Admin' : 'Client'
  if (audience === 'guest') {
    // Guests only learn admin-vs-client, never names — and never a userId that would let
    // them fetch an admin's avatar image and identify them.
    return { name: generic, kind, color: raw.color ?? null, userId: null, named: false }
  }
  const realName = (raw.name && raw.name.trim()) || ''
  return {
    name: realName || generic,
    kind,
    color: raw.color ?? null,
    // Only admin users have avatar images; recipients fall back to initials.
    userId: kind === 'USER' ? raw.userId ?? null : null,
    named: realName.length > 0,
  }
}

function actorGroupKey(raw: RawActorRef): string {
  return raw.userId || raw.recipientId || raw.name || '?'
}

// Single-line, tag-stripped, whitespace-collapsed preview of a comment body.
const COMMENT_PREVIEW_MAX = 140
function commentPreview(content: string | null | undefined): string | undefined {
  if (!content) return undefined
  const flat = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > COMMENT_PREVIEW_MAX ? `${flat.slice(0, COMMENT_PREVIEW_MAX - 1).trimEnd()}…` : flat
}

/** Group time-sorted rows into buckets split on gaps larger than GROUP_GAP_MS. */
function bucketByGap<T extends { createdAt: Date }>(rowsAsc: T[]): T[][] {
  const buckets: T[][] = []
  let current: T[] = []
  let prev: number | null = null
  for (const row of rowsAsc) {
    const t = row.createdAt.getTime()
    if (prev !== null && t - prev > GROUP_GAP_MS) {
      buckets.push(current)
      current = []
    }
    current.push(row)
    prev = t
  }
  if (current.length > 0) buckets.push(current)
  return buckets
}

export async function buildProjectActivity(
  projectId: string,
  options: BuildProjectActivityOptions,
): Promise<ProjectActivityPage> {
  const { audience, includeComments } = options
  const includeUploads = options.includeUploads ?? true
  const offset = Math.max(0, options.offset ?? 0)
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT)
  const clientVisible = audience !== 'admin'

  const [videos, comments, albums, albumPhotos, uploadFiles, uploadFolders] = await Promise.all([
    prisma.video.findMany({
      where: {
        projectId,
        ...(clientVisible ? { status: 'READY' as const } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: RAW_TAKE,
      select: {
        id: true,
        name: true,
        version: true,
        versionLabel: true,
        createdAt: true,
        uploadedById: true,
        uploadedByName: true,
        approved: true,
        approvedAt: true,
        approvedById: true,
        approvedByRecipientId: true,
        approvedByName: true,
        unapprovedAt: true,
        unapprovedById: true,
        unapprovedByRecipientId: true,
        unapprovedByName: true,
      },
    }),
    includeComments
      ? prisma.comment.findMany({
          where: {
            projectId,
            // Explicit hard filter on the client path — internal comments must never
            // reach the share surface (defense in depth against past leak patterns).
            ...(clientVisible ? { isInternal: false, video: { status: 'READY' as const } } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: RAW_TAKE,
          select: {
            id: true,
            createdAt: true,
            content: true,
            authorName: true,
            userId: true,
            recipientId: true,
            displayColorSnapshot: true,
            user: { select: { name: true, displayColor: true } },
            recipient: { select: { name: true, displayColor: true } },
            video: { select: { id: true, name: true, versionLabel: true } },
          },
        })
      : Promise.resolve([] as never[]),
    prisma.album.findMany({
      where: {
        projectId,
        ...(clientVisible ? { status: 'READY' as const } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: RAW_TAKE,
      select: {
        id: true,
        name: true,
        createdAt: true,
        createdById: true,
        createdByName: true,
      },
    }),
    prisma.albumPhoto.findMany({
      where: {
        album: { projectId, ...(clientVisible ? { status: 'READY' as const } : {}) },
        ...(clientVisible ? { status: 'READY' as const } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: RAW_TAKE,
      select: {
        id: true,
        albumId: true,
        fileName: true,
        createdAt: true,
        uploadedBy: true,
        uploadedByName: true,
        album: { select: { name: true } },
      },
    }),
    prisma.shareUploadFile.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: includeUploads ? RAW_TAKE : 0,
      select: {
        id: true,
        fileName: true,
        folderRelativePath: true,
        createdAt: true,
        uploadedById: true,
        uploadedByRecipientId: true,
        uploadedByName: true,
      },
    }),
    prisma.shareUploadFolder.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: includeUploads ? RAW_TAKE : 0,
      select: {
        id: true,
        relativePath: true,
        folderName: true,
        createdAt: true,
        createdById: true,
        createdByRecipientId: true,
        createdByName: true,
      },
    }),
  ])

  const events: ProjectActivityEvent[] = []

  // --- Videos: added / new version -------------------------------------------------
  for (const video of videos) {
    events.push({
      id: `video:${video.id}`,
      type: video.version === 1 ? 'VIDEO_ADDED' : 'VIDEO_VERSION_ADDED',
      timestamp: video.createdAt.toISOString(),
      actor: resolveActor(
        { userId: video.uploadedById, recipientId: null, name: video.uploadedByName },
        audience,
        'USER', // videos are admin-only; old rows with no attribution → 'Admin'
      ),
      target: { videoId: video.id, videoName: video.name, versionLabel: video.versionLabel },
    })
  }

  // --- Video approvals / unapprovals ------------------------------------------------
  type ApprovalEvent = ProjectActivityEvent & { _actorKey: string; _videoName: string }
  const approvalEvents: ApprovalEvent[] = []
  for (const video of videos) {
    if (video.approved && video.approvedAt) {
      const raw: RawActorRef = {
        userId: video.approvedById,
        recipientId: video.approvedByRecipientId,
        name: video.approvedByName,
      }
      approvalEvents.push({
        id: `video-approved:${video.id}`,
        type: 'VIDEO_APPROVED',
        timestamp: video.approvedAt.toISOString(),
        actor: resolveActor(raw, audience),
        target: { videoId: video.id, videoName: video.name, versionLabel: video.versionLabel },
        _actorKey: actorGroupKey(raw),
        _videoName: video.name,
      })
    }
    if (video.unapprovedAt) {
      const raw: RawActorRef = {
        userId: video.unapprovedById,
        recipientId: video.unapprovedByRecipientId,
        name: video.unapprovedByName,
      }
      approvalEvents.push({
        id: `video-unapproved:${video.id}`,
        type: 'VIDEO_UNAPPROVED',
        timestamp: video.unapprovedAt.toISOString(),
        actor: resolveActor(raw, audience),
        target: { videoId: video.id, videoName: video.name, versionLabel: video.versionLabel },
        _actorKey: actorGroupKey(raw),
        _videoName: video.name,
      })
    }
  }
  // Sibling-swap dedupe: approving a different version implicitly unapproves the
  // previous one in the same transaction — one "approved" entry tells the story.
  const dedupedApprovals = approvalEvents.filter((event) => {
    if (event.type !== 'VIDEO_UNAPPROVED') return true
    const t = Date.parse(event.timestamp)
    return !approvalEvents.some(
      (other) =>
        other.type === 'VIDEO_APPROVED' &&
        other._videoName === event._videoName &&
        other._actorKey === event._actorKey &&
        Math.abs(Date.parse(other.timestamp) - t) <= APPROVAL_SWAP_WINDOW_MS,
    )
  })
  for (const { _actorKey: _a, _videoName: _v, ...event } of dedupedApprovals) {
    events.push(event)
  }

  // --- Comments ---------------------------------------------------------------------
  for (const comment of comments) {
    const raw: RawActorRef = {
      userId: comment.userId,
      recipientId: comment.recipientId,
      name: comment.user?.name || comment.recipient?.name || comment.authorName,
      color:
        comment.user?.displayColor ||
        comment.recipient?.displayColor ||
        comment.displayColorSnapshot ||
        null,
    }
    events.push({
      id: `comment:${comment.id}`,
      type: 'COMMENT_ADDED',
      timestamp: comment.createdAt.toISOString(),
      actor: resolveActor(raw, audience),
      target: {
        videoId: comment.video?.id,
        videoName: comment.video?.name,
        versionLabel: comment.video?.versionLabel,
        commentPreview: commentPreview(comment.content),
      },
    })
  }

  // --- Albums -----------------------------------------------------------------------
  for (const album of albums) {
    events.push({
      id: `album:${album.id}`,
      type: 'ALBUM_ADDED',
      timestamp: album.createdAt.toISOString(),
      actor: resolveActor(
        { userId: album.createdById, recipientId: null, name: album.createdByName },
        audience,
        'USER', // albums are admin-only
      ),
      target: { albumId: album.id, albumName: album.name },
    })
  }

  // --- Album photos: grouped by album + uploader + time window -----------------------
  {
    const byKey = new Map<string, typeof albumPhotos>()
    for (const photo of albumPhotos) {
      const key = `${photo.albumId}|${photo.uploadedBy || photo.uploadedByName || '?'}`
      const list = byKey.get(key)
      if (list) list.push(photo)
      else byKey.set(key, [photo])
    }
    for (const list of byKey.values()) {
      const asc = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      for (const bucket of bucketByGap(asc)) {
        const last = bucket[bucket.length - 1]
        events.push({
          id: `photos:${last.albumId}:${last.id}`,
          type: 'PHOTOS_ADDED',
          timestamp: last.createdAt.toISOString(),
          actor: resolveActor(
            { userId: last.uploadedBy, recipientId: null, name: last.uploadedByName },
            audience,
            'USER', // album photos are admin-uploaded
          ),
          count: bucket.length,
          target: {
            albumId: last.albumId,
            albumName: last.album?.name,
            sampleFileNames: bucket.slice(0, 3).map((p) => p.fileName),
          },
        })
      }
    }
  }

  // --- Share uploads: files grouped by uploader + time window ------------------------
  // Folder creations that fall inside an uploads bucket by the same actor are absorbed.
  const uploadBucketRanges: Array<{ actorKey: string; start: number; end: number }> = []
  {
    const byActor = new Map<string, typeof uploadFiles>()
    for (const file of uploadFiles) {
      const key = actorGroupKey({
        userId: file.uploadedById,
        recipientId: file.uploadedByRecipientId,
        name: file.uploadedByName,
      })
      const list = byActor.get(key)
      if (list) list.push(file)
      else byActor.set(key, [file])
    }
    for (const [actorKey, list] of byActor.entries()) {
      const asc = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      for (const bucket of bucketByGap(asc)) {
        const first = bucket[0]
        const last = bucket[bucket.length - 1]
        uploadBucketRanges.push({
          actorKey,
          start: first.createdAt.getTime() - GROUP_GAP_MS,
          end: last.createdAt.getTime() + GROUP_GAP_MS,
        })
        events.push({
          id: `uploads:${last.id}`,
          type: 'UPLOADS_ADDED',
          timestamp: last.createdAt.toISOString(),
          actor: resolveActor(
            {
              userId: last.uploadedById,
              recipientId: last.uploadedByRecipientId,
              name: last.uploadedByName,
            },
            audience,
          ),
          count: bucket.length,
          target: {
            folderPath: last.folderRelativePath || undefined,
            sampleFileNames: bucket.slice(0, 3).map((f) => f.fileName),
          },
        })
      }
    }
  }

  for (const folder of uploadFolders) {
    const actorKey = actorGroupKey({
      userId: folder.createdById,
      recipientId: folder.createdByRecipientId,
      name: folder.createdByName,
    })
    const t = folder.createdAt.getTime()
    const absorbed = uploadBucketRanges.some(
      (range) => range.actorKey === actorKey && t >= range.start && t <= range.end,
    )
    if (absorbed) continue
    events.push({
      id: `upload-folder:${folder.id}`,
      type: 'UPLOAD_FOLDER_ADDED',
      timestamp: folder.createdAt.toISOString(),
      actor: resolveActor(
        {
          userId: folder.createdById,
          recipientId: folder.createdByRecipientId,
          name: folder.createdByName,
        },
        audience,
      ),
      target: { folderPath: folder.relativePath || folder.folderName },
    })
  }

  events.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
  // Grouping is computed over the whole window on every call, so paginating by
  // slicing this stable list is safe (no split/duplicate buckets across pages).
  const bounded = events.slice(0, MAX_EVENTS)
  return {
    events: bounded.slice(offset, offset + limit),
    hasMore: bounded.length > offset + limit,
  }
}
