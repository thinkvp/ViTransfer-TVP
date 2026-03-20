'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Video, Eye, Download, ArrowLeft, Mail, Users, KeyRound, Play, ArrowUpDown, Images, Cloud } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { projectStatusBadgeClass, projectStatusLabel } from '@/lib/project-status'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'

interface VideoStats {
  videoName: string
  totalViews: number
  totalDownloads: number
  versions: Array<{
    id: string
    versionLabel: string
    views: number
    downloads: number
    assets?: Array<{
      id: string
      fileName: string
      downloads: number
    }>
  }>
}

interface AlbumStats {
  albumName: string
  photoCount: number
  fullResDownloads: number
  socialDownloads: number
}

interface AuthActivity {
  id: string
  type: 'AUTH'
  eventType: 'ACCESS' | 'SWITCH_AWAY'
  accessMethod: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE'
  email: string | null
  originProjectTitle: string | null
  targetProjectTitle: string | null
  ipAddress: string | null
  createdAt: Date
}

interface DownloadActivity {
  id: string
  type: 'DOWNLOAD'
  eventType: 'DOWNLOAD_COMPLETE' | 'DOWNLOAD_SUCCEEDED' | 'DOWNLOAD_FAILED'
  videoName: string
  versionLabel: string
  assetId?: string | null
  assetIds?: string[]
  assetFileName?: string
  assetFileNames?: string[]
  averageMbps?: number | null
  bytesTransferred?: number | null
  durationMs?: number | null
  fromDropbox?: boolean
  email?: string | null
  accessMethod?: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE' | null
  ipAddress: string | null
  createdAt: Date
}

interface AlbumDownloadActivity {
  id: string
  type: 'ALBUM_DOWNLOAD'
  albumName: string
  variant: string | null
  fromDropbox?: boolean
  email?: string | null
  accessMethod?: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE' | null
  ipAddress: string | null
  createdAt: Date
}

interface PhotoDownloadActivity {
  id: string
  type: 'PHOTO_DOWNLOAD'
  albumName: string
  photoFileName: string | null
  variant: string | null
  email?: string | null
  accessMethod?: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE' | null
  ipAddress: string | null
  createdAt: Date
}

interface ViewActivity {
  id: string
  type: 'VIEW'
  videoName: string
  versionLabel: string
  email: string | null
  accessMethod: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE' | null
  ipAddress: string | null
  createdAt: Date
}

interface EmailActivity {
  id: string
  type: 'EMAIL'
  description: 'All Ready Videos' | 'Specific Video & Version' | 'Specific Album Ready' | 'Comment Summary'
  recipients: string[]
  videoName?: string
  versionLabel?: string
  createdAt: Date
}

interface EmailOpenActivity {
  id: string
  type: 'EMAIL_OPEN'
  description: 'All Ready Videos' | 'Specific Video & Version' | 'Specific Album Ready' | 'Comment Summary'
  recipientEmail: string
  videoName?: string
  versionLabel?: string
  createdAt: Date
}

interface ApprovalActivity {
  id: string
  type: 'VIDEO_APPROVED' | 'VIDEO_UNAPPROVED'
  videoName: string
  versionLabel: string
  email: string | null
  accessMethod: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE' | null
  ipAddress: string | null
  createdAt: Date
}

interface StatusChangeActivity {
  id: string
  type: 'STATUS_CHANGE'
  previousStatus: string
  currentStatus: string
  source: 'ADMIN' | 'CLIENT' | 'SYSTEM'
  changedBy: { id: string; name: string | null; email: string } | null
  createdAt: Date
}

type Activity = AuthActivity | DownloadActivity | EmailActivity | EmailOpenActivity | StatusChangeActivity
  | ViewActivity | ApprovalActivity | AlbumDownloadActivity | PhotoDownloadActivity

function getAuthVisitorLabel(event: AuthActivity): string {
  if (event.email) return event.email
  if (event.accessMethod === 'GUEST') return 'Guest User'
  if (event.accessMethod === 'PASSWORD') return 'Password User'
  if (event.accessMethod === 'OTP') return 'Email OTP User'
  return 'Public User'
}

