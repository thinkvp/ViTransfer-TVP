'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Project } from '@prisma/client'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Trash2, ExternalLink, RotateCcw, Send, Loader2, CalendarRange } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { Textarea } from './ui/textarea'
import { apiFetch, apiPost, apiDelete } from '@/lib/api-client'
import { formatFileSize } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from 'sonner'

interface Video {
  id: string
  name: string
  versionLabel: string
  status: string
  approved: boolean
}

interface ProjectActionsProps {
  project: Project
  videos: Video[]
  onRefresh?: () => void
}

type AlbumSummary = {
  id: string
  name: string
  _count?: { photos?: number }
}

export default function ProjectActions({ project, videos, onRefresh }: ProjectActionsProps) {
  const router = useRouter()
  const { user } = useAuth()
  const [isDeleting, setIsDeleting] = useState(false)
  const [isReprocessingPreviews, setIsReprocessingPreviews] = useState(false)
  const [isMonitoringReprocessPreviews, setIsMonitoringReprocessPreviews] = useState(false)

  const [showReprocessConfirm, setShowReprocessConfirm] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showDeleteConfirm2, setShowDeleteConfirm2] = useState(false)

  // Notification modal state
  const [showNotificationModal, setShowNotificationModal] = useState(false)
  const [notificationType, setNotificationType] = useState<'entire-project' | 'specific-video' | 'comment-summary' | 'specific-album' | 'internal-invite'>('entire-project')
  const [selectedVideoName, setSelectedVideoName] = useState<string>('')
  const [selectedVideoId, setSelectedVideoId] = useState<string>('')
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>('')
  const [albums, setAlbums] = useState<AlbumSummary[]>([])
  const [albumsLoading, setAlbumsLoading] = useState(false)
  const [entireProjectNotes, setEntireProjectNotes] = useState<string>('')
  const [internalInviteNotes, setInternalInviteNotes] = useState<string>('')
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>([])
  const [selectedInternalUserIds, setSelectedInternalUserIds] = useState<string[]>([])
  const [projectFiles, setProjectFiles] = useState<Array<{ id: string; fileName: string; fileSize: string }>>([])
  const [projectFilesLoading, setProjectFilesLoading] = useState(false)
  const [selectedProjectFileIds, setSelectedProjectFileIds] = useState<string[]>([])
  const [sendPasswordSeparately, setSendPasswordSeparately] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const MAX_EMAIL_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024
  const MAX_EMAIL_ATTACHMENTS_SINGLE_BYTES = 10 * 1024 * 1024

  // Read SMTP configuration status from project data
  const smtpConfigured = (project as any).smtpConfigured !== false

  // Check if at least one recipient has an email address
  const hasRecipientWithEmail = (project as any).recipients?.some((r: any) => r.email && r.email.trim() !== '') || false

  const projectRecipients = useMemo(() => {
    const list = Array.isArray((project as any)?.recipients) ? ((project as any).recipients as any[]) : []
    return list
      .map((r) => ({
        id: String(r?.id || ''),
        name: typeof r?.name === 'string' ? r.name : (r?.name ?? null),
        email: typeof r?.email === 'string' ? r.email : (r?.email ?? null),
        isPrimary: Boolean(r?.isPrimary),
        receiveNotifications: r?.receiveNotifications !== false,
      }))
      .filter((r) => r.id)
  }, [project])

  const projectRecipientsWithEmail = useMemo(
    () => projectRecipients.filter((r) => typeof r.email === 'string' && r.email.trim().length > 0),
    [projectRecipients]
  )

  // Check if project is password protected (based on authMode, not just password existence)
  const projectAuthMode = (project as any).authMode as string | undefined
  const isPasswordProtected = (projectAuthMode === 'PASSWORD' || projectAuthMode === 'BOTH') &&
                               (project as any).sharePassword !== null &&
                               (project as any).sharePassword !== undefined &&
                               (project as any).sharePassword !== ''

  const projectId = project.id
  const photosEnabled = (project as any)?.enablePhotos !== false

  // Filter only ready videos
  const readyVideos = videos.filter(v => v.status === 'READY')

  const permissions = normalizeRolePermissions(user?.permissions)
  const canSendNotifications = canDoAction(permissions, 'sendNotificationsToRecipients')
  const canViewAnalytics = canDoAction(permissions, 'viewAnalytics')
  const canDeleteProjects = canDoAction(permissions, 'deleteProjects')
  const canViewSharePage = canDoAction(permissions, 'accessSharePage')
  const canReprocessPreviews = canDoAction(permissions, 'changeProjectSettings')

  // Group videos by name
  const videosByName = readyVideos.reduce((acc, video) => {
    if (!acc[video.name]) {
      acc[video.name] = []
    }
    acc[video.name].push(video)
    return acc
  }, {} as Record<string, Video[]>)

  const videoNames = Object.keys(videosByName)
  const versionsForSelectedVideo = selectedVideoName ? videosByName[selectedVideoName] : []

  const assignedUsers = useMemo(
    () => (Array.isArray((project as any)?.assignedUsers) ? ((project as any).assignedUsers as any[]) : []),
    [project]
  )
  const assignedUsersWithEmail = useMemo(
    () => assignedUsers.filter((u) => typeof u?.email === 'string' && u.email.trim().length > 0),
    [assignedUsers]
  )

  const albumCount = Number((project as any)?._count?.albums ?? 0)
  const hasAnyReadyForEntireProject = readyVideos.length > 0 || (photosEnabled && albumCount > 0)

  // Reset selections when notification type changes
  const handleNotificationTypeChange = (type: 'entire-project' | 'specific-video' | 'comment-summary' | 'specific-album' | 'internal-invite') => {
    setNotificationType(type)
    setSelectedVideoName('')
    setSelectedVideoId('')
    setSelectedAlbumId('')
    setEntireProjectNotes('')
    setInternalInviteNotes('')
    setSelectedRecipientIds([])
    setSelectedInternalUserIds([])
    setSelectedProjectFileIds([])
    setSendPasswordSeparately(false)
  }

  // Reset version selection when video name changes
  const handleVideoNameChange = (name: string) => {
    setSelectedVideoName(name)
    setSelectedVideoId('')
  }

  useEffect(() => {
    const shouldFetchAlbums =
      showNotificationModal &&
      notificationType === 'specific-album' &&
      photosEnabled

    if (!shouldFetchAlbums) return

    let cancelled = false

    const load = async () => {
      setAlbumsLoading(true)
      try {
        const res = await apiFetch(`/api/projects/${projectId}/albums`, { cache: 'no-store' })
        if (!res.ok) throw new Error('Failed to load albums')
        const data = await res.json().catch(() => null)
        const list = Array.isArray((data as any)?.albums) ? ((data as any).albums as AlbumSummary[]) : []
        if (!cancelled) setAlbums(list)
      } catch {
        if (!cancelled) setAlbums([])
      } finally {
        if (!cancelled) setAlbumsLoading(false)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [notificationType, photosEnabled, projectId, showNotificationModal])

  useEffect(() => {
    const shouldFetchFiles = showNotificationModal && notificationType === 'internal-invite'
    if (!shouldFetchFiles) return

    let cancelled = false

    const load = async () => {
      setProjectFilesLoading(true)
      try {
        const res = await apiFetch(`/api/projects/${projectId}/files`, { cache: 'no-store' })
        if (!res.ok) throw new Error('Failed to load project files')
        const data = await res.json().catch(() => null)
        const list = Array.isArray((data as any)?.files) ? ((data as any).files as any[]) : []
        const normalized = list
          .map((f) => ({
            id: String(f.id),
            fileName: String(f.fileName || ''),
            fileSize: String(f.fileSize || '0'),
          }))
          .filter((f) => f.id && f.fileName)

        if (!cancelled) setProjectFiles(normalized)
      } catch {
        if (!cancelled) setProjectFiles([])
      } finally {
        if (!cancelled) setProjectFilesLoading(false)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [notificationType, projectId, showNotificationModal])

  useEffect(() => {
    if (!showNotificationModal) return
    if (notificationType !== 'internal-invite') return
    // Default: select all assigned internal users with email.
    // Preserve an explicit user selection across refreshes (e.g. after sending).
    setSelectedInternalUserIds((prev) => {
      const available = assignedUsersWithEmail.map((u) => String(u.id))
      const availableSet = new Set(available)
      const filtered = prev.filter((id) => availableSet.has(id))
      return filtered.length > 0 ? filtered : available
    })
  }, [assignedUsersWithEmail, notificationType, showNotificationModal])

  const notificationModalOpenRef = useRef(false)
  const notificationTypeRef = useRef(notificationType)
  const reprocessStatusPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!showNotificationModal) {
      notificationModalOpenRef.current = false
      notificationTypeRef.current = notificationType
      return
    }

    const justOpened = !notificationModalOpenRef.current
    const typeChanged = notificationTypeRef.current !== notificationType

    if (notificationType !== 'internal-invite' && (justOpened || typeChanged)) {
      const defaults = projectRecipientsWithEmail
        .filter((r) => (r as any)?.receiveNotifications !== false)
        .map((r) => String(r.id))

      setSelectedRecipientIds(defaults)
    }

    notificationModalOpenRef.current = true
    notificationTypeRef.current = notificationType
  }, [notificationType, projectRecipientsWithEmail, showNotificationModal])

  useEffect(() => {
    if (notificationType !== 'comment-summary') return
    if (!sendPasswordSeparately) return
    setSendPasswordSeparately(false)
  }, [notificationType, sendPasswordSeparately])

  useEffect(() => {
    if (!isReprocessingPreviews || !isMonitoringReprocessPreviews) {
      if (reprocessStatusPollTimeoutRef.current) {
        clearTimeout(reprocessStatusPollTimeoutRef.current)
        reprocessStatusPollTimeoutRef.current = null
      }
      return
    }

    let cancelled = false

    const pollStatus = async () => {
      try {
        const res = await apiFetch(`/api/projects/${project.id}/reprocess-previews`, { cache: 'no-store' })
        if (!res.ok) throw new Error('Failed to check reprocess status')
        const data = await res.json().catch(() => null)
        const inProgress = Boolean((data as any)?.inProgress)

        if (!inProgress) {
          if (!cancelled) {
            setIsMonitoringReprocessPreviews(false)
            setIsReprocessingPreviews(false)
            onRefresh?.()
            router.refresh()
          }
          return
        }
      } catch {
        // Keep the action latched and retry on transient polling failures.
      }

      if (!cancelled) {
        reprocessStatusPollTimeoutRef.current = setTimeout(pollStatus, 2500)
      }
    }

    void pollStatus()

    return () => {
      cancelled = true
      if (reprocessStatusPollTimeoutRef.current) {
        clearTimeout(reprocessStatusPollTimeoutRef.current)
        reprocessStatusPollTimeoutRef.current = null
      }
    }
  }, [isMonitoringReprocessPreviews, isReprocessingPreviews, onRefresh, project.id, router])



  const selectedAttachmentsMeta = projectFiles
    .filter((f) => selectedProjectFileIds.includes(f.id))
    .map((f) => {
      const bytes = Number(f.fileSize)
      return { id: f.id, fileName: f.fileName, bytes: Number.isFinite(bytes) ? bytes : 0 }
    })

  const attachmentsTotalBytes = selectedAttachmentsMeta.reduce((sum, f) => sum + (f.bytes || 0), 0)
  const oversizedAttachmentNames = selectedAttachmentsMeta
    .filter((f) => (f.bytes || 0) > MAX_EMAIL_ATTACHMENTS_SINGLE_BYTES)
    .map((f) => f.fileName)

  const attachmentsTooLarge =
    attachmentsTotalBytes > MAX_EMAIL_ATTACHMENTS_TOTAL_BYTES || oversizedAttachmentNames.length > 0

  const handleSendNotification = async () => {
    if (!canSendNotifications) return
    // Prevent rapid-fire notification sends
    if (loading) return

    // Validation
    if (notificationType !== 'internal-invite' && !hasRecipientWithEmail) {
      setMessage({ type: 'error', text: 'Add at least one recipient with an email address in Settings before sending client notifications.' })
      return
    }

    if (notificationType !== 'internal-invite' && selectedRecipientIds.length === 0) {
      setMessage({ type: 'error', text: 'Please select at least one recipient' })
      return
    }

    if (notificationType === 'entire-project' && !hasAnyReadyForEntireProject) {
      setMessage({ type: 'error', text: 'There is nothing ready to notify yet. Add a ready video (or an album) first.' })
      return
    }

    if (notificationType === 'specific-video' && !selectedVideoId) {
      setMessage({ type: 'error', text: 'Please select a video and version' })
      return
    }

    if (notificationType === 'specific-album' && !selectedAlbumId) {
      setMessage({ type: 'error', text: 'Please select an album' })
      return
    }

    if (notificationType === 'internal-invite') {
      if (selectedInternalUserIds.length === 0) {
        setMessage({ type: 'error', text: 'Please select at least one user' })
        return
      }
      if (attachmentsTooLarge) {
        setMessage({ type: 'error', text: 'Selected attachments are too large to send via email' })
        return
      }
    }

    setLoading(true)
    setMessage({ type: 'success', text: 'Sending notification...' })

    // Send notification in background without blocking UI
    apiPost(`/api/projects/${project.id}/notify`, {
      notificationType,
      videoId: notificationType === 'specific-video' ? selectedVideoId : null,
      albumId: notificationType === 'specific-album' ? selectedAlbumId : null,
      notifyEntireProject: notificationType === 'entire-project',
      notes:
        notificationType === 'entire-project'
          ? entireProjectNotes
          : notificationType === 'internal-invite'
          ? internalInviteNotes
          : null,
      recipientIds: notificationType !== 'internal-invite' ? selectedRecipientIds : undefined,
      internalUserIds: notificationType === 'internal-invite' ? selectedInternalUserIds : undefined,
      projectFileIds: notificationType === 'internal-invite' ? selectedProjectFileIds : undefined,
      sendPasswordSeparately: isPasswordProtected && sendPasswordSeparately,
    })
      .then((data) => {
        setMessage({ type: 'success', text: data.message || 'Notification sent successfully!' })
        // Keep selections intact (recipients/users/video/version/album) so the UI doesn't
        // appear to "refresh" and select everything again after a router refresh.
        setEntireProjectNotes('')
        setInternalInviteNotes('')
        setSendPasswordSeparately(false)

        // Sending a notification can auto-transition NOT_STARTED → IN_REVIEW.
        // Refresh the project data so the status pill updates immediately.
        onRefresh?.()
        router.refresh()
      })
      .catch((error) => {
        setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Failed to send notification' })
      })
      .finally(() => {
        setLoading(false)
      })
  }

  const handleViewSharePage = () => {
    router.push(`/admin/projects/${project.id}/share`)
  }

  const handleViewAnalytics = () => {
    if (!canViewAnalytics) return
    router.push(`/admin/projects/${project.id}/analytics`)
  }

  const handleViewGantt = () => {
    router.push(`/admin/projects/${project.id}/gantt`)
  }

  const handleReprocessPreviews = () => {
    if (!canReprocessPreviews || isReprocessingPreviews) return
    setShowReprocessConfirm(true)
  }

  const confirmReprocessPreviews = async () => {
    setIsReprocessingPreviews(true)
    setIsMonitoringReprocessPreviews(false)

    apiPost(`/api/projects/${project.id}/reprocess-previews`, {})
      .then((data: any) => {
        toast.success(
          `Preview reprocessing started. Cleared: ${Number(data?.cancelledJobs || 0)} jobs. ` +
          `Videos: ${Number(data?.queuedVideoJobs || 0)}, ` +
          `Uploads: ${Number(data?.queuedUploadPreviewJobs || 0)}, ` +
          `Upload timelines: ${Number(data?.queuedUploadTimelineJobs || 0)}, ` +
          `Video assets: ${Number(data?.queuedVideoAssetPreviewJobs || 0)}, ` +
          `Asset timelines: ${Number(data?.queuedAssetTimelineJobs || 0)}, ` +
          `Album photo previews: ${Number(data?.queuedAlbumPhotoSocialJobs || 0)}, ` +
          `Album thumbnails: ${Number(data?.queuedAlbumThumbnailJobs || 0)}.`
        )
        setIsMonitoringReprocessPreviews(true)
        onRefresh?.()
        router.refresh()
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Failed to reprocess previews')
        setIsMonitoringReprocessPreviews(false)
        setIsReprocessingPreviews(false)
      })
  }

  const handleDelete = () => {
    if (!canDeleteProjects || isDeleting) return
    setShowDeleteConfirm(true)
  }

  const confirmDeleteStep1 = () => {
    setShowDeleteConfirm(false)
    setShowDeleteConfirm2(true)
  }

  const confirmDeleteFinal = () => {
    setShowDeleteConfirm2(false)
    setIsDeleting(true)
    apiDelete(`/api/projects/${project.id}`)
      .then(() => {
        router.push('/admin/projects')
        router.refresh()
      })
      .catch(() => {
        toast.error('Failed to delete project')
        setIsDeleting(false)
      })
  }

  return (
    <>
      {(() => {
        const hasAnyActions =
          canSendNotifications ||
          canViewSharePage ||
          canViewAnalytics ||
          canReprocessPreviews ||
          canDeleteProjects

        if (!hasAnyActions) return null

        return (
      <Card>
        <CardContent className="pt-6 max-sm:pt-3 space-y-3">
          {canSendNotifications && (
            <div>
              <Button
                variant="outline"
                size="default"
                className="w-full"
                onClick={() => setShowNotificationModal(true)}
                disabled={smtpConfigured === false}
                title={
                  smtpConfigured === false
                    ? 'SMTP not configured. Please configure email settings in Settings.'
                    : ''
                }
              >
                <Send className="w-4 h-4 mr-2" />
                Send Notification
              </Button>
              {smtpConfigured === false && (
                <p className="text-xs text-muted-foreground mt-1 px-1">
                  Configure SMTP in Settings to enable email notifications
                </p>
              )}

            </div>
          )}

          {canReprocessPreviews && (
            <Button
              variant="outline"
              size="default"
              className="w-full"
              onClick={handleReprocessPreviews}
              disabled={isReprocessingPreviews}
            >
              {isReprocessingPreviews ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Reprocessing Previews...
                </>
              ) : (
                <>
                  <RotateCcw className="w-4 h-4 mr-2" />
                  Reprocess Previews
                </>
              )}
            </Button>
          )}

          <Button
            variant="outline"
            size="default"
            className="w-full"
            onClick={handleViewGantt}
          >
            <CalendarRange className="w-4 h-4 mr-2" />
            View Gantt
          </Button>

          {canViewAnalytics && (
            <Button
              variant="outline"
              size="default"
              className="w-full"
              onClick={handleViewAnalytics}
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              View Analytics Page
            </Button>
          )}

          {canViewSharePage && (
            <Button
              variant="default"
              size="default"
              className="w-full"
              onClick={handleViewSharePage}
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              View Share Page
            </Button>
          )}

          {canDeleteProjects && (
            <Button
              variant="destructive"
              size="default"
              className="w-full"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {isDeleting ? 'Deleting...' : 'Delete Project'}
            </Button>
          )}
        </CardContent>
      </Card>

        )
      })()}

      {/* Notification Modal */}
      {canSendNotifications && (
      <Dialog open={showNotificationModal} onOpenChange={setShowNotificationModal}>
        <DialogContent
          className="max-w-[95vw] sm:max-w-md flex flex-col max-h-[90vh]"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5" />
              Send Notification
            </DialogTitle>
          </DialogHeader>

          <div className="overflow-y-auto flex-1 min-h-0">
          <div className="space-y-4">
            {/* Notification Type Selection */}
            <div>
              <label className="text-sm font-medium mb-2 block">
                Notification Type
              </label>
              <Select
                value={notificationType}
                onValueChange={handleNotificationTypeChange}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="entire-project">
                    Entire Project (All Ready Videos)
                  </SelectItem>
                  <SelectItem value="specific-video">
                    Specific Video & Version
                  </SelectItem>
                  <SelectItem value="comment-summary">
                    Comment Summary
                  </SelectItem>
                  {(project as any)?.enablePhotos !== false && (
                    <SelectItem value="specific-album">
                      Specific Album Ready
                    </SelectItem>
                  )}

                  <SelectSeparator />

                  <SelectItem value="internal-invite">
                    Project Invite (Internal Users)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {notificationType !== 'internal-invite' && (
              <div>
                <label className="text-sm font-medium mb-2 block">Select Recipients</label>
                <div className="space-y-2 border rounded-md p-3 bg-muted/30">
                  {projectRecipientsWithEmail.length === 0 ? (
                    <div className="text-xs text-muted-foreground">No recipients with email addresses.</div>
                  ) : (
                    projectRecipientsWithEmail.map((r) => {
                      const checked = selectedRecipientIds.includes(String(r.id))
                      const label = (r.name || r.email) as string
                      const recipientsReadOnly = notificationType === 'comment-summary'
                      return (
                        <label
                          key={String(r.id)}
                          className={`flex items-start gap-2 ${recipientsReadOnly ? 'cursor-default' : 'cursor-pointer'}`}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 mt-0.5"
                            checked={checked}
                            onChange={(e) => {
                              const id = String(r.id)
                              setSelectedRecipientIds((prev) =>
                                e.target.checked ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id)
                              )
                            }}
                            disabled={loading || recipientsReadOnly}
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium truncate">{label}</span>
                            <span className="block text-xs text-muted-foreground truncate">{r.email}</span>
                          </span>
                          {!r.receiveNotifications && (
                            <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border flex-shrink-0">
                              notifications off
                            </span>
                          )}
                        </label>
                      )
                    })
                  )}
                </div>
                {notificationType === 'comment-summary' && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Manually send the Comment Summary email to project recipients.
                  </p>
                )}
              </div>
            )}

            {/* Notes (only for entire project notification) */}
            {notificationType === 'entire-project' && (
              <div>
                {!hasAnyReadyForEntireProject && (
                  <p className="text-xs text-muted-foreground mb-2">
                    There is nothing ready yet. Add a ready video (or an album) to enable this email.
                  </p>
                )}
                <label className="text-sm font-medium mb-2 block">Notes</label>
                <Textarea
                  value={entireProjectNotes}
                  onChange={(e) => setEntireProjectNotes(e.target.value)}
                  placeholder="Optional notes to include in the email"
                  className="resize-none"
                  rows={4}
                  disabled={loading}
                />
              </div>
            )}

            {/* Show video/version selectors only for specific video notification */}
            {notificationType === 'specific-video' && (
              <>
                <div>
                  <label className="text-sm font-medium mb-2 block">
                    Select Video
                  </label>
                  <Select value={selectedVideoName} onValueChange={handleVideoNameChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a video..." />
                    </SelectTrigger>
                    <SelectContent>
                      {videoNames.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedVideoName && (
                  <div>
                    <label className="text-sm font-medium mb-2 block">
                      Select Version
                    </label>
                    <Select value={selectedVideoId} onValueChange={setSelectedVideoId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a version..." />
                      </SelectTrigger>
                      <SelectContent>
                        {versionsForSelectedVideo.map((video) => (
                          <SelectItem key={video.id} value={video.id}>
                            {video.versionLabel}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}

            {notificationType === 'specific-album' && (
              <>
                <div>
                  <label className="text-sm font-medium mb-2 block">
                    Select Album
                  </label>
                  <Select value={selectedAlbumId} onValueChange={setSelectedAlbumId}>
                    <SelectTrigger>
                      <SelectValue placeholder={albumsLoading ? 'Loading albums…' : 'Select an album...'} />
                    </SelectTrigger>
                    <SelectContent>
                      {albums.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            {notificationType === 'internal-invite' && (
              <>
                <div>
                  <label className="text-sm font-medium mb-2 block">Select Users</label>
                  <div className="space-y-2 border rounded-md p-3 bg-muted/30">
                    {assignedUsersWithEmail.length === 0 ? (
                      <div className="text-xs text-muted-foreground">No assigned users with email addresses.</div>
                    ) : (
                      assignedUsersWithEmail.map((u) => {
                        const checked = selectedInternalUserIds.includes(String(u.id))
                        const label = (u.name || u.email) as string
                        return (
                          <label key={String(u.id)} className="flex items-start gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              className="h-4 w-4 mt-0.5"
                              checked={checked}
                              onChange={(e) => {
                                const id = String(u.id)
                                setSelectedInternalUserIds((prev) =>
                                  e.target.checked ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id)
                                )
                              }}
                              disabled={loading}
                            />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium truncate">{label}</span>
                              <span className="block text-xs text-muted-foreground truncate">{u.email}</span>
                            </span>
                          </label>
                        )
                      })
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">Notes</label>
                  <Textarea
                    value={internalInviteNotes}
                    onChange={(e) => setInternalInviteNotes(e.target.value)}
                    placeholder="Optional notes to include in the email"
                    className="resize-none"
                    rows={4}
                    disabled={loading}
                  />
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">Attachments</label>
                  <div className="space-y-2 border rounded-md p-3 bg-muted/30">
                    {projectFilesLoading ? (
                      <div className="text-xs text-muted-foreground">Loading project files…</div>
                    ) : projectFiles.length === 0 ? (
                      <div className="text-xs text-muted-foreground">No project files found.</div>
                    ) : (
                      projectFiles.map((f) => {
                        const checked = selectedProjectFileIds.includes(f.id)
                        const bytes = Number(f.fileSize)
                        const safeBytes = Number.isFinite(bytes) ? bytes : 0
                        const tooBig = safeBytes > MAX_EMAIL_ATTACHMENTS_SINGLE_BYTES
                        return (
                          <label key={f.id} className="flex items-start gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              className="h-4 w-4 mt-0.5"
                              checked={checked}
                              onChange={(e) => {
                                setSelectedProjectFileIds((prev) =>
                                  e.target.checked ? Array.from(new Set([...prev, f.id])) : prev.filter((x) => x !== f.id)
                                )
                              }}
                              disabled={loading}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium truncate">{f.fileName}</span>
                              <span className="block text-xs text-muted-foreground truncate">
                                {formatFileSize(safeBytes)}
                                {tooBig ? ' • too large to email' : ''}
                              </span>
                            </span>
                          </label>
                        )
                      })
                    )}
                  </div>

                  {(selectedProjectFileIds.length > 0 || attachmentsTooLarge) && (
                    <div className="text-xs text-muted-foreground mt-2">
                      Selected: {formatFileSize(attachmentsTotalBytes)} (max {formatFileSize(MAX_EMAIL_ATTACHMENTS_TOTAL_BYTES)})
                      {oversizedAttachmentNames.length > 0 && (
                        <div className="text-destructive mt-1">
                          Too large: {oversizedAttachmentNames.join(', ')} (max per file {formatFileSize(MAX_EMAIL_ATTACHMENTS_SINGLE_BYTES)})
                        </div>
                      )}
                      {attachmentsTotalBytes > MAX_EMAIL_ATTACHMENTS_TOTAL_BYTES && (
                        <div className="text-destructive mt-1">
                          Total attachments exceed {formatFileSize(MAX_EMAIL_ATTACHMENTS_TOTAL_BYTES)}.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Select Recipients is rendered above for client notifications */}

            {/* Password checkbox - only show if project is password protected */}
            {isPasswordProtected && notificationType !== 'comment-summary' && (
              <div className="flex items-center space-x-2 p-3 bg-muted rounded-md">
                <input
                  type="checkbox"
                  id="send-password"
                  checked={sendPasswordSeparately}
                  onChange={(e) => setSendPasswordSeparately(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <label
                  htmlFor="send-password"
                  className="text-sm font-medium cursor-pointer"
                >
                  Send password in separate email
                </label>
              </div>
            )}

            {isPasswordProtected && notificationType !== 'comment-summary' && (
              <p className="text-xs text-muted-foreground bg-accent/50 p-3 rounded-md border border-border">
                <strong>Note:</strong> This project is password protected. {sendPasswordSeparately ? 'The password will be sent in a separate email for enhanced security.' : 'The password will NOT be included in the email - you must share it separately.'}
              </p>
            )}

            <Button
              onClick={handleSendNotification}
              disabled={
                loading ||
                (notificationType !== 'internal-invite' && !hasRecipientWithEmail) ||
                (notificationType !== 'internal-invite' && selectedRecipientIds.length === 0) ||
                (notificationType === 'entire-project' && !hasAnyReadyForEntireProject) ||
                (notificationType === 'specific-video' && !selectedVideoId) ||
                (notificationType === 'specific-album' && !selectedAlbumId) ||
                (notificationType === 'internal-invite' && (selectedInternalUserIds.length === 0 || attachmentsTooLarge))
              }
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Send Email Notification
                </>
              )}
            </Button>

            {message && (
              <div
                className={`p-3 rounded-md text-sm font-medium ${
                  message.type === 'success'
                    ? 'bg-success-visible text-success border-2 border-success-visible'
                    : 'bg-destructive-visible text-destructive border-2 border-destructive-visible'
                }`}
              >
                {message.text}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {notificationType === 'entire-project'
                ? 'This will send an email to the selected recipients with access to all ready videos in this project.'
                : notificationType === 'specific-album'
                ? 'This will send an email to the selected recipients with a link to view the selected album.'
                : notificationType === 'comment-summary'
                ? 'This will send a comment summary email to recipients with notifications enabled.'
                : notificationType === 'internal-invite'
                ? 'This will send an email to the selected internal users with a link to access this project.'
                : 'This will send an email to the selected recipients with a link to view the selected video version.'}
            </p>
          </div>
          </div>
        </DialogContent>
      </Dialog>
      )}

      <ConfirmDialog
        open={showReprocessConfirm}
        onOpenChange={setShowReprocessConfirm}
        title="Reprocess All Previews?"
        description="This will delete stored preview files, clear preview references in the database, and queue regeneration for videos, video assets, uploads, album thumbnails, and album photo preview derivatives."
        confirmLabel="Reprocess"
        onConfirm={confirmReprocessPreviews}
      />
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete This Project?"
        description="This will permanently delete all videos and files. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={confirmDeleteStep1}
      />
      <ConfirmDialog
        open={showDeleteConfirm2}
        onOpenChange={setShowDeleteConfirm2}
        title="Final Warning: Delete Permanently?"
        description="There is no recovery. All project data will be gone forever."
        confirmLabel="Delete Permanently"
        onConfirm={confirmDeleteFinal}
      />
    </>
  )
}
