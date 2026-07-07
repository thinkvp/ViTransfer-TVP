'use client'

import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  Video,
  FilePlus2,
  MessageSquare,
  Images,
  Image as ImageIcon,
  FolderUp,
  FolderPlus,
  CheckCircle2,
  XCircle,
  Activity,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import { cn, formatDateTime } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'

type ActivityEventType =
  | 'VIDEO_ADDED'
  | 'VIDEO_VERSION_ADDED'
  | 'VIDEO_APPROVED'
  | 'VIDEO_UNAPPROVED'
  | 'COMMENT_ADDED'
  | 'ALBUM_ADDED'
  | 'PHOTOS_ADDED'
  | 'UPLOADS_ADDED'
  | 'UPLOAD_FOLDER_ADDED'

interface ActivityEvent {
  id: string
  type: ActivityEventType
  timestamp: string
  actor: {
    name: string
    kind: 'USER' | 'RECIPIENT' | 'UNKNOWN'
    color: string | null
    userId?: string | null
    named?: boolean
  }
  count?: number
  target: {
    videoId?: string
    videoName?: string
    versionLabel?: string
    albumId?: string
    albumName?: string
    folderPath?: string
    sampleFileNames?: string[]
    commentPreview?: string
  }
}

export interface ProjectActivityOpenTarget {
  videoId?: string
  videoName?: string
  albumId?: string
  albumName?: string
  /** Present for uploads entries: open this UPLOADS folder (undefined path = UPLOADS root). */
  uploads?: { folderPath?: string }
}

interface ProjectActivityPanelProps {
  fetchUrl: string
  authToken?: string | null
  className?: string
  /** Called when a video/album/uploads entry is clicked, to open that target. */
  onOpenTarget?: (target: ProjectActivityOpenTarget) => void
}

const EVENT_ICONS: Record<ActivityEventType, typeof Video> = {
  VIDEO_ADDED: Video,
  VIDEO_VERSION_ADDED: FilePlus2,
  VIDEO_APPROVED: CheckCircle2,
  VIDEO_UNAPPROVED: XCircle,
  COMMENT_ADDED: MessageSquare,
  ALBUM_ADDED: ImageIcon,
  PHOTOS_ADDED: Images,
  UPLOADS_ADDED: FolderUp,
  UPLOAD_FOLDER_ADDED: FolderPlus,
}

const EVENT_ICON_CLASSES: Partial<Record<ActivityEventType, string>> = {
  VIDEO_APPROVED: 'text-green-500',
  VIDEO_UNAPPROVED: 'text-destructive',
}

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diffMs = Date.now() - t
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDateTime(iso)
}

