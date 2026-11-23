'use client'

import { useMemo, useState, useEffect } from 'react'
import type { Video } from '@/types/video'
import { cn, formatDuration, formatFileSize } from '@/lib/utils'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { InlineEdit } from './InlineEdit'
import { Textarea } from './ui/textarea'
import { Trash2, CheckCircle2, XCircle, Pencil, Check, ChevronDown, ChevronUp, Eye, Download, Captions, Loader2, FileClock, FileVideo, MoreHorizontal, Plus, CalendarPlus, CalendarClock, RotateCcw, History, RefreshCw, type LucideIcon } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { apiPost, apiPatch, apiDelete, apiFetch } from '@/lib/api-client'
import { VideoAssetList } from './VideoAssetList'
import { withDownloadTracking } from '@/lib/download-url'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from 'sonner'
import { Input } from './ui/input'
import { addDaysYmd, describeFeedbackDeadline, formatFeedbackDueDate, getFeedbackDeadlineStatus, isValidFeedbackDueDate, todayYmd } from '@/lib/feedback-deadline'

interface VideoListProps {
  videos: Video[]
  isAdmin?: boolean
  onRefresh?: () => void
  canDelete?: boolean
  canApprove?: boolean
  canManageAllowApproval?: boolean
  s3Mode?: boolean
  /** Whisper enabled globally — shows the per-version subtitle generate/regenerate button. */
  transcriptionEnabled?: boolean
}

