'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Project } from '@prisma/client'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Trash2, ExternalLink, Archive, RotateCcw, Send, Loader2 } from 'lucide-react'
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
import { UnapproveModal } from './UnapproveModal'
import { apiFetch, apiPost, apiPatch, apiDelete } from '@/lib/api-client'
import { formatFileSize } from '@/lib/utils'

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
  const [isTogglingApproval, setIsTogglingApproval] = useState(false)

  // Unapprove modal state
  const [showUnapproveModal, setShowUnapproveModal] = useState(false)

  // Notification modal state
  const [showNotificationModal, setShowNotificationModal] = useState(false)
  const [notificationType, setNotificationType] = useState<'entire-project' | 'specific-video' | 'specific-album' | 'internal-invite'>('entire-project')
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

  // Check if project is password protected
  const isPasswordProtected = (project as any).sharePassword !== null &&
                               (project as any).sharePassword !== undefined &&
                               (project as any).sharePassword !== ''

  const projectId = project.id
  const photosEnabled = (project as any)?.enablePhotos !== false

  // Filter only ready videos
  const readyVideos = videos.filter(v => v.status === 'READY')

  // Check if all unique videos have at least one approved version
  const videosByNameForApproval = readyVideos.reduce((acc, video) => {
    if (!acc[video.name]) {
      acc[video.name] = []
    }
    acc[video.name].push(video)
    return acc
  }, {} as Record<string, Video[]>)

  const allVideosHaveApprovedVersion = Object.values(videosByNameForApproval).every((versions: Video[]) =>
    versions.some(v => v.approved)
  )

  const canApproveProject = readyVideos.length > 0 && allVideosHaveApprovedVersion

  const permissions = normalizeRolePermissions(user?.permissions)
  const canSendNotifications = canDoAction(permissions, 'sendNotificationsToRecipients')
  const canViewAnalytics = canDoAction(permissions, 'viewAnalytics')
  const canDeleteProjects = canDoAction(permissions, 'deleteProjects')
  const canChangeStatuses = canDoAction(permissions, 'changeProjectStatuses')
  const canViewSharePage = canDoAction(permissions, 'accessSharePage')

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
  const handleNotificationTypeChange = (type: 'entire-project' | 'specific-video' | 'specific-album' | 'internal-invite') => {
    setNotificationType(type)
    setSelectedVideoName('')
    setSelectedVideoId('')
    setSelectedAlbumId('')
    setEntireProjectNotes('')
    setInternalInviteNotes('')
    setSelectedRecipientIds([])
    setSelectedInternalUserIds([])
    setSelectedProjectFileIds([])
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

  useEffect(() => {
    if (!showNotificationModal) return
    if (notificationType === 'internal-invite') return

    // Default: select all project recipients with email.
    // Preserve an explicit user selection across refreshes (e.g. after sending).
    setSelectedRecipientIds((prev) => {
      const available = projectRecipientsWithEmail.map((r) => String(r.id))
      const availableSet = new Set(available)
      const filtered = prev.filter((id) => availableSet.has(id))
      return filtered.length > 0 ? filtered : available
    })
  }, [notificationType, projectRecipientsWithEmail, showNotificationModal])

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

  const handleToggleApproval = async () => {
    if (!canChangeStatuses) return
    // Prevent double-clicks during approval toggle
    if (isTogglingApproval) return

    const isCurrentlyApproved = project.status === 'APPROVED'

    if (isCurrentlyApproved) {
      // Show the unapprove modal to let user choose
      setShowUnapproveModal(true)
    } else {
      // For approval, just confirm and proceed
      if (!confirm(`Are you sure you want to approve this project?`)) {
        return
      }

      setIsTogglingApproval(true)

      // Approve project in background without blocking UI
      apiPatch(`/api/projects/${project.id}`, { status: 'APPROVED' })
        .then(() => {
          alert('Project approved successfully')
          // Refresh in background
          onRefresh?.()
          router.refresh()
        })
        .catch((error) => {
          alert('Failed to approve project')
        })
        .finally(() => {
          setIsTogglingApproval(false)
        })
    }
  }

  const handleUnapprove = async (unapproveVideos: boolean) => {
    if (!canChangeStatuses) return
    // Prevent double-clicks during unapproval
    if (isTogglingApproval) return

    setIsTogglingApproval(true)
    setShowUnapproveModal(false)

    // Unapprove project in background without blocking UI
    apiPost(`/api/projects/${project.id}/unapprove`, { unapproveVideos })
      .then((data) => {
        // Show appropriate success message
        if (data.unapprovedVideos && data.unapprovedCount > 0) {
          alert(`Project unapproved successfully. ${data.unapprovedCount} video(s) were also unapproved.`)
        } else if (data.unapprovedVideos && data.unapprovedCount === 0) {
          alert('Project unapproved successfully. No videos were approved.')
        } else {
          alert('Project unapproved successfully. Videos remain approved.')
        }
        // Refresh in background
        onRefresh?.()
        router.refresh()
      })
      .catch((error) => {
        alert('Failed to unapprove project')
      })
      .finally(() => {
        setIsTogglingApproval(false)
      })
  }

  const handleUnapproveProjectOnly = () => {
    handleUnapprove(false)
  }

  const handleUnapproveAll = () => {
    handleUnapprove(true)
  }

  const handleCancelUnapprove = () => {
    setShowUnapproveModal(false)
  }

  const handleDelete = async () => {
    if (!canDeleteProjects) return
    // Prevent double-clicks during deletion
    if (isDeleting) return

    if (!confirm(
      'Are you sure you want to delete this project? This will permanently delete all videos and files. This action cannot be undone.'
    )) {
      return
    }

    // Double confirmation for safety
    if (!confirm('This is your last warning. Delete permanently?')) {
      return
    }

    setIsDeleting(true)

    // Delete project in background without blocking UI
    apiDelete(`/api/projects/${project.id}`)
      .then(() => {
        // Redirect to admin page after successful deletion
        router.push('/admin/projects')
        router.refresh()
      })
      .catch((error) => {
        alert('Failed to delete project')
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
          canChangeStatuses ||
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
              {smtpConfigured && !hasRecipientWithEmail && (
                <p className="text-xs text-muted-foreground mt-1 px-1">
                  No client recipients with email addresses are configured. You can still send internal invites.
                </p>
              )}
            </div>
          )}

          {canViewSharePage && (
            <Button
              variant="outline"
              size="default"
              className="w-full"
              onClick={handleViewSharePage}
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              View Share Page
            </Button>
          )}

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

          {/* Approve/Unapprove Toggle Button */}
          {canChangeStatuses && (
            <div>
              <Button
                variant="outline"
                size="default"
                className="w-full"
                onClick={handleToggleApproval}
                disabled={isTogglingApproval || (project.status !== 'APPROVED' && !canApproveProject)}
                title={
                  project.status !== 'APPROVED' && !canApproveProject
                    ? 'Approve one version of each video first'
                    : ''
                }
              >
                {project.status === 'APPROVED' ? (
                  <>
                    <RotateCcw className="w-4 h-4 mr-2" />
                    {isTogglingApproval ? 'Unapproving...' : 'Unapprove Project'}
                  </>
                ) : (
                  <>
                    <Archive className="w-4 h-4 mr-2" />
                    {isTogglingApproval ? 'Approving...' : 'Approve Project'}
                  </>
                )}
              </Button>
              {project.status !== 'APPROVED' && !canApproveProject && (
                <p className="text-xs text-muted-foreground mt-1 px-1">
                  Approve one version of each video to enable project approval
                </p>
              )}
            </div>
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
        <DialogContent className="max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5" />
              Send Notification
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Notification Type Selection */}
            <div>
              <label className="text-sm font-medium mb-2 block">
                Notification Type
              </label>
              <Select value={notificationType} onValueChange={handleNotificationTypeChange}>
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
                      return (
                        <label key={String(r.id)} className="flex items-start gap-2 cursor-pointer">
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
                            disabled={loading}
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
            {isPasswordProtected && (
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

            {isPasswordProtected && (
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
                : notificationType === 'internal-invite'
                ? 'This will send an email to the selected internal users with a link to access this project.'
                : 'This will send an email to the selected recipients with a link to view the selected video version.'}
            </p>
          </div>
        </DialogContent>
      </Dialog>
      )}

      {/* Unapprove Modal */}
      <UnapproveModal
        show={showUnapproveModal}
        onCancel={handleCancelUnapprove}
        onUnapproveProjectOnly={handleUnapproveProjectOnly}
        onUnapproveAll={handleUnapproveAll}
        processing={isTogglingApproval}
      />
    </>
  )
}