function getStatusChangeActor(event: StatusChangeActivity): string {
  if (event.source === 'SYSTEM') return 'System'
  if (event.source === 'CLIENT') return 'Client'
  const actor = event.changedBy
  if (!actor) return 'Admin'
  return actor.email ?? actor.name ?? 'Admin'
}

function getEventMetaValue(event: Activity): string {
  if (event.type === 'STATUS_CHANGE') return getStatusChangeActor(event)
  if (event.type === 'EMAIL_OPEN') return event.recipientEmail
  if (event.type === 'AUTH') return event.ipAddress || '—'
  if (event.type === 'DOWNLOAD') return event.email || event.ipAddress || '—'
  if (event.type === 'ALBUM_DOWNLOAD') return event.email || event.ipAddress || '—'
  if (event.type === 'PHOTO_DOWNLOAD') return event.email || event.ipAddress || '—'
  if (event.type === 'VIEW') {
    if (event.accessMethod === 'OTP' && event.email) return event.email
    return event.ipAddress || '—'
  }
  if (event.type === 'VIDEO_APPROVED' || event.type === 'VIDEO_UNAPPROVED') {
    return event.email || event.ipAddress || '—'
  }
  return '—'
}

function getEmailActionLabel(description: EmailActivity['description'], action: 'sent' | 'opened'): string {
  return `${description} email ${action}`
}

function isIpAddress(value: string): boolean {
  if (!value) return false
  if (value.includes(':')) return true
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value)
}

function hasExpandableDetails(event: Activity): boolean {
  if (event.type === 'AUTH') return false
  if (event.type === 'STATUS_CHANGE') return false
  if (event.type === 'VIDEO_APPROVED' || event.type === 'VIDEO_UNAPPROVED') return false
  if (event.type === 'ALBUM_DOWNLOAD' || event.type === 'PHOTO_DOWNLOAD') return false
  if (event.type === 'DOWNLOAD') {
    return Boolean(event.assetFileNames && event.assetFileNames.length > 0)
  }
  if (event.type === 'EMAIL') {
    return Boolean(event.videoName) || Boolean(event.recipients && event.recipients.length > 0)
  }
  if (event.type === 'EMAIL_OPEN') return Boolean(event.videoName)
  if (event.type === 'VIEW') return Boolean(event.email) && event.accessMethod !== 'OTP'
  return true
}

function getViewVisitorLabel(event: ViewActivity): string {
  if (event.email) return event.email
  if (event.accessMethod === 'GUEST') return 'Guest User'
  if (event.accessMethod === 'PASSWORD') return 'Password User'
  if (event.accessMethod === 'OTP') return 'Email OTP User'
  if (event.accessMethod === 'NONE') return 'Public User'
  return 'Guest User'
}

function getPhotoVariantLabel(variant?: string | null): string {
  return variant === 'social' ? 'Social Media Sized' : 'Full Resolution'
}

function formatDownloadSpeed(value?: number | null): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return value >= 100 ? `${value.toFixed(0)} Mbps` : `${value.toFixed(1)} Mbps`
}

function getDownloadSubject(event: DownloadActivity): string {
  if (event.assetFileName) {
    return `${event.assetFileName} from ${event.videoName} (${event.versionLabel})`
  }
  if (event.assetFileNames && event.assetFileNames.length > 0) {
    return `${event.videoName} (${event.versionLabel}) asset ZIP`
  }
  return `${event.videoName} (${event.versionLabel})`
}

