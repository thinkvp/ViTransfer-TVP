'use client'

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Video, Eye, Download, ArrowLeft, Mail, Users, ChevronDown, ChevronRight } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { projectStatusBadgeClass, projectStatusLabel } from '@/lib/project-status'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'

interface VideoStats {
  videoName: string
  totalDownloads: number
  versions: Array<{
    id: string
    versionLabel: string
    downloads: number
  }>
}

interface AuthActivity {
  id: string
  type: 'AUTH'
  accessMethod: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE'
  email: string | null
  createdAt: Date
}

interface DownloadActivity {
  id: string
  type: 'DOWNLOAD'
  videoName: string
  versionLabel: string
  assetId?: string | null
  assetIds?: string[]
  assetFileName?: string
  assetFileNames?: string[]
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
    accessByMethod: {
      OTP: number
      PASSWORD: number
      GUEST: number
      NONE: number
    }
    totalDownloads: number
    videoCount: number
  }
  videoStats: VideoStats[]
  activity: Activity[]
}

function getAccessMethodColor(method: string): string {
  return 'bg-primary-visible text-primary border-2 border-primary-visible'
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

export default function ProjectAnalyticsClient({ id }: { id: string }) {
  const { user, loading: authLoading } = useAuth()
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())

  const permissions = useMemo(() => normalizeRolePermissions(user?.permissions), [user?.permissions])
  const canViewAnalytics = canDoAction(permissions, 'viewAnalytics')
  const denied = !authLoading && user && !canViewAnalytics

  const toggleExpand = (itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) {
        next.delete(itemId)
      } else {
        next.add(itemId)
      }
      return next
    })
  }

  useEffect(() => {
    const loadAnalytics = async () => {
      try {
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
    loadAnalytics()
  }, [id, denied])

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

  const { project, stats, videoStats, activity } = data

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
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

        <div className="grid gap-4 sm:gap-6 md:grid-cols-2 lg:grid-cols-4 mb-6 sm:mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Visits</CardTitle>
              <Eye className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalVisits.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground mt-1">{stats.uniqueVisits} unique sessions</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Unique Visitors</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.uniqueVisits.toLocaleString()}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Downloads</CardTitle>
              <Download className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalDownloads.toLocaleString()}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Videos</CardTitle>
              <Video className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.videoCount}</div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 sm:gap-6 lg:grid-cols-2 overflow-hidden">
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Videos in this Project</CardTitle>
              <CardDescription>Analytics grouped by video name, showing all versions</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-hidden">
              {videoStats.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No videos available</p>
              ) : (
                <div className="space-y-4">
                  {videoStats.map((video) => (
                    <div key={video.videoName} className="border rounded-lg p-3 sm:p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-semibold text-sm sm:text-base break-words">{video.videoName}</h4>
                          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                            {video.versions.length} version{video.versions.length !== 1 ? 's' : ''}
                          </p>
                        </div>
                      </div>

                      <div className="mb-3">
                        <div className="text-sm">
                          <div className="text-xs text-muted-foreground mb-1">Total Downloads</div>
                          <div className="font-medium text-base sm:text-lg">{video.totalDownloads}</div>
                        </div>
                      </div>

                      {video.versions.length > 0 && (
                        <div className="mt-3 pt-3 border-t">
                          <div className="text-xs text-muted-foreground mb-2">Per-version breakdown:</div>
                          <div className="space-y-1.5">
                            {video.versions.map((version) => (
                              <div
                                key={version.id}
                                className="flex items-center justify-between gap-2 text-xs sm:text-sm bg-accent/50 rounded px-2 py-1.5"
                              >
                                <span className="text-muted-foreground truncate">{version.versionLabel}</span>
                                <span className="font-medium whitespace-nowrap flex-shrink-0">
                                  {version.downloads} download{version.downloads !== 1 ? 's' : ''}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Project Activity</CardTitle>
              <CardDescription>All authentication, email, download, and open tracking events</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-hidden">
              {activity.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No activity yet</p>
              ) : (
                <div className="space-y-2">
                  {activity.map((event) => {
                    const isExpanded = expandedItems.has(event.id)
                    return (
                      <div
                        key={event.id}
                        className="rounded-lg border text-sm hover:bg-accent/50 transition-colors cursor-pointer"
                        onClick={() => toggleExpand(event.id)}
                      >
                        <div className="flex items-center gap-3 p-3">
                          {event.type === 'STATUS_CHANGE' ? (
                            <StatusPill status={(event as StatusChangeActivity).currentStatus} />
                          ) : (
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 ${
                                event.type === 'AUTH'
                                  ? getAccessMethodColor((event as AuthActivity).accessMethod)
                                  : event.type === 'EMAIL' || event.type === 'EMAIL_OPEN'
                                    ? 'bg-warning-visible text-warning border-2 border-warning-visible'
                                    : 'bg-success-visible text-success border-2 border-success-visible'
                              }`}
                            >
                              {event.type === 'AUTH' ? (
                                (event as AuthActivity).accessMethod === 'OTP'
                                  ? 'Email OTP'
                                  : (event as AuthActivity).accessMethod === 'PASSWORD'
                                    ? 'Password'
                                    : (event as AuthActivity).accessMethod === 'GUEST'
                                      ? 'Guest Access'
                                      : 'Public Access'
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
                                  {(event as DownloadActivity).assetIds
                                    ? 'ZIP'
                                    : (event as DownloadActivity).assetId
                                      ? 'Asset'
                                      : 'Video'}
                                </>
                              )}
                            </span>
                          )}

                          <div className="flex-1 min-w-0 flex items-center justify-center">
                            <span className="text-muted-foreground text-sm truncate">
                              {event.type === 'AUTH' ? (
                                (event as AuthActivity).email ? (
                                  isExpanded
                                    ? (event as AuthActivity).email!
                                    : `${(event as AuthActivity).email!.substring(0, 20)}${
                                        (event as AuthActivity).email!.length > 20 ? '...' : ''
                                      }`
                                ) : (event as AuthActivity).accessMethod === 'GUEST' ? (
                                  'Guest visitor'
                                ) : (
                                  'Public visitor'
                                )
                              ) : event.type === 'EMAIL' ? (
                                (event as EmailActivity).description
                              ) : event.type === 'EMAIL_OPEN' ? (
                                (event as EmailOpenActivity).description
                              ) : event.type === 'STATUS_CHANGE' ? (
                                'Status Changed'
                              ) : (
                                isExpanded
                                  ? (event as DownloadActivity).videoName
                                  : `${(event as DownloadActivity).videoName.substring(0, 25)}${
                                      (event as DownloadActivity).videoName.length > 25 ? '...' : ''
                                    }`
                              )}
                            </span>
                          </div>

                          <div className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">
                            {formatDateTime(event.createdAt)}
                          </div>

                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          )}
                        </div>

                        {isExpanded && (
                          <div className="px-4 pb-4 pt-3 border-t bg-muted/30">
                            {event.type === 'AUTH' ? (
                              <div className="space-y-2">
                                <div className="flex items-start gap-2">
                                  <span className="text-xs font-semibold text-foreground min-w-[80px]">Action</span>
                                  <span className="text-sm text-muted-foreground">Accessed the project</span>
                                </div>
                                {(event as AuthActivity).email && (
                                  <div className="flex items-start gap-2">
                                    <span className="text-xs font-semibold text-foreground min-w-[80px]">Email</span>
                                    <span className="text-sm text-muted-foreground break-all">{(event as AuthActivity).email}</span>
                                  </div>
                                )}
                              </div>
                            ) : event.type === 'EMAIL' ? (
                              <div className="space-y-2">
                                <div className="flex items-start gap-2">
                                  <span className="text-xs font-semibold text-foreground min-w-[80px]">Action</span>
                                  <span className="text-sm text-muted-foreground">
                                    {(event as EmailActivity).description === 'All Ready Videos'
                                      ? 'All Ready Videos email sent'
                                      : (event as EmailActivity).description === 'Comment Summary'
                                        ? 'Comment Summary email sent'
                                        : 'Specific Video & Version email sent'}
                                  </span>
                                </div>
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
                                <div className="flex items-start gap-2">
                                  <span className="text-xs font-semibold text-foreground min-w-[80px]">Action</span>
                                  <span className="text-sm text-muted-foreground">
                                    {(event as EmailOpenActivity).description === 'All Ready Videos'
                                      ? 'All Ready Videos email opened'
                                      : (event as EmailOpenActivity).description === 'Comment Summary'
                                        ? 'Comment Summary email opened'
                                        : 'Specific Video & Version email opened'}
                                  </span>
                                </div>
                                {(event as EmailOpenActivity).videoName && (
                                  <div className="flex items-start gap-2">
                                    <span className="text-xs font-semibold text-foreground min-w-[80px]">Video</span>
                                    <span className="text-sm text-muted-foreground">
                                      {(event as EmailOpenActivity).videoName} ({(event as EmailOpenActivity).versionLabel})
                                    </span>
                                  </div>
                                )}
                                <div className="flex items-start gap-2">
                                  <span className="text-xs font-semibold text-foreground min-w-[80px]">Email</span>
                                  <span className="text-sm text-muted-foreground break-all">
                                    {(event as EmailOpenActivity).recipientEmail}
                                  </span>
                                </div>
                              </div>
                            ) : event.type === 'STATUS_CHANGE' ? (
                              <div className="space-y-2">
                                <div className="flex items-start gap-2">
                                  <span className="text-xs font-semibold text-foreground min-w-[80px]">Action</span>
                                  <span className="text-sm text-muted-foreground">
                                    Project changed from{' '}
                                    <span className="font-medium">{projectStatusLabel((event as StatusChangeActivity).previousStatus)}</span>
                                    {' '}to{' '}
                                    <span className="font-medium">{projectStatusLabel((event as StatusChangeActivity).currentStatus)}</span>
                                  </span>
                                </div>
                                <div className="flex items-start gap-2">
                                  <span className="text-xs font-semibold text-foreground min-w-[80px]">By</span>
                                  <span className="text-sm text-muted-foreground">
                                    {(() => {
                                      const statusEvent = event as StatusChangeActivity
                                      if (statusEvent.source === 'SYSTEM') return 'System'
                                      if (statusEvent.source === 'CLIENT') return 'Client'
                                      const actor = statusEvent.changedBy
                                      if (!actor) return 'Admin'
                                      if (actor.name && actor.email) return `${actor.name} (${actor.email})`
                                      return actor.name || actor.email
                                    })()}
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-3">
                                <div className="flex items-start gap-2">
                                  <span className="text-xs font-semibold text-foreground min-w-[80px]">Video</span>
                                  <span className="text-sm text-muted-foreground">
                                    {(event as DownloadActivity).videoName} ({(event as DownloadActivity).versionLabel})
                                  </span>
                                </div>

                                <div className="flex items-start gap-2">
                                  <span className="text-xs font-semibold text-foreground min-w-[80px]">Content</span>
                                  <div className="flex-1">
                                    {(event as DownloadActivity).assetFileNames && (event as DownloadActivity).assetFileNames!.length > 0 ? (
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
                                    ) : (event as DownloadActivity).assetFileName ? (
                                      <div className="text-sm text-muted-foreground">
                                        <p className="mb-1">Single asset file</p>
                                        <p className="font-mono text-xs break-all pl-3 border-l-2 border-border">
                                          {(event as DownloadActivity).assetFileName}
                                        </p>
                                      </div>
                                    ) : (
                                      <span className="text-sm text-muted-foreground">Full video file</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
