'use client'

import { useMemo, useState, useEffect } from 'react'
import { Video } from '@prisma/client'
import { formatDuration, formatFileSize } from '@/lib/utils'
import { Progress } from './ui/progress'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { ReprocessModal } from './ReprocessModal'
import { InlineEdit } from './InlineEdit'
import { Textarea } from './ui/textarea'
import { Trash2, CheckCircle2, XCircle, Pencil, Upload, Check, X, ChevronDown, ChevronUp, Eye, Download } from 'lucide-react'
import { apiPost, apiPatch, apiDelete, apiFetch } from '@/lib/api-client'
import { VideoAssetUploadQueue } from './VideoAssetUploadQueue'
import { VideoAssetList } from './VideoAssetList'

interface VideoListProps {
  videos: Video[]
  isAdmin?: boolean
  onRefresh?: () => void
  canDelete?: boolean
  canApprove?: boolean
  canManageAllowApproval?: boolean
}

export default function VideoList({
  videos: initialVideos,
  isAdmin = true,
  onRefresh,
  canDelete,
  canApprove,
  canManageAllowApproval,
}: VideoListProps) {
  const effectiveCanDelete = canDelete ?? isAdmin
  const effectiveCanApprove = canApprove ?? isAdmin
  const effectiveCanManageAllowApproval = canManageAllowApproval ?? isAdmin

  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [videos, setVideos] = useState<Video[]>(initialVideos)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [showReprocessModal, setShowReprocessModal] = useState(false)
  const [pendingVideoUpdate, setPendingVideoUpdate] = useState<{ videoId: string; newLabel: string } | null>(null)
  const [reprocessing, setReprocessing] = useState(false)
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null)
  const [notesEditValue, setNotesEditValue] = useState('')
  const [savingNotesId, setSavingNotesId] = useState<string | null>(null)
  const [savingAllowApprovalId, setSavingAllowApprovalId] = useState<string | null>(null)
  const [uploadingAssetsFor, setUploadingAssetsFor] = useState<string | null>(null)
  const [assetRefreshTrigger, setAssetRefreshTrigger] = useState(0)
  const [expandedVideoIds, setExpandedVideoIds] = useState<string[]>([])

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

    // If a panel is being collapsed, also hide the asset uploader for that version.
    setUploadingAssetsFor((prev) => (prev === videoId ? null : prev))
  }

  const ensureExpanded = (videoId: string) => {
    setExpandedVideoIds((prev) => (prev.includes(videoId) ? prev : [...prev, videoId]))
  }

  const handleDelete = async (videoId: string) => {
    if (!effectiveCanDelete) return
    // Prevent double-clicks during deletion
    if (deletingId) return

    if (!confirm('Are you sure you want to delete this video? This action cannot be undone.')) {
      return
    }

    setDeletingId(videoId)

    // Optimistically remove from UI immediately
    setVideos(prev => prev.filter(v => v.id !== videoId))

    // Perform deletion in background without blocking UI
    apiDelete(`/api/videos/${videoId}`)
      .then(() => {
        // Refresh in background
        onRefresh?.()
      })
      .catch((error) => {
        // Restore video on error
        setVideos(initialVideos)
        alert('Failed to delete video')
      })
      .finally(() => {
        setDeletingId(null)
      })
  }

  const handleToggleApproval = async (videoId: string, currentlyApproved: boolean) => {
    if (!effectiveCanApprove) return
    // Prevent double-clicks during approval toggle
    if (approvingId) return

    const action = currentlyApproved ? 'unapprove' : 'approve'
    if (!confirm(`Are you sure you want to ${action} this video?`)) {
      return
    }

    setApprovingId(videoId)

    // Optimistically update UI immediately
    setVideos(prev => prev.map(v =>
      v.id === videoId ? { ...v, approved: !currentlyApproved } as Video : v
    ))

    // Trigger immediate UI update for comment section approval banner
    window.dispatchEvent(new CustomEvent('videoApprovalChanged'))

    // Perform approval in background without blocking UI
    apiPatch(`/api/videos/${videoId}`, { approved: !currentlyApproved })
      .then(() => {
        // Refresh in background
        onRefresh?.()
      })
      .catch((error) => {
        // Revert optimistic update on error
        setVideos(prev => prev.map(v =>
          v.id === videoId ? { ...v, approved: currentlyApproved } as Video : v
        ))
        alert(`Failed to ${action} video`)
      })
      .finally(() => {
        setApprovingId(null)
      })
  }

  const handleToggleAllowApproval = async (videoId: string, nextAllowApproval: boolean) => {
    if (!effectiveCanManageAllowApproval) return
    if (savingAllowApprovalId) return

    const previous = (videos.find(v => v.id === videoId) as any)?.allowApproval
    setSavingAllowApprovalId(videoId)

    // Optimistically update UI
    setVideos(prev => prev.map(v =>
      v.id === videoId ? ({ ...(v as any), allowApproval: nextAllowApproval } as any) : v
    ))

    try {
      await apiPatch(`/api/videos/${videoId}`, { allowApproval: nextAllowApproval })
      onRefresh?.()
    } catch (error) {
      // Revert optimistic update
      setVideos(prev => prev.map(v =>
        v.id === videoId ? ({ ...(v as any), allowApproval: previous } as any) : v
      ))
      alert('Failed to update approval setting')
    } finally {
      setSavingAllowApprovalId(null)
    }
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
      alert('Version notes must be 500 characters or fewer')
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
      alert('Failed to update version notes')
    } finally {
      setSavingNotesId(null)
    }
  }

  const handleSaveEdit = async (videoId: string) => {
    if (!editValue.trim()) {
      alert('Version label cannot be empty')
      return
    }

    // Show reprocessing modal since version label affects watermark
    setPendingVideoUpdate({ videoId, newLabel: editValue.trim() })
    setShowReprocessModal(true)
  }

  const saveVersionLabel = async (shouldReprocess: boolean) => {
    if (!pendingVideoUpdate) return

    setSavingId(pendingVideoUpdate.videoId)
    try {
      await apiPatch(`/api/videos/${pendingVideoUpdate.videoId}`, { versionLabel: pendingVideoUpdate.newLabel })

      // Reprocess if requested
      if (shouldReprocess) {
        await reprocessVideo(pendingVideoUpdate.videoId)
      }

      setEditingId(null)
      setEditValue('')
      setPendingVideoUpdate(null)
      setShowReprocessModal(false)
      await onRefresh?.()
    } catch (error) {
      alert('Failed to update version label')
    } finally {
      setSavingId(null)
    }
  }

  const reprocessVideo = async (videoId: string) => {
    setReprocessing(true)
    try {
      const video = videos.find(v => v.id === videoId)
      if (!video) return

      await apiPost(`/api/projects/${video.projectId}/reprocess`, { videoIds: [videoId] })

    } catch (err) {
      // Don't throw - we still want to save the label
    } finally {
      setReprocessing(false)
    }
  }

  const triggerDownload = (url: string) => {
    const link = document.createElement('a')
    link.href = url
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
        alert(error instanceof Error ? error.message : 'Failed to generate download link')
      })
      .finally(() => {
        setDownloadingId(null)
      })
  }

  if (videos.length === 0) {
    return <p className="text-sm text-muted-foreground">No videos uploaded yet</p>
  }

  return (
    <div className="space-y-4">
      {videos.map((video) => (
        (() => {
          const isExpanded = expandedVideoIds.includes(video.id)
          return (
        <div key={video.id} className="border rounded-lg bg-muted/40 p-2 sm:p-3 space-y-2">
          {/* Top row: Approved badge + Version label + Action buttons */}
          <div className="flex justify-between items-center gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
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
                <>
                  <h4 className="font-medium truncate">{video.versionLabel}</h4>
                  {isAdmin && video.status === 'READY' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 flex-shrink-0 text-muted-foreground hover:bg-primary-visible hover:text-primary"
                      onClick={() => handleStartEdit(video.id, video.versionLabel)}
                      title="Edit version label"
                    >
                      <Pencil className="w-3 h-3" />
                    </Button>
                  )}
                </>
              )}
            </div>
            {/* Action icons - right side on all screen sizes */}
            {editingId !== video.id && (
              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Only show status badge for PROCESSING and ERROR states */}
                {(video.status === 'PROCESSING' || video.status === 'ERROR') && (
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 ${
                      video.status === 'PROCESSING'
                        ? 'bg-primary-visible text-primary border-2 border-primary-visible'
                        : 'bg-destructive-visible text-destructive border-2 border-destructive-visible'
                    }`}
                  >
                    {video.status === 'PROCESSING' && (
                      <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary"></div>
                    )}
                    {video.status}
                  </span>
                )}
                  {isAdmin && effectiveCanApprove && video.status === 'READY' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleToggleApproval(video.id, (video as any).approved || false)}
                    disabled={approvingId === video.id}
                    className={(video as any).approved
                      ? "text-warning hover:text-warning hover:bg-warning-visible"
                      : "text-success hover:text-success hover:bg-success-visible"
                    }
                    title={(video as any).approved ? "Unapprove video" : "Approve video"}
                  >
                    {(video as any).approved ? (
                      <XCircle className="w-4 h-4" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4" />
                    )}
                  </Button>
                )}
                {isAdmin && video.status === 'READY' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setUploadingAssetsFor((prev) => {
                        const willOpen = prev !== video.id
                        if (willOpen) ensureExpanded(video.id)
                        return willOpen ? video.id : null
                      })
                    }}
                    className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    title="Upload Assets"
                  >
                    <Upload className="w-4 h-4" />
                  </Button>
                )}
                {isAdmin && effectiveCanDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(video.id)}
                    disabled={deletingId === video.id}
                    className="text-destructive hover:text-destructive hover:bg-destructive-visible"
                    title="Delete video"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
                {video.status === 'READY' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => toggleExpanded(video.id)}
                    className="text-muted-foreground hover:text-foreground hover:bg-accent"
                    title={isExpanded ? 'Collapse version' : 'Expand version'}
                  >
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Bottom row: Filename */}
          {editingId !== video.id && (
            <div className="flex items-center justify-between gap-2">
              {isAdmin && video.status === 'READY' ? (
                <button
                  type="button"
                  onClick={() => handleDownloadVideo(video.id)}
                  disabled={downloadingId === video.id}
                  title="Download video"
                  className="text-sm font-medium text-foreground hover:underline flex-1 min-w-0 truncate text-left disabled:opacity-50"
                >
                  {video.originalFileName}
                </button>
              ) : (
                <p className="text-sm text-muted-foreground flex-1 min-w-0 truncate" title={video.originalFileName}>
                  {video.originalFileName}
                </p>
              )}

              <div className="flex items-center gap-2 flex-shrink-0">
                {video.status === 'READY' && (
                  <div className="hidden sm:flex items-center gap-3 text-xs text-muted-foreground whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      {Number((video as any).viewCount || 0).toLocaleString()}
                      <Eye className="w-3 h-3" />
                    </span>
                    <span className="inline-flex items-center gap-1">
                      {Number((video as any).downloadCount || 0).toLocaleString()}
                      <Download className="w-3 h-3" />
                    </span>
                  </div>
                )}
                {(video as any).approved && (
                  <span className="px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap bg-success-visible text-success border-2 border-success-visible">
                    Approved
                  </span>
                )}

                {isAdmin && video.status === 'READY' && !(video as any).approved && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Approvable?</span>
                    <Checkbox
                      checked={Boolean((video as any).allowApproval)}
                      onCheckedChange={(checked) => handleToggleAllowApproval(video.id, Boolean(checked))}
                      disabled={!effectiveCanManageAllowApproval || savingAllowApprovalId === video.id}
                      aria-label="Approvable"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {video.status === 'PROCESSING' && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span>Processing previews...</span>
              </div>
              <div className="relative h-4 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full w-full bg-primary animate-striped"
                  style={{
                    backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(255,255,255,0.2) 10px, rgba(255,255,255,0.2) 20px)',
                    backgroundSize: '28px 28px',
                    animation: 'move-stripes 1s linear infinite'
                  }}
                />
              </div>
            </div>
          )}

          {video.status === 'ERROR' && video.processingError && (
            <p className="text-sm text-destructive">{video.processingError}</p>
          )}

          {video.status === 'READY' && (
            isExpanded && (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 sm:gap-4 text-xs sm:text-sm">
                <div>
                  <p className="text-muted-foreground">Duration</p>
                  <p className="font-medium">{formatDuration(video.duration)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">FPS</p>
                  <p className="font-medium">{video.fps ? `${video.fps.toFixed(2)}` : 'N/A'}</p>
                </div>
                <div className="sm:hidden">
                  <p className="text-muted-foreground">Views</p>
                  <p className="font-medium inline-flex items-center gap-1">
                    {Number((video as any).viewCount || 0).toLocaleString()}
                    <Eye className="w-3 h-3 text-muted-foreground" />
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Resolution</p>
                  <p className="font-medium">
                    {video.width}x{video.height}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Size</p>
                  <p className="font-medium">{formatFileSize(Number(video.originalFileSize))}</p>
                </div>
                <div className="sm:hidden">
                  <p className="text-muted-foreground">Downloads</p>
                  <p className="font-medium inline-flex items-center gap-1">
                    {Number((video as any).downloadCount || 0).toLocaleString()}
                    <Download className="w-3 h-3 text-muted-foreground" />
                  </p>
                </div>
              </div>
            )
          )}

          {/* Version Notes */}
          {video.status === 'READY' && (
            isExpanded && (
            <div className="pt-3">
              <div className="flex items-center gap-2">
                <p className="text-muted-foreground text-xs sm:text-sm">Version Notes</p>
                {isAdmin && editingId !== video.id && (
                  editingNotesId === video.id ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-success hover:text-success hover:bg-success-visible"
                        onClick={() => handleSaveNotes(video.id)}
                        disabled={savingNotesId === video.id}
                        title="Save version notes"
                      >
                        <Check className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive-visible"
                        onClick={handleCancelEditNotes}
                        disabled={savingNotesId === video.id}
                        title="Cancel"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 flex-shrink-0 text-muted-foreground hover:bg-primary-visible hover:text-primary"
                      onClick={() => handleStartEditNotes(video.id, ((video as any).videoNotes as string) || '')}
                      title="Edit version notes"
                    >
                      <Pencil className="w-3 h-3" />
                    </Button>
                  )
                )}
              </div>

              {editingNotesId === video.id ? (
                <div className="mt-2">
                  <Textarea
                    value={notesEditValue}
                    onChange={(e) => setNotesEditValue(e.target.value)}
                    rows={3}
                    maxLength={500}
                    className="resize-none"
                    disabled={savingNotesId === video.id}
                    placeholder="Add notes for this version (optional)"
                  />
                </div>
              ) : (
                <p className="text-sm mt-1 whitespace-pre-wrap">
                  {(((video as any).videoNotes as string) || '').trim() ? (
                    (video as any).videoNotes
                  ) : (
                    <span className="text-muted-foreground">No notes</span>
                  )}
                </p>
              )}
            </div>
            )
          )}

          {/* Asset upload section */}
          {isAdmin && isExpanded && uploadingAssetsFor === video.id && video.status === 'READY' && (
            <div className="mt-4 pt-4 border-t space-y-4">
              <VideoAssetUploadQueue
                videoId={video.id}
                maxConcurrent={3}
                onUploadComplete={() => {
                  setAssetRefreshTrigger(prev => prev + 1) // Trigger asset list refresh
                  onRefresh?.()
                }}
              />
            </div>
          )}

          {/* Asset list section - always visible for READY videos if admin */}
          {isAdmin && video.status === 'READY' && (
            isExpanded && (
              <VideoAssetList
                videoId={video.id}
                videoName={video.name}
                versionLabel={video.versionLabel}
                projectId={video.projectId}
                canManage={effectiveCanManageAllowApproval}
                onAssetDeleted={() => {
                  setAssetRefreshTrigger(prev => prev + 1)
                  onRefresh?.()
                }}
                refreshTrigger={assetRefreshTrigger}
              />
            )
          )}
        </div>
          )
        })()
      ))}

      <ReprocessModal
        show={showReprocessModal}
        onCancel={() => {
          setShowReprocessModal(false)
          setPendingVideoUpdate(null)
          setSavingId(null)
        }}
        onSaveWithoutReprocess={() => saveVersionLabel(false)}
        onSaveAndReprocess={() => saveVersionLabel(true)}
        saving={savingId !== null}
        reprocessing={reprocessing}
        title="Version Label Changed"
        description="Version labels appear in watermarks. The change will only apply to newly uploaded videos."
        isSingleVideo={true}
      />
    </div>
  )
}