function getMainText(event: Activity): string {
  if (event.type === 'AUTH') {
    if (event.eventType === 'SWITCH_AWAY' && event.targetProjectTitle) {
      return `${getAuthVisitorLabel(event)} changed to ${event.targetProjectTitle}`
    }
    return event.originProjectTitle
      ? `${getAuthVisitorLabel(event)} arrived from ${event.originProjectTitle}`
      : `${getAuthVisitorLabel(event)} accessed project`
  }
  if (event.type === 'VIEW') return `${getViewVisitorLabel(event)} viewed "${event.videoName} (${event.versionLabel})"`
  if (event.type === 'ALBUM_DOWNLOAD') return `${event.albumName} - ${getPhotoVariantLabel(event.variant)}`
  if (event.type === 'PHOTO_DOWNLOAD') return `${event.photoFileName || 'Photo'} from ${event.albumName} - ${getPhotoVariantLabel(event.variant)}`
  if (event.type === 'VIDEO_APPROVED') return `Video approved "${event.videoName} (${event.versionLabel})"`
  if (event.type === 'VIDEO_UNAPPROVED') return `Video unapproved "${event.videoName} (${event.versionLabel})"`
  if (event.type === 'EMAIL') return getEmailActionLabel(event.description, 'sent')
  if (event.type === 'EMAIL_OPEN') return getEmailActionLabel(event.description, 'opened')
  if (event.type === 'STATUS_CHANGE') return `Status changed from ${projectStatusLabel(event.previousStatus)} to ${projectStatusLabel(event.currentStatus)}`
  const dl = event as DownloadActivity
  if (dl.eventType === 'DOWNLOAD_FAILED') {
    return `${getDownloadSubject(dl)} download failed`
  }

  const speedLabel = formatDownloadSpeed(dl.averageMbps)
  if (dl.eventType === 'DOWNLOAD_SUCCEEDED' && speedLabel) {
    return `${getDownloadSubject(dl)} downloaded successfully (avg. speed ${speedLabel})`
  }
  if (dl.eventType === 'DOWNLOAD_SUCCEEDED') {
    return `${getDownloadSubject(dl)} downloaded successfully`
  }
  return `${getDownloadSubject(dl)} downloaded`
}

interface AnalyticsData {
  project: {
    id: string
    title: string
    recipientName: string
    recipientEmail: string | null
    status: string
  }
  stats: {
    totalVisits: number
    uniqueVisits: number
    guestVisits: number
    accessByMethod: {
      OTP: number
      PASSWORD: number
      GUEST: number
      NONE: number
    }
    totalDownloads: number
    totalVideoViews: number
    videoCount: number
    albumCount: number
  }
  videoStats: VideoStats[]
  albumStats: AlbumStats[]
  activity: Activity[]
}

function getAccessMethodColor(method: string): string {
  return 'bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400'
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0',
        projectStatusBadgeClass(status)
      )}
    >
      {projectStatusLabel(status)}
    </span>
  )
}

function TruncatedText({ text, className }: { text: string; className?: string }) {
  const [isTruncated, setIsTruncated] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const element = textRef.current
    if (!element) return

    const updateTruncation = () => {
      setIsTruncated(element.scrollWidth > element.clientWidth)
    }

    updateTruncation()

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateTruncation)
      observer.observe(element)
      return () => observer.disconnect()
    }

    window.addEventListener('resize', updateTruncation)
    return () => window.removeEventListener('resize', updateTruncation)
  }, [text])

  return (
    <span ref={textRef} className={className} title={isTruncated ? text : undefined}>
      {text}
    </span>
  )
}