// Bold, like actor names, for entity names (videos, albums, folders).
function Name({ children }: { children: ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>
}

// Version-label pill, matching the dashboard Feedback list styling.
function VersionPill({ label }: { label: string }) {
  return (
    <span className="ml-1 inline-block shrink-0 rounded bg-secondary px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-secondary-foreground">
      {label}
    </span>
  )
}

function videoTarget(event: ActivityEvent): ReactNode {
  return (
    <>
      <Name>{event.target.videoName || 'a video'}</Name>
      {event.target.versionLabel ? <VersionPill label={event.target.versionLabel} /> : null}
    </>
  )
}

function eventDescription(event: ActivityEvent): ReactNode {
  switch (event.type) {
    case 'VIDEO_ADDED':
      return <>added video {videoTarget(event)}</>
    case 'VIDEO_VERSION_ADDED':
      return (
        <>
          added a new version of <Name>{event.target.videoName || 'a video'}</Name>
          {event.target.versionLabel ? <VersionPill label={event.target.versionLabel} /> : null}
        </>
      )
    case 'VIDEO_APPROVED':
      return <>approved {videoTarget(event)}</>
    case 'VIDEO_UNAPPROVED':
      return <>removed approval from {videoTarget(event)}</>
    case 'COMMENT_ADDED':
      return <>commented on {videoTarget(event)}</>
    case 'ALBUM_ADDED':
      return <>added album <Name>{event.target.albumName || ''}</Name></>
    case 'PHOTOS_ADDED': {
      const count = event.count || 1
      return (
        <>
          added {count} {count === 1 ? 'photo' : 'photos'}
          {event.target.albumName ? <> to <Name>{event.target.albumName}</Name></> : null}
        </>
      )
    }
    case 'UPLOADS_ADDED': {
      const count = event.count || 1
      return (
        <>
          uploaded {count} {count === 1 ? 'file' : 'files'}
          {event.target.folderPath ? <> to <Name>{event.target.folderPath}</Name></> : null}
        </>
      )
    }
    case 'UPLOAD_FOLDER_ADDED':
      return <>created folder <Name>{event.target.folderPath || ''}</Name></>
    default:
      return 'did something'
  }
}

// Minimum gap between refetches triggered by focus/visibility/interval events.
const MIN_REFRESH_GAP_MS = 45_000
const POLL_INTERVAL_MS = 2 * 60_000

const PAGE_SIZE = 30

// What a click on this event should open, if anything.
function openTargetFor(event: ActivityEvent): ProjectActivityOpenTarget | null {
  if (event.target.albumId) {
    return { albumId: event.target.albumId, albumName: event.target.albumName }
  }
  if (event.target.videoId) {
    return { videoId: event.target.videoId, videoName: event.target.videoName }
  }
  if (event.type === 'UPLOADS_ADDED' || event.type === 'UPLOAD_FOLDER_ADDED') {
    return { uploads: { folderPath: event.target.folderPath } }
  }
  return null
}

export function ProjectActivityPanel({ fetchUrl, authToken, className, onOpenTarget }: ProjectActivityPanelProps) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastRefreshRef = useRef(0)
  const fetchInFlightRef = useRef(false)
  // Mirrors of state for use inside stable callbacks without re-creating them.
  const loadedCountRef = useRef(0)
  const hasMoreRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { loadedCountRef.current = events?.length ?? 0 }, [events])
  useEffect(() => { hasMoreRef.current = hasMore }, [hasMore])

  const fetchPage = useCallback(
    async (offset: number, limit: number): Promise<{ events: ActivityEvent[]; hasMore: boolean }> => {
      // apiFetch attaches the admin bearer token (with refresh) when present;
      // an explicit share-token Authorization header takes precedence.
      const headers: Record<string, string> = {}
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`
      const sep = fetchUrl.includes('?') ? '&' : '?'
      const response = await apiFetch(`${fetchUrl}${sep}offset=${offset}&limit=${limit}`, {
        headers,
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`Failed to load activity (${response.status})`)
      const data = await response.json()
      return {
        events: Array.isArray(data?.events) ? data.events : [],
        hasMore: Boolean(data?.hasMore),
      }
    },
    [fetchUrl, authToken],
  )

  // Re-fetch the currently-shown window from the top (picks up new/removed events
  // without collapsing how far the user has scrolled). Throttled unless forced.
  const refresh = useCallback(async (force: boolean) => {
    const now = Date.now()
    if (fetchInFlightRef.current) return
    if (!force && now - lastRefreshRef.current < MIN_REFRESH_GAP_MS) return
    fetchInFlightRef.current = true
    lastRefreshRef.current = now
    try {
      const limit = Math.max(loadedCountRef.current, PAGE_SIZE)
      const page = await fetchPage(0, limit)
      setEvents(page.events)
      setHasMore(page.hasMore)
      setError(null)
    } catch (e) {
      // Keep any previously loaded events visible; only surface the error on first load.
      setError((prev) => prev ?? (e instanceof Error ? e.message : 'Failed to load activity'))
    } finally {
      fetchInFlightRef.current = false
    }
  }, [fetchPage])

  // Append the next page (infinite scroll), de-duping by id in case the live list
  // shifted between pages.
  const loadMore = useCallback(async () => {
    if (fetchInFlightRef.current || !hasMoreRef.current) return
    fetchInFlightRef.current = true
    try {
      const page = await fetchPage(loadedCountRef.current, PAGE_SIZE)
      setEvents((prev) => {
        const base = prev ?? []
        const seen = new Set(base.map((e) => e.id))
        return [...base, ...page.events.filter((e) => !seen.has(e.id))]
      })
      setHasMore(page.hasMore)
    } catch {
      // Leave the loaded events in place; the sentinel stays and can retry on scroll.
    } finally {
      fetchInFlightRef.current = false
    }
  }, [fetchPage])

  useEffect(() => {
    void refresh(true)

    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') void refresh(false)
    }
    const onApprovalChanged = () => void refresh(true)
    window.addEventListener('focus', onFocusOrVisible)
    document.addEventListener('visibilitychange', onFocusOrVisible)
    window.addEventListener('videoApprovalChanged', onApprovalChanged)
    const interval = window.setInterval(() => void refresh(false), POLL_INTERVAL_MS)
    return () => {
      window.removeEventListener('focus', onFocusOrVisible)
      document.removeEventListener('visibilitychange', onFocusOrVisible)
      window.removeEventListener('videoApprovalChanged', onApprovalChanged)
      window.clearInterval(interval)
    }
  }, [refresh])

  // Infinite scroll: load the next page when the bottom sentinel nears the viewport.
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = scrollRef.current
    if (!sentinel || !root || !hasMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { root, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadMore])

  return (
    <Card
      className={cn(
        'bg-card border border-border flex flex-col h-full flex-1 min-h-0 rounded-lg overflow-hidden',
        className,
      )}
      data-project-activity
    >
      <CardHeader className="px-4 py-3 border-b border-border shrink-0 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base min-h-9">
          <Activity className="w-4 h-4" />
          Project Activity
        </CardTitle>
      </CardHeader>
      <CardContent ref={scrollRef} className="flex-1 p-0! overflow-y-auto min-h-0 bg-muted/70">
        {events === null && !error && (
          <div className="p-6 text-sm text-muted-foreground">Loading activity…</div>
        )}
        {events === null && error && (
          <div className="p-6 text-sm text-muted-foreground">Unable to load activity.</div>
        )}
        {events !== null && events.length === 0 && (
          <div className="p-6 text-sm text-muted-foreground">No activity yet.</div>
        )}
        {events !== null && events.length > 0 && (
          <>
            <ul className="divide-y divide-border">
              {events.map((event) => {
                const Icon = EVENT_ICONS[event.type] || Activity
                const openTarget = onOpenTarget ? openTargetFor(event) : null
                return (
                  <li key={event.id}>
                    <div
                      className={cn(
                        'flex items-start gap-3 px-4 py-3',
                        openTarget && 'cursor-pointer hover:bg-muted transition-colors',
                      )}
                      {...(openTarget
                        ? {
                            role: 'button' as const,
                            tabIndex: 0,
                            onClick: () => onOpenTarget?.(openTarget),
                            onKeyDown: (e: ReactKeyboardEvent) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                onOpenTarget?.(openTarget)
                              }
                            },
                          }
                        : {})}
                    >
                      {event.actor.named ? (
                        // Named person → identity avatar (photo or colour-tinted initials), with a
                        // small event-type badge so the action ("commented"/"approved"/…) stays scannable.
                        <div className="relative shrink-0 mt-0.5">
                          <InitialsAvatar
                            name={event.actor.name}
                            displayColor={event.actor.color}
                            avatarUrl={
                              event.actor.userId ? `/api/users/${event.actor.userId}/avatar` : null
                            }
                            className="h-7 w-7 text-[11px]"
                            title={event.actor.name}
                          />
                          <span
                            className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-card"
                            aria-hidden
                          >
                            <Icon
                              className={cn('h-2.5 w-2.5 text-muted-foreground', EVENT_ICON_CLASSES[event.type])}
                            />
                          </span>
                        </div>
                      ) : (
                        // Generic "Admin"/"Client" or unattributed → event-type icon, boxed to the
                        // same footprint as an avatar so the text column stays aligned across rows.
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
                          <Icon
                            className={cn('h-4 w-4 text-muted-foreground', EVENT_ICON_CLASSES[event.type])}
                          />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-snug break-words">
                          <span className="font-medium">{event.actor.name}</span>{' '}
                          <span className="text-foreground/90">{eventDescription(event)}</span>
                        </p>
                        {event.type === 'COMMENT_ADDED' && event.target.commentPreview && (
                          <p
                            className="text-xs text-foreground mt-1.5 rounded-md border border-border bg-accent px-2.5 py-1.5 shadow-sm line-clamp-3"
                            title={event.target.commentPreview}
                          >
                            {event.target.commentPreview}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1" title={formatDateTime(event.timestamp)}>
                          {formatRelativeTime(event.timestamp)}
                        </p>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
            {hasMore && (
              <div ref={sentinelRef} className="p-4 text-center text-xs text-muted-foreground">
                Loading more…
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
