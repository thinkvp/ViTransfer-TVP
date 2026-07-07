'use client'

import { useEffect, useRef, useState } from 'react'
import { Eye, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { apiFetch } from '@/lib/api-client'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

type ClientActivityRow = {
  sessionId: string
  projectId: string
  projectTitle: string | null
  videoId: string | null
  videoName: string | null
  versionLabel: string | null
  albumId: string | null
  albumName: string | null
  assetId: string | null
  assetName: string | null
  activityType: 'VIEWING_SHARE_PAGE' | 'VIEWING_ALBUM' | 'STREAMING_VIDEO' | 'DOWNLOADING_VIDEO' | 'DOWNLOADING_ASSET'
  accessMethod: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE' | null
  email: string | null
  ipAddress: string | null
  firstSeenAt: string
  updatedAt: string
}

function formatRelativeTime(value: string): string {
  const deltaSeconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000))
  if (deltaSeconds < 5) return 'just now'
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`
  const deltaMinutes = Math.floor(deltaSeconds / 60)
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`
  const deltaHours = Math.floor(deltaMinutes / 60)
  if (deltaHours < 24) return `${deltaHours}h ago`
  const deltaDays = Math.floor(deltaHours / 24)
  return `${deltaDays}d ago`
}

function getActivityLabel(activity: ClientActivityRow): string {
  switch (activity.activityType) {
    case 'VIEWING_SHARE_PAGE':
      return 'Viewing share page'
    case 'VIEWING_ALBUM':
      return 'Browsing album'
    case 'STREAMING_VIDEO':
      return 'Streaming video'
    case 'DOWNLOADING_VIDEO':
      return 'Downloading video'
    case 'DOWNLOADING_ASSET':
      return 'Downloading asset'
    default:
      return 'Active'
  }
}

// The project is always the header line, shown exactly once.
function getProjectLabel(activity: ClientActivityRow): string {
  return activity.projectTitle || 'Client activity'
}

// The specific thing being viewed/streamed/downloaded, shown as a line under the
// project. Returns null when there's nothing more specific than the project itself
// (e.g. just viewing the share page). When the video/folder shares the project's
// name, the name is dropped so it isn't echoed — the version (if any) still shows.
function getContextLabel(activity: ClientActivityRow): { name: string | null; version: string | null } | null {
  let name: string | null = null
  let version: string | null = null

  if (activity.activityType === 'DOWNLOADING_ASSET') {
    name = activity.assetName
  } else if (activity.activityType === 'VIEWING_ALBUM') {
    name = activity.albumName
  } else if (activity.activityType === 'STREAMING_VIDEO' || activity.activityType === 'DOWNLOADING_VIDEO') {
    name = activity.videoName
    version = activity.versionLabel || null
  }

  if (name && name === activity.projectTitle) name = null
  if (!name && !version) return null
  return { name, version }
}

// Session identity only — the project now owns the header line, so it's dropped here.
function getMetaLabel(activity: ClientActivityRow): string {
  return [activity.email, activity.accessMethod]
    .filter((value): value is string => !!value)
    .join(' · ')
}

function ActivityRow({ activity, onNavigate }: { activity: ClientActivityRow; onNavigate: (projectId: string) => void }) {
  const context = getContextLabel(activity)
  const meta = getMetaLabel(activity)
  return (
    <div
      className="px-4 py-3 cursor-pointer hover:bg-accent/40 transition-colors"
      onClick={() => onNavigate(activity.projectId)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="min-w-0 truncate text-sm font-medium text-foreground">{getProjectLabel(activity)}</div>
          {context ? (
            <div className="flex min-w-0 items-baseline gap-2 text-[12px]">
              {context.name ? (
                <span className="min-w-0 truncate text-foreground/90">{context.name}</span>
              ) : null}
              {context.version ? (
                <span className="shrink-0 rounded border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                  {context.name ? context.version : `Version ${context.version}`}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex h-2 w-2 rounded-full bg-primary" />
            <span>{getActivityLabel(activity)}</span>
            <span>{formatRelativeTime(activity.updatedAt)}</span>
          </div>
          {meta ? (
            <div className="truncate text-[11px] text-muted-foreground">{meta}</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default function ClientActivityEye() {
  const router = useRouter()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [activities, setActivities] = useState<ClientActivityRow[]>([])
  const pollInFlightRef = useRef(false)

  useEffect(() => {
    let active = true

    async function poll() {
      if (pollInFlightRef.current) return
      pollInFlightRef.current = true
      try {
        const res = await apiFetch('/api/client-activity')
        if (!res.ok) return
        const data = await res.json()
        if (!active) return
        setActivities(Array.isArray(data.activities) ? data.activities : [])
      } catch {
        if (active) {
          setActivities([])
        }
      } finally {
        pollInFlightRef.current = false
        if (active) {
          setLoading(false)
        }
      }
    }

    poll()
    const interval = setInterval(poll, open ? 5_000 : 15_000)

    return () => {
      active = false
      clearInterval(interval)
    }
  }, [open])

  function handleNavigate(projectId: string) {
    setOpen(false)
    router.push(`/admin/projects/${projectId}`)
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) {
          window.setTimeout(() => triggerRef.current?.blur(), 0)
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          size="icon"
          aria-label="Client Activity"
          title="Client Activity"
          className="relative p-2 w-9 sm:w-10 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground data-[state=open]:border-primary/50"
        >
          <Eye className="h-4 w-4 sm:h-5 sm:w-5" />
          {activities.length > 0 ? (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] leading-[18px] text-center">
              {activities.length > 99 ? '99+' : activities.length}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={8}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="p-0! w-[92vw] sm:w-[400px] max-w-[92vw] max-h-[70dvh] overflow-hidden data-[state=open]:animate-none! data-[state=closed]:animate-none!"
      >
        <div className="flex flex-col max-h-[70dvh]">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">Client Activity</div>
              <div className="text-[11px] text-muted-foreground">Sessions active in the last 2 minutes</div>
            </div>
            {activities.length > 0 ? (
              <div className="text-xs text-muted-foreground">{activities.length} live</div>
            ) : null}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {loading ? (
              <div className="p-6 text-sm text-muted-foreground flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading activity…
              </div>
            ) : activities.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No active client activity.
              </div>
            ) : (
              <div className={cn('divide-y divide-border')}>
                {activities.map((activity) => (
                  <ActivityRow key={activity.sessionId} activity={activity} onNavigate={handleNavigate} />
                ))}
              </div>
            )}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}