export default function ProjectAnalyticsClient({ id }: { id: string }) {
  const { user, loading: authLoading } = useAuth()
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [activityPage, setActivityPage] = useState(1)
  const activityScrollRef = useRef<HTMLDivElement>(null)
  const [activitySortKey, setActivitySortKey] = useState<'event' | 'description' | 'by' | 'date'>('date')
  const [activitySortAsc, setActivitySortAsc] = useState(false)

  const permissions = useMemo(() => normalizeRolePermissions(user?.permissions), [user?.permissions])
  const canViewAnalytics = canDoAction(permissions, 'viewAnalytics')
  const denied = !authLoading && user && !canViewAnalytics

  useEffect(() => {
    const loadAnalytics = async () => {
      try {
        setLoading(true)
        setError(false)

        if (denied) {
          setError(true)
          return
        }

        const response = await apiFetch(`/api/analytics/${id}`)
        if (!response.ok) {
          if (response.status === 404) {
            setError(true)
          }
          throw new Error('Failed to load analytics')
        }
        const analyticsData = await response.json()
        setData(analyticsData)
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }

    }

    void loadAnalytics()
  }, [id, denied])

  const activity = useMemo(() => data?.activity ?? [], [data?.activity])
  const pageSize = 20
  const sortedActivity = useMemo(() => {
    const sorted = [...activity].sort((a, b) => {
      let cmp = 0
      switch (activitySortKey) {
        case 'event':
          cmp = String(a.type).localeCompare(String(b.type))
          break
        case 'description':
          cmp = getMainText(a).localeCompare(getMainText(b))
          break
        case 'by':
          cmp = getEventMetaValue(a).localeCompare(getEventMetaValue(b))
          break
        case 'date':
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          break
      }
      return activitySortAsc ? cmp : -cmp
    })
    return sorted
  }, [activity, activitySortKey, activitySortAsc])

  const totalPages = Math.max(1, Math.ceil(sortedActivity.length / pageSize))
  const pagedActivity = sortedActivity.slice((activityPage - 1) * pageSize, activityPage * pageSize)
  useEffect(() => {
    if (!data) return
    if (activityPage > totalPages) {
      setActivityPage(totalPages)
    }
  }, [activityPage, totalPages, data])

  useEffect(() => {
    if (activityScrollRef.current) {
      activityScrollRef.current.scrollTo({ top: 0 })
    }
  }, [activityPage])

  if (denied) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">Forbidden</p>
          <Link href="/admin/projects">
            <Button>Back to Projects</Button>
          </Link>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading analytics...</p>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">Project not found</p>
          <Link href="/admin/projects">
            <Button>Back to Projects</Button>
          </Link>
        </div>
      </div>
    )
  }

  const { project, stats, videoStats, albumStats } = data
  const metricIconWrapperClassName = 'rounded-md p-1.5 flex-shrink-0 bg-foreground/5 dark:bg-foreground/10'
  const metricIconClassName = 'w-4 h-4 text-primary'

  const hasVideos = videoStats.length > 0
  const hasAlbums = albumStats.length > 0
  const contentHeading = hasVideos && hasAlbums
    ? 'Videos & Albums'
    : hasAlbums
      ? 'Albums'
      : 'Videos'

  return (
    <div className="flex-1 sm:min-h-[calc(100dvh-var(--admin-header-height,0px))] bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6 h-auto sm:h-[calc(100dvh-var(--admin-header-height,0px))] flex flex-col">
        <div className="mb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <Link href={`/admin/projects/${project.id}`}>
              <Button variant="ghost" size="default" className="justify-start px-3 mb-2">
                <ArrowLeft className="w-4 h-4 mr-2" />
                <span className="hidden sm:inline">Back to Project</span>
                <span className="sm:hidden">Back</span>
              </Button>
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold">{project.title}</h1>
            {project.recipientName && <p className="text-muted-foreground mt-1">Client: {project.recipientName}</p>}
          </div>
        </div>

        <Card className="mb-4 sm:mb-6">
          <CardContent className="p-3 sm:p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Eye className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Total Visits</p>
                  <p className="text-base font-semibold tabular-nums truncate">{stats.totalVisits.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">{stats.guestVisits} guest visits</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Video className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Videos</p>
                  <p className="text-base font-semibold tabular-nums truncate">{stats.videoCount}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Users className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Video Views</p>
                  <p className="text-base font-semibold tabular-nums truncate">{stats.totalVideoViews.toLocaleString()}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className={metricIconWrapperClassName}>
                  <Download className={metricIconClassName} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Video Downloads</p>
                  <p className="text-base font-semibold tabular-nums truncate">{stats.totalDownloads.toLocaleString()}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:gap-6 lg:grid-cols-[30fr_70fr] sm:overflow-hidden flex-1 min-h-0">
          <Card className="overflow-hidden max-h-none sm:max-h-[calc(100dvh-var(--admin-header-height,0px))] flex flex-col">
            <CardHeader>
              <CardTitle>{contentHeading} in this Project</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-hidden flex-1 min-h-0 flex flex-col">
              {!hasVideos && !hasAlbums ? (
                <p className="text-center text-muted-foreground py-8">No videos or albums available</p>
              ) : (
                  <div className="space-y-4 overflow-y-auto min-h-0 flex-1 pr-1">
                  {videoStats.map((video) => (
                    <div key={video.videoName} className="border border-border rounded-lg bg-muted/40 p-3 sm:p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-semibold text-sm sm:text-base break-words">{video.videoName}</h4>
                          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                            {video.versions.length} version{video.versions.length !== 1 ? 's' : ''}
                          </p>
                        </div>
                      </div>

                      {video.versions.length > 0 && (
                        <div className="mt-3 pt-3 border-t">
                          <div className="space-y-1.5">
                            {video.versions.map((version) => (
                              <div key={version.id} className="space-y-1.5">
                                <div
                                  className="flex items-center justify-between gap-2 text-xs sm:text-sm bg-accent/50 rounded px-2 py-1.5"
                                >
                                  <span className="text-muted-foreground truncate">{version.versionLabel}</span>
                                  <span className="font-medium whitespace-nowrap flex-shrink-0 inline-flex items-center gap-2">
                                    <span className="inline-flex items-center gap-1">
                                      <Eye className="w-3 h-3 text-muted-foreground" />
                                      {version.views}
                                    </span>
                                    <span className="inline-flex items-center gap-1">
                                      <Download className="w-3 h-3 text-muted-foreground" />
                                      {version.downloads}
                                    </span>
                                  </span>
                                </div>
                                {version.assets && version.assets.length > 0 && (
                                  <div className="ml-4 space-y-1">
                                    {version.assets.map((asset) => (
                                      <div
                                        key={asset.id}
                                        className="flex items-center justify-between gap-2 text-[11px] sm:text-xs bg-muted/60 dark:bg-accent/30 rounded px-2 py-1"
                                      >
                                        <div className="min-w-0 flex-1">
                                          <TruncatedText
                                            text={asset.fileName}
                                            className="text-muted-foreground truncate block"
                                          />
                                        </div>
                                        <span className="inline-flex items-center gap-1 text-muted-foreground whitespace-nowrap">
                                          <Download className="w-3 h-3 text-muted-foreground" />
                                          {asset.downloads}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {albumStats.map((album) => (
                    <div key={album.albumName} className="border border-border rounded-lg bg-muted/40 p-3 sm:p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-semibold text-sm sm:text-base break-words inline-flex items-center gap-2">
                            <Images className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            {album.albumName}
                          </h4>
                          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                            {album.photoCount} photo{album.photoCount !== 1 ? 's' : ''}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 pt-3 border-t">
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2 text-xs sm:text-sm bg-accent/50 rounded px-2 py-1.5">
                            <span className="text-muted-foreground truncate">Full Resolution ZIP</span>
                            <span className="font-medium whitespace-nowrap flex-shrink-0 inline-flex items-center gap-1">
                              <Download className="w-3 h-3 text-muted-foreground" />
                              {album.fullResDownloads}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2 text-xs sm:text-sm bg-accent/50 rounded px-2 py-1.5">
                            <span className="text-muted-foreground truncate">Social Media Sized ZIP</span>
                            <span className="font-medium whitespace-nowrap flex-shrink-0 inline-flex items-center gap-1">
                              <Download className="w-3 h-3 text-muted-foreground" />
                              {album.socialDownloads}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden max-h-none sm:max-h-[calc(100dvh-var(--admin-header-height,0px))] flex flex-col">
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>Project Activity</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-hidden flex-1 min-h-0 flex flex-col">
              {activity.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No activity yet</p>
              ) : (
                <>
                  <div ref={activityScrollRef} className="overflow-y-auto overflow-x-hidden min-h-0 flex-1 pr-1 w-full">
                    <table className="w-full min-w-full text-sm table-auto">
                      <thead className="bg-muted/40">
                        <tr className="border-b border-border">
                          {([
                            { key: 'event' as const, label: 'Event', className: 'whitespace-nowrap' },
                            { key: 'description' as const, label: 'Description', className: '' },
                            { key: 'by' as const, label: 'By', className: 'hidden sm:table-cell whitespace-nowrap' },
                            { key: 'date' as const, label: 'Date', className: 'hidden sm:table-cell whitespace-nowrap' },
                          ]).map((col) => (
                            <th
                              key={col.key}
                              className={cn(
                                'text-left text-xs font-medium text-muted-foreground px-3 py-2 cursor-pointer select-none hover:text-foreground transition-colors',
                                col.className
                              )}
                              onClick={() => {
                                if (activitySortKey === col.key) {
                                  setActivitySortAsc((prev) => !prev)
                                } else {
                                  setActivitySortKey(col.key)
                                  setActivitySortAsc(col.key === 'date' ? false : true)
                                }
                                setActivityPage(1)
                              }}
                            >
                              <span className="inline-flex items-center gap-1">
                                {col.label}
                                <ArrowUpDown className={cn('w-3 h-3', activitySortKey === col.key ? 'text-foreground' : 'text-muted-foreground/40')} />
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pagedActivity.map((event) => {
                        const hasDetails = hasExpandableDetails(event)
                        const mainText = getMainText(event)
                        const showDropboxCloud = (event.type === 'DOWNLOAD' || event.type === 'ALBUM_DOWNLOAD')
                          && !!(event as DownloadActivity | AlbumDownloadActivity).fromDropbox
                        const metaValue = getEventMetaValue(event)
                        const showMeta = metaValue !== '—'
                        const metaLabel = isIpAddress(metaValue) ? 'IP' : 'By'
                        const detailsContent = event.type === 'VIEW' ? (
                          <div className="space-y-2">
                            {(event as ViewActivity).email && (
                              <div className="flex items-start gap-2">
                                <span className="text-xs font-semibold text-foreground min-w-[80px]">Email</span>
                                <span className="text-sm text-muted-foreground break-all">{(event as ViewActivity).email}</span>
                              </div>
                            )}
                          </div>
                        ) : event.type === 'ALBUM_DOWNLOAD' || event.type === 'PHOTO_DOWNLOAD' ? null
                        : event.type === 'VIDEO_APPROVED' || event.type === 'VIDEO_UNAPPROVED' ? null
                        : event.type === 'EMAIL' ? (
                          <div className="space-y-2">
                            {(event as EmailActivity).videoName && (
                              <div className="flex items-start gap-2">
                                <span className="text-xs font-semibold text-foreground min-w-[80px]">Video</span>
                                <span className="text-sm text-muted-foreground">
                                  {(event as EmailActivity).videoName} ({(event as EmailActivity).versionLabel})
                                </span>
                              </div>
                            )}
                            {(event as EmailActivity).recipients && (event as EmailActivity).recipients.length > 0 && (
                              <div className="flex items-start gap-2">
                                <span className="text-xs font-semibold text-foreground min-w-[80px]">Email</span>
                                <div className="flex-1 space-y-1">
                                  {(event as EmailActivity).recipients.map((email, idx) => (
                                    <div key={idx} className="text-sm text-muted-foreground break-all">
                                      {email}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : event.type === 'EMAIL_OPEN' ? (
                          <div className="space-y-2">
                            {(event as EmailOpenActivity).videoName && (
                              <div className="flex items-start gap-2">
                                <span className="text-xs font-semibold text-foreground min-w-[80px]">Video</span>
                                <span className="text-sm text-muted-foreground">
                                  {(event as EmailOpenActivity).videoName} ({(event as EmailOpenActivity).versionLabel})
                                </span>
                              </div>
                            )}
                          </div>
                        ) : event.type === 'STATUS_CHANGE' ? null : (
                          (event as DownloadActivity).assetFileNames && (event as DownloadActivity).assetFileNames!.length > 0 ? (
                            <div className="space-y-3">
                              {((event as DownloadActivity).eventType === 'DOWNLOAD_SUCCEEDED' || (event as DownloadActivity).eventType === 'DOWNLOAD_FAILED') && (
                                <div className="flex items-start gap-2">
                                  <span className="text-xs font-semibold text-foreground min-w-[80px]">Result</span>
                                  <div className="flex-1 text-sm text-muted-foreground">
                                    {(event as DownloadActivity).eventType === 'DOWNLOAD_FAILED'
                                      ? 'Failed'
                                      : formatDownloadSpeed((event as DownloadActivity).averageMbps)
                                      ? `Succeeded at ${formatDownloadSpeed((event as DownloadActivity).averageMbps)}`
                                      : 'Succeeded'}
                                  </div>
                                </div>
                              )}
                              <div className="flex items-start gap-2">
                                <span className="text-xs font-semibold text-foreground min-w-[80px]">Content</span>
                                <div className="flex-1">
                                  <div>
                                    <p className="text-sm text-muted-foreground mb-2">
                                      ZIP archive with {(event as DownloadActivity).assetFileNames!.length} asset
                                      {(event as DownloadActivity).assetFileNames!.length !== 1 ? 's' : ''}
                                    </p>
                                    <div className="space-y-1 pl-3 border-l-2 border-border">
                                      {(event as DownloadActivity).assetFileNames!.map((fileName, idx) => (
                                        <div
                                          key={idx}
                                          className="text-sm text-muted-foreground break-all font-mono text-xs"
                                        >
                                          {fileName}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ) : null
                        )
                        const showExpandedSection = hasDetails
                        return (
                          <Fragment key={event.id}>
                            <tr
                              className={cn(
                                'border-b text-sm transition-colors'
                              )}
                            >
                              <td className="py-2 px-3 align-middle whitespace-nowrap">
                                {event.type === 'STATUS_CHANGE' ? (
                                  <StatusPill status={(event as StatusChangeActivity).currentStatus} />
                                ) : (
                                  <span
                                    className={`px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap inline-flex items-center justify-center ${
                                      event.type === 'AUTH'
                                        ? getAccessMethodColor((event as AuthActivity).accessMethod)
                                        : event.type === 'VIEW' || event.type === 'VIDEO_APPROVED' || event.type === 'VIDEO_UNAPPROVED'
                                          ? 'bg-lime-800 text-lime-200'
                                        : event.type === 'EMAIL' || event.type === 'EMAIL_OPEN'
                                          ? 'bg-warning-visible text-warning'
                                        : (event as DownloadActivity).eventType === 'DOWNLOAD_FAILED'
                                          ? 'bg-destructive/15 text-destructive'
                                          : 'bg-success-visible text-success'
                                    }`}
                                  >
                                  {event.type === 'AUTH' ? (
                                    <>
                                      <KeyRound className="w-3 h-3 inline mr-1" />
                                      {(event as AuthActivity).accessMethod === 'OTP'
                                        ? 'Email OTP'
                                        : (event as AuthActivity).accessMethod === 'PASSWORD'
                                          ? 'Password'
                                          : (event as AuthActivity).accessMethod === 'GUEST'
                                            ? 'Guest Access'
                                            : 'Public Access'}
                                    </>
                                  ) : event.type === 'VIEW' ? (
                                    <>
                                      <Play className="w-3 h-3 inline mr-1" />
                                      Video View
                                    </>
                                  ) : event.type === 'ALBUM_DOWNLOAD' ? (
                                    <>
                                      <Download className="w-3 h-3 inline mr-1" />
                                      Album
                                    </>
                                  ) : event.type === 'PHOTO_DOWNLOAD' ? (
                                    <>
                                      <Download className="w-3 h-3 inline mr-1" />
                                      Photo
                                    </>
                                  ) : event.type === 'VIDEO_APPROVED' ? (
                                    <>
                                      <Play className="w-3 h-3 inline mr-1" />
                                      Video Approved
                                    </>
                                  ) : event.type === 'VIDEO_UNAPPROVED' ? (
                                    <>
                                      <Play className="w-3 h-3 inline mr-1" />
                                      Video Unapproved
                                    </>
                                  ) : event.type === 'EMAIL' ? (
                                    <>
                                      <Mail className="w-3 h-3 inline mr-1" />
                                      Email Sent
                                    </>
                                  ) : event.type === 'EMAIL_OPEN' ? (
                                    <>
                                      <Mail className="w-3 h-3 inline mr-1" />
                                      Email Opened
                                    </>
                                  ) : (
                                    <>
                                      <Download className="w-3 h-3 inline mr-1" />
                                      {(event as DownloadActivity).eventType === 'DOWNLOAD_FAILED'
                                        ? 'Download Failed'
                                        : (event as DownloadActivity).assetIds
                                          ? 'ZIP Download'
                                          : (event as DownloadActivity).assetId
                                            ? 'Asset Download'
                                            : 'Video Download'}
                                    </>
                                  )}
                                  </span>
                                )}
                              </td>
                              <td className="py-2 px-3 align-middle min-w-0 w-full">
                                <div className="sm:hidden text-right text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                                  {formatDateTime(event.createdAt)}
                                </div>
                                <span className="hidden sm:inline-flex items-center gap-1">
                                  <TruncatedText
                                    text={mainText}
                                    className="text-muted-foreground text-sm whitespace-normal break-words"
                                  />
                                  {showDropboxCloud && (
                                    <span title="Served from Dropbox" aria-label="Served from Dropbox">
                                      <Cloud className="w-3 h-3 flex-shrink-0 text-sky-500" aria-hidden="true" />
                                    </span>
                                  )}
                                </span>
                              </td>
                              <td className="py-2 px-3 align-middle text-xs text-muted-foreground whitespace-nowrap tabular-nums hidden sm:table-cell">
                                {metaValue}
                              </td>
                              <td className="py-2 px-3 align-middle text-xs text-muted-foreground whitespace-nowrap tabular-nums hidden sm:table-cell">
                                {formatDateTime(event.createdAt)}
                              </td>
                            </tr>

                            {showExpandedSection && (
                              <>
                                <tr className={cn('border-b bg-muted/30 hidden sm:table-row')}>
                                  <td />
                                  <td colSpan={3} className="px-4 pb-4 pt-3">
                                    {detailsContent}
                                  </td>
                                </tr>
                                <tr className={cn('border-b bg-muted/30 sm:hidden')}>
                                  <td colSpan={4} className="px-4 pb-4 pt-3">
                                    <div className="space-y-2">
                                      <div className="grid grid-cols-[80px_1fr] items-start gap-2">
                                        <span className="text-xs font-semibold text-foreground">Description</span>
                                        <span className="text-sm text-muted-foreground break-words">{mainText}{showDropboxCloud && (
                                          <span title="Served from Dropbox" aria-label="Served from Dropbox">
                                            <Cloud className="inline w-3 h-3 ml-1 flex-shrink-0 text-sky-500" aria-hidden="true" />
                                          </span>
                                        )}</span>
                                      </div>
                                      {showMeta && (
                                        <div className="grid grid-cols-[80px_1fr] items-start gap-2">
                                          <span className="text-xs font-semibold text-foreground">{metaLabel}</span>
                                          <span className="text-sm text-muted-foreground break-all">{metaValue}</span>
                                        </div>
                                      )}
                                    </div>
                                    {detailsContent && <div className="mt-2">{detailsContent}</div>}
                                  </td>
                                </tr>
                              </>
                            )}
                            {!showExpandedSection && (
                              <tr className="border-b bg-muted/30 sm:hidden">
                                <td colSpan={4} className="px-4 pb-4 pt-3">
                                  <div className="space-y-2">
                                    <div className="grid grid-cols-[80px_1fr] items-start gap-2">
                                      <span className="text-xs font-semibold text-foreground">Description</span>
                                      <span className="text-sm text-muted-foreground break-words">{mainText}{showDropboxCloud && (
                                        <span title="Served from Dropbox" aria-label="Served from Dropbox">
                                          <Cloud className="inline w-3 h-3 ml-1 flex-shrink-0 text-sky-500" aria-hidden="true" />
                                        </span>
                                      )}</span>
                                    </div>
                                    {showMeta && (
                                      <div className="grid grid-cols-[80px_1fr] items-start gap-2">
                                        <span className="text-xs font-semibold text-foreground">{metaLabel}</span>
                                        <span className="text-sm text-muted-foreground break-all">{metaValue}</span>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={activityPage <= 1}
                      onClick={() => setActivityPage((page) => Math.max(1, page - 1))}
                    >
                      Previous
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Page {activityPage} of {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={activityPage >= totalPages}
                      onClick={() => setActivityPage((page) => Math.min(totalPages, page + 1))}
                    >
                      Next
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