export default function VideoList({
  videos: initialVideos,
  isAdmin = true,
  onRefresh,
  canDelete,
  canApprove,
  canManageAllowApproval,
  transcriptionEnabled = false,
}: VideoListProps) {
  const effectiveCanDelete = canDelete ?? isAdmin
  const effectiveCanApprove = canApprove ?? isAdmin
  const effectiveCanManageAllowApproval = canManageAllowApproval ?? isAdmin

  // Only the newest READY version of a name can owe feedback, so only it shows a
  // deadline chip (mirrors isFeedbackDeadlineActive's "latest version" rule).
  const latestReadyVersionByName = new Map<string, number>()
  for (const v of initialVideos) {
    if (v.status !== 'READY') continue
    latestReadyVersionByName.set(v.name, Math.max(latestReadyVersionByName.get(v.name) ?? 0, v.version))
  }
  const isLatestVersion = (v: Video) => (latestReadyVersionByName.get(v.name) ?? v.version) <= v.version

  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [videos, setVideos] = useState<Video[]>(initialVideos)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null)
  const [notesEditValue, setNotesEditValue] = useState('')
  const [savingNotesId, setSavingNotesId] = useState<string | null>(null)
  const [editingDeadlineId, setEditingDeadlineId] = useState<string | null>(null)
  const [deadlineEditValue, setDeadlineEditValue] = useState('')
  const [savingDeadlineId, setSavingDeadlineId] = useState<string | null>(null)
  const [savingAllowApprovalId, setSavingAllowApprovalId] = useState<string | null>(null)
  const [savingRevisionRequestedId, setSavingRevisionRequestedId] = useState<string | null>(null)
  const [assetRefreshTrigger, setAssetRefreshTrigger] = useState(0)
  const [expandedVideoIds, setExpandedVideoIds] = useState<string[]>([])
  const [pendingDeleteVideoId, setPendingDeleteVideoId] = useState<string | null>(null)
  const [pendingApprovalVideo, setPendingApprovalVideo] = useState<{ id: string; approved: boolean } | null>(null)
  const [generatingSubtitlesId, setGeneratingSubtitlesId] = useState<string | null>(null)
  const [pendingSubtitlesRegenerateId, setPendingSubtitlesRegenerateId] = useState<string | null>(null)

  // S3 version label rename confirmation
  const [versionRenameConfirm, setVersionRenameConfirm] = useState<{ videoId: string; newLabel: string } | null>(null)
  const [versionRenameConfirming, setVersionRenameConfirming] = useState(false)

  // Polling removed from VideoList to prevent duplicate polling
  // Parent component (Project page) handles polling for processing videos

  // Update local state when props change
  useEffect(() => {
    setVideos(initialVideos)
  }, [initialVideos])

  const latestVersionId = useMemo(() => {
    if (initialVideos.length === 0) return null
    let best = initialVideos[0] as any
    for (const v of initialVideos as any[]) {
      const bestVersion = typeof best?.version === 'number' ? best.version : Number.NEGATIVE_INFINITY
      const currentVersion = typeof v?.version === 'number' ? v.version : Number.NEGATIVE_INFINITY
      if (currentVersion > bestVersion) best = v
    }
    return best?.id ?? null
  }, [initialVideos])

  useEffect(() => {
    setExpandedVideoIds((prev) => {
      const existing = new Set((initialVideos as any[]).map((v) => String(v.id)))
      const filtered = prev.filter((id) => existing.has(id))
      if (filtered.length > 0) return filtered
      return latestVersionId ? [String(latestVersionId)] : []
    })
  }, [initialVideos, latestVersionId])

  const toggleExpanded = (videoId: string) => {
    setExpandedVideoIds((prev) =>
      prev.includes(videoId) ? prev.filter((id) => id !== videoId) : [...prev, videoId]
    )
  }

  const handleDelete = (videoId: string) => {
    if (!effectiveCanDelete) return
    if (deletingId) return
    setPendingDeleteVideoId(videoId)
  }

  const confirmDeleteVideo = () => {
    const videoId = pendingDeleteVideoId!
    setPendingDeleteVideoId(null)
    setDeletingId(videoId)

    setVideos(prev => prev.filter(v => v.id !== videoId))

    apiDelete(`/api/videos/${videoId}`)
      .then(() => {
        try {
          window.dispatchEvent(new CustomEvent('video-deleted', { detail: { videoId } }))
        } catch {}
        onRefresh?.()
      })
      .catch(() => {
        setVideos(initialVideos)
        toast.error('Failed to delete video')
      })
      .finally(() => {
        setDeletingId(null)
      })
  }

  const handleToggleApproval = (videoId: string, currentlyApproved: boolean) => {
    if (!effectiveCanApprove) return
    if (approvingId) return
    setPendingApprovalVideo({ id: videoId, approved: currentlyApproved })
  }

  const confirmToggleApproval = () => {
    const { id: videoId, approved: currentlyApproved } = pendingApprovalVideo!
    setPendingApprovalVideo(null)
    const action = currentlyApproved ? 'unapprove' : 'approve'

    setApprovingId(videoId)

    setVideos(prev => prev.map(v =>
      v.id === videoId ? { ...v, approved: !currentlyApproved } as Video : v
    ))

    window.dispatchEvent(new CustomEvent('videoApprovalChanged'))

    apiPatch(`/api/videos/${videoId}`, { approved: !currentlyApproved })
      .then(() => {
        onRefresh?.()
      })
      .catch(() => {
        setVideos(prev => prev.map(v =>
          v.id === videoId ? { ...v, approved: currentlyApproved } as Video : v
        ))
        toast.error(`Failed to ${action} video`)
      })
      .finally(() => {
        setApprovingId(null)
      })
  }

  // Manual "Reviewed" (next version requested) toggle — mirrors the client share-page
  // Request Next Version state without locking comments.
  const handleToggleRevisionRequested = async (videoId: string, currentlyRequested: boolean) => {
    if (!effectiveCanApprove) return
    if (savingRevisionRequestedId) return

    const previous = (videos.find(v => v.id === videoId) as any)?.revisionRequestedAt ?? null
    setSavingRevisionRequestedId(videoId)

    // Optimistically update UI
    setVideos(prev => prev.map(v =>
      v.id === videoId ? ({ ...v, revisionRequestedAt: currentlyRequested ? null : new Date().toISOString() } as any) : v
    ))

    try {
      await apiPatch(`/api/videos/${videoId}`, { revisionRequested: !currentlyRequested })
      onRefresh?.()
    } catch (error) {
      setVideos(prev => prev.map(v =>
        v.id === videoId ? ({ ...v, revisionRequestedAt: previous } as any) : v
      ))
      toast.error('Failed to update Reviewed status')
    } finally {
      setSavingRevisionRequestedId(null)
    }
  }

  const handleToggleAllowApproval = async (videoId: string, nextAllowApproval: boolean) => {
    if (!effectiveCanManageAllowApproval) return
    if (savingAllowApprovalId) return

    const previous = (videos.find(v => v.id === videoId) as any)?.allowApproval
    setSavingAllowApprovalId(videoId)

    // Optimistically update UI
    setVideos(prev => prev.map(v =>
      v.id === videoId ? ({ ...v, allowApproval: nextAllowApproval } as any) : v
    ))

    try {
      await apiPatch(`/api/videos/${videoId}`, { allowApproval: nextAllowApproval })
      onRefresh?.()
    } catch (error) {
      // Revert optimistic update
      setVideos(prev => prev.map(v =>
        v.id === videoId ? ({ ...v, allowApproval: previous } as any) : v
      ))
      toast.error('Failed to update approval setting')
    } finally {
      setSavingAllowApprovalId(null)
    }
  }

  const doGenerateSubtitles = async (videoId: string) => {
    if (generatingSubtitlesId) return
    const previousStatus = (videos.find(v => v.id === videoId) as any)?.transcriptionStatus ?? null
    setGeneratingSubtitlesId(videoId)

    setVideos(prev => prev.map(v =>
      v.id === videoId ? ({ ...v, transcriptionStatus: 'PENDING', transcriptionError: null } as any) : v
    ))

    try {
      await apiPost(`/api/videos/${videoId}/subtitles/regenerate`, {})
      onRefresh?.()
    } catch (error: any) {
      setVideos(prev => prev.map(v =>
        v.id === videoId ? ({ ...v, transcriptionStatus: previousStatus } as any) : v
      ))
      toast.error(error?.message || 'Failed to queue subtitle generation')
    } finally {
      setGeneratingSubtitlesId(null)
    }
  }

  const handleGenerateSubtitles = (videoId: string, alreadyGenerated: boolean) => {
    if (generatingSubtitlesId) return
    if (alreadyGenerated) {
      setPendingSubtitlesRegenerateId(videoId)
      return
    }
    void doGenerateSubtitles(videoId)
  }

  const handleStartEdit = (videoId: string, currentLabel: string) => {
    setEditingId(videoId)
    setEditValue(currentLabel)
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditValue('')
  }

  const handleStartEditNotes = (videoId: string, currentNotes: string) => {
    setEditingNotesId(videoId)
    setNotesEditValue(currentNotes)
  }

  const handleCancelEditNotes = () => {
    setEditingNotesId(null)
    setNotesEditValue('')
  }

  const handleSaveNotes = async (videoId: string) => {
    const trimmed = notesEditValue.trim()
    if (trimmed.length > 500) {
      toast.error('Version notes must be 500 characters or fewer')
      return
    }

    setSavingNotesId(videoId)
    try {
      await apiPatch(`/api/videos/${videoId}`, { videoNotes: trimmed })

      // Optimistically update local state
      setVideos(prev => prev.map(v =>
        v.id === videoId ? ({ ...v, videoNotes: trimmed || null } as any) : v
      ))

      setEditingNotesId(null)
      setNotesEditValue('')
      onRefresh?.()
    } catch (error) {
      toast.error('Failed to update version notes')
    } finally {
      setSavingNotesId(null)
    }
  }

  const handleStartEditDeadline = (videoId: string, current: string) => {
    setEditingDeadlineId(videoId)
    setDeadlineEditValue(current)
  }

  const handleCancelEditDeadline = () => {
    setEditingDeadlineId(null)
    setDeadlineEditValue('')
  }

  const handleSaveDeadline = async (videoId: string) => {
    const next = deadlineEditValue.trim()
    if (next && !isValidFeedbackDueDate(next)) {
      toast.error('Please pick a valid date')
      return
    }
    const previous = (videos.find(v => v.id === videoId)?.feedbackDueDate as string | null | undefined) || ''
    if (next === previous) {
      handleCancelEditDeadline()
      return
    }

    setSavingDeadlineId(videoId)
    try {
      await apiPatch(`/api/videos/${videoId}`, { feedbackDueDate: next || null })
      const extended = Boolean(next && previous && next > previous)
      setVideos(prev => prev.map(v => {
        if (v.id !== videoId) return v
        const extendedAt = extended
          ? new Date().toISOString()
          : next && previous
          ? null
          : next
          ? v.feedbackDueExtendedAt ?? null
          : null
        return { ...v, feedbackDueDate: next || null, feedbackDueExtendedAt: extendedAt }
      }))
      toast.success(
        !next ? 'Feedback deadline removed'
          : extended ? `Deadline extended to ${formatFeedbackDueDate(next)}`
          : `Deadline set to ${formatFeedbackDueDate(next)}`
      )
      handleCancelEditDeadline()
      onRefresh?.()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : 'Failed to update feedback deadline')
    } finally {
      setSavingDeadlineId(null)
    }
  }

  const handleSaveEdit = async (videoId: string) => {
    if (!editValue.trim()) {
      toast.error('Version label cannot be empty')
      return
    }

    // Version labels are metadata only — save directly. (S3 mode may still ask to confirm
    // the background file rename below.)
    await saveVersionLabel(videoId, editValue.trim())
  }

  const saveVersionLabel = async (videoId: string, newLabel: string) => {
    setSavingId(videoId)
    try {
      const result = await apiPatch<any>(`/api/videos/${videoId}`, { versionLabel: newLabel })

      // S3 mode: server returns 202 asking user to confirm the background rename
      if (result?.requiresJobConfirmation) {
        setVersionRenameConfirm({ videoId, newLabel })
        return
      }

      setEditingId(null)
      setEditValue('')
      await onRefresh?.()
    } catch (error) {
      toast.error('Failed to update version label')
    } finally {
      setSavingId(null)
    }
  }

  const triggerDownload = (url: string) => {
    const link = document.createElement('a')
    link.href = withDownloadTracking(url)
    link.download = ''
    link.rel = 'noopener'
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleDownloadVideo = async (videoId: string) => {
    // Prevent multiple simultaneous download requests
    if (downloadingId) return

    setDownloadingId(videoId)

    // Generate download token and open link - non-blocking
    apiFetch(`/api/videos/${videoId}/download-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
      .then(async (response) => {
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Download failed' }))
          throw new Error(errorData.error || 'Failed to generate download link')
        }
        return response.json()
      })
      .then(({ url }) => {
        triggerDownload(url)
      })
      .catch((error) => {
        console.error('Download error:', error)
        toast.error(error instanceof Error ? error.message : 'Failed to generate download link')
      })
      .finally(() => {
        setDownloadingId(null)
      })
  }

  if (videos.length === 0) {
    return <p className="text-sm text-muted-foreground">No videos uploaded yet</p>
  }

  return (
    <div className="space-y-3">
      {videos.map((video) => {
        const isExpanded = expandedVideoIds.includes(video.id)
        const isReady = video.status === 'READY'
        const latest = isLatestVersion(video)
        const revisionRequestedAt = (video as any).revisionRequestedAt as string | null | undefined
        const approvedAt = (video as any).approvedAt as string | null | undefined
        const dueDate = isValidFeedbackDueDate(video.feedbackDueDate) ? (video.feedbackDueDate as string) : null
        const deadlineActive = Boolean(dueDate && latest && !video.approved && !revisionRequestedAt)
        const deadlineState = deadlineActive && dueDate ? getFeedbackDeadlineStatus(dueDate) : null

        const subtitlesStatus = (video as any).transcriptionStatus as string | null | undefined
        const subtitlesBusy = subtitlesStatus === 'PENDING' || subtitlesStatus === 'PROCESSING' || generatingSubtitlesId === video.id
        const subtitlesReady = Boolean((video as any).hasSubtitles)
        const subtitlesCheckedAt = (video as any).subtitlesApprovedAt as string | null | undefined

        const metaParts = [
          video.duration ? formatDuration(video.duration) : null,
          video.fps ? `${Number(video.fps).toFixed(video.fps % 1 === 0 ? 0 : 2)} fps` : null,
          video.width && video.height ? `${video.width}×${video.height}` : null,
          Number(video.originalFileSize || 0) > 0 ? formatFileSize(Number(video.originalFileSize)) : null,
        ].filter(Boolean) as string[]
        const statsParts = [
          `${Number(video.viewCount || 0).toLocaleString()} ${Number(video.viewCount || 0) === 1 ? 'view' : 'views'}`,
          `${Number(video.downloadCount || 0).toLocaleString()} ${Number(video.downloadCount || 0) === 1 ? 'download' : 'downloads'}`,
        ]
        const uploadedBy = (video as any).uploadedByName as string | null | undefined
        const uploadedPart = video.createdAt
          ? `uploaded ${shortDate(video.createdAt)}${uploadedBy ? ` by ${uploadedBy}` : ''}`
          : null

        // Version status pill: processing states first, then the review outcome.
        const statusPill = (() => {
          if (video.status === 'UPLOADING' || video.status === 'QUEUED' || video.status === 'PROCESSING' || video.status === 'ERROR') {
            const label = video.status === 'ERROR' ? 'Failed' : video.status === 'QUEUED' ? 'Queued' : video.status === 'UPLOADING' ? 'Uploading' : 'Processing'
            const tone = video.status === 'ERROR' ? 'danger' : video.status === 'QUEUED' ? 'warning' : 'info'
            return { label, tone, icon: video.status === 'ERROR' ? XCircle : Loader2, spin: video.status === 'UPLOADING' || video.status === 'PROCESSING' }
          }
          if (video.approved) return { label: joinParts(['Approved', shortDate(approvedAt)]), tone: 'success', icon: CheckCircle2, spin: false }
          if (revisionRequestedAt) return { label: joinParts(['Changes requested', shortDate(revisionRequestedAt)]), tone: 'info', icon: RotateCcw, spin: false }
          if (!latest) return { label: 'Earlier version', tone: 'muted', icon: History, spin: false }
          return { label: 'For review', tone: 'warning', icon: Eye, spin: false }
        })()

        const canShowMenu = isAdmin && (isReady || effectiveCanDelete)

        return (
          <div
            key={video.id}
            className={cn(
              'rounded-lg border bg-muted/40',
              isExpanded ? 'p-3 sm:p-4' : 'px-3 py-2 sm:px-4'
            )}
          >
            {/* Header: label + status + deadline · actions */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 basis-48">
                <div className="flex flex-wrap items-center gap-2">
                  {editingId === video.id ? (
                    <InlineEdit
                      value={editValue}
                      onChange={setEditValue}
                      onSave={() => handleSaveEdit(video.id)}
                      onCancel={handleCancelEdit}
                      disabled={savingId === video.id}
                      inputClassName="h-8 w-full sm:w-48"
                    />
                  ) : (
                    <h4 className="text-base font-semibold leading-none">{video.versionLabel}</h4>
                  )}
                  <StatusPill tone={statusPill.tone as PillTone} icon={statusPill.icon} spin={statusPill.spin}>
                    {statusPill.label}
                  </StatusPill>
                  {deadlineActive && dueDate ? (
                    <StatusPill
                      tone={deadlineState?.status === 'overdue' ? 'danger' : deadlineState && deadlineState.daysLeft <= 1 ? 'warning' : 'outline'}
                      icon={CalendarClock}
                      title={`Feedback due ${formatFeedbackDueDate(dueDate, { withYear: true })} (${describeFeedbackDeadline(dueDate)})`}
                    >
                      {deadlineState?.status === 'overdue' ? `Overdue since ${formatFeedbackDueDate(dueDate)}` : `Due ${formatFeedbackDueDate(dueDate)}`}
                      {video.feedbackDueExtendedAt ? ' · Extended' : ''}
                    </StatusPill>
                  ) : null}
                  {!isExpanded && isReady && metaParts.length > 0 ? (
                    <span className="hidden sm:inline text-xs text-muted-foreground truncate">{metaParts.slice(0, 2).join(' · ')}</span>
                  ) : null}
                </div>

              </div>

              {editingId !== video.id ? (
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  {isExpanded && isAdmin && effectiveCanApprove && isReady ? (
                    <Button
                      variant={video.approved ? 'outline' : 'success'}
                      size="sm"
                      onClick={() => handleToggleApproval(video.id, video.approved || false)}
                      disabled={approvingId === video.id}
                    >
                      {video.approved ? <XCircle className="mr-1.5 h-4 w-4" /> : <Check className="mr-1.5 h-4 w-4" />}
                      {video.approved ? 'Unapprove' : 'Approve'}
                    </Button>
                  ) : null}
                  {canShowMenu ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-8 w-8 p-0" aria-label="More actions" title="More actions">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64">
                        {!isExpanded && effectiveCanApprove && isReady ? (
                          <DropdownMenuItem onSelect={() => handleToggleApproval(video.id, video.approved || false)}>
                            {video.approved ? <XCircle className="mr-2 h-4 w-4" /> : <Check className="mr-2 h-4 w-4" />}
                            {video.approved ? 'Unapprove' : 'Approve'}
                          </DropdownMenuItem>
                        ) : null}
                        {isReady ? (
                          <DropdownMenuItem onSelect={() => handleDownloadVideo(video.id)} disabled={downloadingId === video.id}>
                            <Download className="mr-2 h-4 w-4" />
                            Download original
                          </DropdownMenuItem>
                        ) : null}
                        {transcriptionEnabled && isReady ? (
                          <DropdownMenuItem onSelect={() => handleGenerateSubtitles(video.id, subtitlesReady)} disabled={subtitlesBusy}>
                            <Captions className="mr-2 h-4 w-4" />
                            {subtitlesBusy ? 'Generating subtitles…' : subtitlesReady ? 'Regenerate subtitles' : 'Generate subtitles'}
                          </DropdownMenuItem>
                        ) : null}
                        {effectiveCanApprove && isReady && !video.approved ? (
                          <DropdownMenuItem
                            onSelect={() => handleToggleRevisionRequested(video.id, Boolean(revisionRequestedAt))}
                            disabled={savingRevisionRequestedId === video.id}
                          >
                            <FileClock className="mr-2 h-4 w-4" />
                            {revisionRequestedAt ? 'Clear "changes requested"' : 'Mark as changes requested'}
                          </DropdownMenuItem>
                        ) : null}
                        {isReady ? (
                          <DropdownMenuItem onSelect={() => handleStartEdit(video.id, video.versionLabel)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Rename version
                          </DropdownMenuItem>
                        ) : null}
                        {effectiveCanDelete ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => handleDelete(video.id)}
                              disabled={deletingId === video.id}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete version
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                  {isReady ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleExpanded(video.id)}
                      className="h-8 w-8 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title={isExpanded ? 'Collapse version' : 'Expand version'}
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* Filename + one-line summary (full width, under the header) */}
            {isExpanded && editingId !== video.id ? (
              <>
                {isAdmin && isReady ? (
                  <button
                    type="button"
                    onClick={() => handleDownloadVideo(video.id)}
                    disabled={downloadingId === video.id}
                    title="Download original"
                    className="mt-2 flex max-w-full items-center gap-1.5 text-left text-sm font-medium text-foreground hover:underline disabled:opacity-50"
                  >
                    <FileVideo className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{video.originalFileName || video.name}</span>
                  </button>
                ) : (
                  <p className="mt-2 truncate text-sm text-muted-foreground">{video.originalFileName || video.name}</p>
                )}
                {isReady ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {joinParts([...metaParts, ...statsParts, uploadedPart])}
                  </p>
                ) : null}
              </>
            ) : null}

            {video.status === 'QUEUED' && (
              <div className="mt-3 space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-warning">Waiting in queue...</span>
                </div>
                <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
                  <div className="h-full w-full bg-warning/40" />
                </div>
              </div>
            )}

            {video.status === 'PROCESSING' && (
              <div className="mt-3 space-y-1">
                {(() => {
                  const rawProg = video.processingProgress ?? 0
                  const pct = Math.min(99, Math.round(rawProg < 1 ? rawProg * 100 : rawProg))
                  return (
                    <>
                      <div className="flex justify-between text-xs">
                        <span>Processing previews...</span>
                        {pct > 0 && <span className="font-medium">{pct}%</span>}
                      </div>
                      <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{
                            width: `${Math.max(1, pct)}%`,
                            backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(255,255,255,0.2) 10px, rgba(255,255,255,0.2) 20px)',
                            backgroundSize: '28px 28px',
                            animation: 'move-stripes 1s linear infinite'
                          }}
                        />
                      </div>
                    </>
                  )
                })()}
              </div>
            )}

            {video.status === 'ERROR' && video.processingError && (
              <p className="mt-2 text-sm text-destructive">{video.processingError}</p>
            )}

            {/* Settings: label / value rows */}
            {isReady && isExpanded && (
              <dl className="mt-4 divide-y divide-border border-t border-border text-sm">
                <PropertyRow label="Client approval">
                  {video.approved ? (
                    <span className="text-muted-foreground">Approved{approvedAt ? ` ${shortDate(approvedAt)}` : ''}. Unapprove to change.</span>
                  ) : (
                    <label className="inline-flex items-center gap-2">
                      <Switch
                        checked={Boolean(video.allowApproval)}
                        onCheckedChange={(checked) => handleToggleAllowApproval(video.id, Boolean(checked))}
                        disabled={!isAdmin || !effectiveCanManageAllowApproval || savingAllowApprovalId === video.id}
                        aria-label="Clients can approve this version"
                      />
                      <span className={video.allowApproval ? 'text-foreground' : 'text-muted-foreground'}>
                        {video.allowApproval ? 'Clients can approve this version' : "Clients can't approve this version"}
                      </span>
                    </label>
                  )}
                </PropertyRow>

                <PropertyRow label="Feedback deadline">
                  {editingDeadlineId === video.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="date"
                        value={deadlineEditValue}
                        onChange={(e) => setDeadlineEditValue(e.target.value)}
                        disabled={savingDeadlineId === video.id}
                        className="h-8 w-auto"
                      />
                      {[3, 7].map((days) => {
                        // Extend from the current deadline, or from today if none / already passed.
                        const today = todayYmd()
                        const base = isValidFeedbackDueDate(deadlineEditValue) && deadlineEditValue >= today ? deadlineEditValue : today
                        return (
                          <button
                            key={days}
                            type="button"
                            disabled={savingDeadlineId === video.id}
                            onClick={() => setDeadlineEditValue(addDaysYmd(base, days) || '')}
                            className="h-8 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                          >
                            {days === 7 ? '+1 week' : `+${days} days`}
                          </button>
                        )
                      })}
                      {deadlineEditValue ? (
                        <button
                          type="button"
                          disabled={savingDeadlineId === video.id}
                          onClick={() => setDeadlineEditValue('')}
                          className="h-8 px-1 text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Remove
                        </button>
                      ) : null}
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" className="h-8" onClick={() => handleSaveDeadline(video.id)} disabled={savingDeadlineId === video.id}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8" onClick={handleCancelEditDeadline} disabled={savingDeadlineId === video.id}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : dueDate ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>
                        {formatFeedbackDueDate(dueDate, { withYear: true })}
                        <span
                          className={cn(
                            'text-muted-foreground',
                            deadlineState?.status === 'overdue' && 'text-destructive',
                            deadlineState && deadlineState.status !== 'overdue' && deadlineState.daysLeft <= 1 && 'text-warning'
                          )}
                        >
                          {' · '}
                          {video.approved
                            ? 'Approved'
                            : revisionRequestedAt
                            ? 'Changes requested'
                            : !latest
                            ? 'Superseded by a newer version'
                            : describeFeedbackDeadline(dueDate)}
                          {video.feedbackDueExtendedAt ? ' · Extended' : ''}
                        </span>
                      </span>
                      {isAdmin ? (
                        <InlineAction icon={CalendarPlus} onClick={() => handleStartEditDeadline(video.id, dueDate)}>
                          {deadlineActive ? 'Extend' : 'Change'}
                        </InlineAction>
                      ) : null}
                    </div>
                  ) : isAdmin ? (
                    <InlineAction icon={Plus} onClick={() => handleStartEditDeadline(video.id, '')}>
                      Set a feedback deadline
                    </InlineAction>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </PropertyRow>

                <PropertyRow label="Version notes" alignTop={editingNotesId === video.id || Boolean((video.videoNotes || '').trim())}>
                  {editingNotesId === video.id ? (
                    <div className="space-y-2">
                      <Textarea
                        value={notesEditValue}
                        onChange={(e) => setNotesEditValue(e.target.value)}
                        rows={3}
                        maxLength={500}
                        className="resize-none"
                        disabled={savingNotesId === video.id}
                        placeholder="Notes shown to the client with this version"
                        autoFocus
                      />
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" className="h-8" onClick={() => handleSaveNotes(video.id)} disabled={savingNotesId === video.id}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8" onClick={handleCancelEditNotes} disabled={savingNotesId === video.id}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (video.videoNotes || '').trim() ? (
                    <div className="space-y-1">
                      <p className="whitespace-pre-wrap">{video.videoNotes}</p>
                      {isAdmin ? (
                        <InlineAction icon={Pencil} onClick={() => handleStartEditNotes(video.id, (video.videoNotes as string) || '')}>
                          Edit
                        </InlineAction>
                      ) : null}
                    </div>
                  ) : isAdmin ? (
                    <InlineAction icon={Plus} onClick={() => handleStartEditNotes(video.id, '')}>
                      Add notes for the client
                    </InlineAction>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </PropertyRow>

                {transcriptionEnabled || subtitlesReady ? (
                  <PropertyRow label="Subtitles">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {subtitlesBusy ? (
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…
                        </span>
                      ) : subtitlesReady ? (
                        subtitlesCheckedAt ? (
                          <StatusPill tone="success" icon={Check}>Checked {shortDate(subtitlesCheckedAt)}</StatusPill>
                        ) : (
                          <StatusPill tone="outline" icon={Captions}>Ready, not checked yet</StatusPill>
                        )
                      ) : subtitlesStatus === 'FAILED' ? (
                        <span className="text-destructive">Generation failed</span>
                      ) : subtitlesStatus === 'SKIPPED' ? (
                        <span className="text-muted-foreground">Skipped (video too long for the provider)</span>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                      {isAdmin && transcriptionEnabled && !subtitlesBusy ? (
                        <InlineAction icon={subtitlesReady ? RefreshCw : Captions} onClick={() => handleGenerateSubtitles(video.id, subtitlesReady)}>
                          {subtitlesReady ? 'Regenerate' : subtitlesStatus === 'FAILED' || subtitlesStatus === 'SKIPPED' ? 'Retry' : 'Generate'}
                        </InlineAction>
                      ) : null}
                    </div>
                  </PropertyRow>
                ) : null}
              </dl>
            )}

            {/* Assets */}
            {isAdmin && isReady && isExpanded && (
              <VideoAssetList
                videoId={video.id}
                videoName={video.name}
                versionLabel={video.versionLabel}
                projectId={video.projectId!}
                canManage={effectiveCanManageAllowApproval}
                onAssetDeleted={() => {
                  setAssetRefreshTrigger(prev => prev + 1)
                  onRefresh?.()
                }}
                refreshTrigger={assetRefreshTrigger}
              />
            )}
          </div>
        )
      })}

      <ConfirmDialog
        open={pendingDeleteVideoId !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteVideoId(null) }}
        title="Delete Video?"
        description="Are you sure you want to delete this video? This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={confirmDeleteVideo}
      />
      <ConfirmDialog
        open={pendingApprovalVideo !== null}
        onOpenChange={(v) => { if (!v) setPendingApprovalVideo(null) }}
        title={pendingApprovalVideo?.approved ? 'Unapprove Video?' : 'Approve Video?'}
        description={`Are you sure you want to ${pendingApprovalVideo?.approved ? 'unapprove' : 'approve'} this video?`}
        confirmLabel={pendingApprovalVideo?.approved ? 'Unapprove' : 'Approve'}
        variant="default"
        onConfirm={confirmToggleApproval}
      />
      <ConfirmDialog
        open={pendingSubtitlesRegenerateId !== null}
        onOpenChange={(v) => { if (!v) setPendingSubtitlesRegenerateId(null) }}
        title="Regenerate Subtitles?"
        description="This overwrites the current captions, including any manual edits, with a fresh auto-transcription."
        confirmLabel="Regenerate"
        onConfirm={() => {
          const videoId = pendingSubtitlesRegenerateId!
          setPendingSubtitlesRegenerateId(null)
          void doGenerateSubtitles(videoId)
        }}
      />
      <ConfirmDialog
        open={versionRenameConfirm !== null}
        onOpenChange={(v) => { if (!v) setVersionRenameConfirm(null) }}
        title="Rename Version on S3?"
        description={`Renaming this version to "${versionRenameConfirm?.newLabel ?? ''}" requires copying all associated video files to a new S3 location. This will run as a background job — you can track progress in the Running Jobs indicator.`}
        confirmLabel={versionRenameConfirming ? 'Starting…' : 'Start Rename'}
        onConfirm={async () => {
          if (!versionRenameConfirm) return
          setVersionRenameConfirming(true)
          try {
            await apiPatch(`/api/videos/${versionRenameConfirm.videoId}`, {
              versionLabel: versionRenameConfirm.newLabel,
              confirmed: true,
            })
            setEditingId(null)
            setEditValue('')
            setVersionRenameConfirm(null)
            await onRefresh?.()
          } catch (e) {
            toast.error('Failed to start version rename')
          } finally {
            setVersionRenameConfirming(false)
          }
        }}
        onCancel={() => setVersionRenameConfirm(null)}
      />
    </div>
  )
}

type PillTone = 'success' | 'warning' | 'info' | 'danger' | 'muted' | 'outline'

function StatusPill({
  tone,
  icon: Icon,
  spin = false,
  title,
  children,
}: {
  tone: PillTone
  icon?: LucideIcon
  spin?: boolean
  title?: string
  children: React.ReactNode
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'success' && 'bg-success/15 text-success',
        tone === 'warning' && 'bg-warning/15 text-warning',
        tone === 'info' && 'bg-primary/15 text-primary',
        tone === 'danger' && 'bg-destructive/15 text-destructive',
        tone === 'muted' && 'bg-muted text-muted-foreground',
        tone === 'outline' && 'border border-border text-muted-foreground'
      )}
    >
      {Icon ? <Icon className={cn('h-3 w-3', spin && 'animate-spin')} /> : null}
      {children}
    </span>
  )
}

function PropertyRow({ label, alignTop = false, children }: { label: string; alignTop?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3', alignTop ? 'sm:items-start' : 'sm:items-center')}>
      <dt className="text-xs text-muted-foreground sm:text-sm">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function InlineAction({ icon: Icon, onClick, children }: { icon: LucideIcon; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-2"
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  )
}

/** "4 Nov", or "4 Nov 2025" outside the current year. */
function shortDate(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('en-AU', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

function joinParts(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' · ')
}
