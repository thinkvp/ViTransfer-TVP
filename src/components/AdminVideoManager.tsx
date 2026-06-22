'use client'

import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { ChevronDown, ChevronUp, Plus, Video, CheckCircle2, Pencil, X, RotateCw, Loader2 } from 'lucide-react'
import VideoUpload from './VideoUpload'
import VideoList from './VideoList'
import { InlineEdit } from './InlineEdit'
import { cn } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import { apiPatch, apiPost } from '@/lib/api-client'
import MultiVideoUploadModal from '@/components/MultiVideoUploadModal'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from 'sonner'

interface VideoGroup {
  name: string
  videos: any[]
}

interface AdminVideoManagerProps {
  projectId: string
  videos: any[]
  projectStatus: string
  comments?: any[]
  restrictToLatestVersion?: boolean
  companyName?: string
  canFullControl?: boolean
  onVideoSelect?: (videoName: string, videos: any[]) => void
  onRefresh?: () => void
  sortMode?: 'status' | 'alphabetical'
  maxRevisions?: number
  enableRevisions?: boolean
  watermarkEnabled?: boolean
}

export default function AdminVideoManager({
  projectId,
  videos,
  projectStatus,
  comments = [],
  restrictToLatestVersion = false,
  companyName = 'Studio',
  canFullControl = true,
  onVideoSelect,
  onRefresh,
  sortMode = 'alphabetical',
  maxRevisions,
  enableRevisions,
  watermarkEnabled = true,
}: AdminVideoManagerProps) {
  const router = useRouter()

  // Group videos by name
  const videoGroups = videos.reduce((acc: Record<string, any[]>, video) => {
    const name = video.name
    if (!acc[name]) {
      acc[name] = []
    }
    acc[name].push(video)
    return acc
  }, {})

  const hasVideos = videos.length > 0
  // Only allow one video expanded at a time - default collapsed
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [addVideosOpen, setAddVideosOpen] = useState(false)
  const [showNewVersionForGroup, setShowNewVersionForGroup] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState<string | null>(null)
  const [editGroupValue, setEditGroupValue] = useState('')
  const [savingGroupName, setSavingGroupName] = useState<string | null>(null)

  // S3 rename confirmation modal
  const [renameConfirmGroup, setRenameConfirmGroup] = useState<{ oldName: string; videoIds: string[]; proposedName: string } | null>(null)
  const [renameGroupConfirming, setRenameGroupConfirming] = useState(false)

  // Reprocess state per video group
  const [reprocessingGroups, setReprocessingGroups] = useState<Set<string>>(new Set())
  // Reprocess confirmation modal
  const [reprocessConfirm, setReprocessConfirm] = useState<{ groupName: string; videoIds: string[] } | null>(null)

  const runReprocess = async (groupName: string, videoIds: string[]) => {
    setReprocessingGroups((prev) => new Set(prev).add(groupName))
    try {
      await apiPost(`/api/projects/${projectId}/reprocess-previews`, { videoIds })
      toast.success(`Queued ${videoIds.length} video(s) for reprocessing`)
      onRefresh?.()
    } catch (err: any) {
      toast.error(err?.message || 'Failed to reprocess videos')
    } finally {
      setReprocessingGroups((prev) => {
        const next = new Set(prev)
        next.delete(groupName)
        return next
      })
    }
  }

  // Poster thumbnails for the latest version of each group. Tokens are minted in one
  // batch request and served via /api/content/<token>; we cache per-video so list
  // refreshes don't re-request, and re-request on image error (token expiry).
  const sessionIdRef = useRef<string>(`admin:${Date.now()}`)
  const [thumbUrlByVideoId, setThumbUrlByVideoId] = useState<Record<string, string>>({})
  const thumbRequestedRef = useRef<Set<string>>(new Set())

  // Notify parent when component mounts with first video
  useEffect(() => {
    // No auto-expansion on mount; admin will expand explicitly
  }, [])

  // Mint poster-thumbnail tokens for the latest READY version of each video group.
  useEffect(() => {
    const latestPerGroup = Object.values(videoGroups)
      .map((vs) => vs.slice().sort((a, b) => b.version - a.version)[0])
      .filter((v) => v && v.status === 'READY' && v.thumbnailPath && !thumbRequestedRef.current.has(v.id))

    if (latestPerGroup.length === 0) return

    const items = latestPerGroup.map((v) => ({ videoId: v.id, quality: 'thumbnail' }))
    items.forEach((it) => thumbRequestedRef.current.add(it.videoId))

    let cancelled = false
    ;(async () => {
      try {
        const res = await apiPost<{ results?: Record<string, string>; directUrls?: Record<string, string> }>('/api/admin/video-token/batch', {
          projectId,
          sessionId: sessionIdRef.current,
          items,
        })
        if (cancelled) return
        const results = res?.results || {}
        const directUrls = res?.directUrls || {}
        const next: Record<string, string> = {}
        // Prefer a presigned R2 URL (S3 mode) so the <img> loads straight from R2;
        // fall back to the /api/content proxy URL (local storage, or if presigning failed).
        const pairKeys = new Set([...Object.keys(results), ...Object.keys(directUrls)])
        for (const pairKey of pairKeys) {
          const videoId = pairKey.split(':')[0]
          const direct = directUrls[pairKey]
          const token = results[pairKey]
          if (typeof direct === 'string' && direct) {
            next[videoId] = direct
          } else if (typeof token === 'string' && token) {
            next[videoId] = `/api/content/${token}`
          }
        }
        if (Object.keys(next).length > 0) {
          setThumbUrlByVideoId((prev) => ({ ...prev, ...next }))
        }
      } catch {
        // Allow a later retry for these videos.
        items.forEach((it) => thumbRequestedRef.current.delete(it.videoId))
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos, projectId])

  const toggleGroup = (name: string) => {
    const wasExpanded = expandedGroup === name

    if (wasExpanded) {
      // Collapse current video – keep showNewVersionForGroup so CardContent
      // stays mounted (hidden) and the VideoUpload component preserves its
      // TUS upload state (progress, speed, ETA).
      setExpandedGroup(null)
    } else {
      // Expand this video (and collapse any other)
      setExpandedGroup(name)
      // Notify parent when expanding a video
      if (onVideoSelect && videoGroups[name]) {
        onVideoSelect(name, videoGroups[name])
      }
    }
  }

  const handleUploadComplete = () => {
    // Refresh the project data to show the new video
    onRefresh?.()
  }

  const handleStartEditGroupName = (oldName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingGroupName(oldName)
    setEditGroupValue(oldName)
  }

  const handleCancelEditGroupName = () => {
    setEditingGroupName(null)
    setEditGroupValue('')
  }

  const handleSaveGroupName = async (oldName: string) => {
    if (!editGroupValue.trim()) {
      toast.error('Video name cannot be empty')
      return
    }

    setSavingGroupName(oldName)

    const videosInGroup = videoGroups[oldName]
    const videoIds = videosInGroup.map(v => v.id)
    const newName = editGroupValue.trim()

    try {
      const result = await apiPatch<any>('/api/videos/batch', { videoIds, name: newName })

      // S3 mode: server returns 202 asking user to confirm the background rename
      if (result?.requiresJobConfirmation) {
        setRenameConfirmGroup({ oldName, videoIds, proposedName: result.proposedName ?? newName })
        return
      }

      setEditingGroupName(null)
      setEditGroupValue('')
      onRefresh?.()
      router.refresh()
    } catch {
      toast.error('Failed to update video name')
    } finally {
      setSavingGroupName(null)
    }
  }

  const sortedGroupNames = Object.keys(videoGroups).sort((nameA, nameB) => {
    if (sortMode === 'alphabetical') {
      return nameA.localeCompare(nameB)
    } else {
      // Status sorting
      // Check if ANY version is approved in each group
      const hasApprovedA = videoGroups[nameA].some(v => v.approved)
      const hasApprovedB = videoGroups[nameB].some(v => v.approved)

      // Groups with no approved versions come first, groups with any approved versions come last
      if (hasApprovedA !== hasApprovedB) {
        return hasApprovedA ? 1 : -1
      }
      // If both have same approval status, sort alphabetically
      return nameA.localeCompare(nameB)
    }
  })

  return (
    <>
    <div className="space-y-4">
      {sortedGroupNames.map((groupName) => {
        const groupVideos = videoGroups[groupName]
        const isExpanded = expandedGroup === groupName
        const latestVideo = groupVideos.sort((a, b) => b.version - a.version)[0]
        const approvedCount = groupVideos.filter(v => v.approved).length
        const hasApprovedVideos = approvedCount > 0
        const hasUploading = groupVideos.some((v) => v?.status === 'UPLOADING')
        const hasProcessing = groupVideos.some((v) => v?.status === 'PROCESSING')
        const hasQueued = groupVideos.some((v) => v?.status === 'QUEUED')
        const hasFailed = groupVideos.some((v) => v?.status === 'ERROR')

        return (
          <Card
            key={groupName}
            className={cn(
              'overflow-hidden transition-shadow hover:shadow-sm',
              hasApprovedVideos && 'border-l-2 border-l-success'
            )}
          >
            <CardHeader
              className={cn(
                'cursor-pointer hover:bg-accent/50 transition-colors',
                'flex flex-row items-center justify-between space-y-0 py-3'
              )}
              onClick={() => toggleGroup(groupName)}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {(() => {
                  const isReprocessing = reprocessingGroups.has(groupName)
                  // Approved projects can still be reprocessed (server only blocks CLOSED).
                  const canReprocess = projectStatus !== 'CLOSED'
                  const hasError = hasFailed
                  const hasBusy = hasUploading || hasProcessing || hasQueued
                  // Status accent: red for error, orange for busy, neutral border when healthy.
                  const ringColor = hasError
                    ? 'ring-destructive/60'
                    : hasBusy
                    ? 'ring-orange-500/60'
                    : 'ring-border'
                  const iconColor = hasError
                    ? 'text-destructive'
                    : hasBusy
                    ? 'text-orange-500'
                    : 'text-primary'
                  const thumbUrl = thumbUrlByVideoId[latestVideo.id]

                  const handleReprocess = (e: React.MouseEvent) => {
                    e.stopPropagation()
                    if (!canReprocess || isReprocessing) return
                    const videoIds = groupVideos.map((v: any) => v.id)
                    setReprocessConfirm({ groupName, videoIds })
                  }

                  return (
                    <div
                      className={cn(
                        'group/thumb relative flex-shrink-0 w-20 h-12 sm:w-24 sm:h-14 rounded-md overflow-hidden bg-muted ring-1',
                        ringColor
                      )}
                    >
                      {/* eslint-disable @next/next/no-img-element */}
                      {thumbUrl ? (
                        <img
                          src={thumbUrl}
                          alt={groupName}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          onError={() => {
                            thumbRequestedRef.current.delete(latestVideo.id)
                            setThumbUrlByVideoId((prev) => {
                              const next = { ...prev }
                              delete next[latestVideo.id]
                              return next
                            })
                          }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Video className={`w-5 h-5 ${iconColor}`} />
                        </div>
                      )}
                      {/* eslint-enable @next/next/no-img-element */}

                      {isReprocessing ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                          <Loader2 className="w-5 h-5 text-white animate-spin" />
                        </div>
                      ) : canReprocess ? (
                        <button
                          type="button"
                          title="Reprocess previews"
                          onClick={handleReprocess}
                          className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition-all hover:bg-black/45 hover:opacity-100 focus-visible:bg-black/45 focus-visible:opacity-100"
                        >
                          <RotateCw className="w-5 h-5" />
                        </button>
                      ) : null}
                    </div>
                  )
                })()}
                <div className="flex-1 min-w-0">
                  <div className="min-w-0">
                    {editingGroupName === groupName ? (
                      <InlineEdit
                        value={editGroupValue}
                        onChange={setEditGroupValue}
                        onSave={() => handleSaveGroupName(groupName)}
                        onCancel={handleCancelEditGroupName}
                        disabled={savingGroupName === groupName}
                        inputClassName="h-8 w-full sm:w-64"
                        stopPropagation={true}
                      />
                    ) : (
                      <div className="min-w-0">
                        <CardTitle className="text-lg leading-snug break-words">
                          <span>{groupName}</span>
                          {projectStatus !== 'APPROVED' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="ml-1 h-6 w-6 text-muted-foreground hover:text-primary hover:bg-primary-visible inline-flex align-text-top"
                              onClick={(e) => handleStartEditGroupName(groupName, e)}
                              title="Edit video name"
                            >
                              <Pencil className="w-3 h-3" />
                            </Button>
                          )}
                          {hasApprovedVideos && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 ml-2 rounded text-xs font-medium bg-success-visible text-success border border-success-visible">
                              <CheckCircle2 className="w-3 h-3" />
                              {approvedCount} Approved
                            </span>
                          )}
                        </CardTitle>
                      </div>
                    )}
                  </div>
                  {editingGroupName !== groupName && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {groupVideos.length} {groupVideos.length === 1 ? 'version' : 'versions'} •
                      Latest: {latestVideo.versionLabel || `v${latestVideo.version}`}
                      {enableRevisions && maxRevisions && (
                        <> • Revisions {groupVideos.length}/{maxRevisions}</>
                      )}
                    </p>
                  )}
                </div>
                {editingGroupName !== groupName && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {hasUploading && (
                      <span className="px-2 py-1 rounded text-xs font-medium flex items-center gap-1 border border-border bg-secondary text-foreground">
                        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-foreground/80" />
                        UPLOADING
                      </span>
                    )}
                    {hasQueued && (
                      <span className="px-2 py-1 rounded text-xs font-medium flex items-center gap-1 bg-warning-visible text-warning border-2 border-warning-visible">
                        QUEUED
                      </span>
                    )}
                    {hasProcessing && (
                      <span className="px-2 py-1 rounded text-xs font-medium flex items-center gap-1 bg-primary-visible text-primary border-2 border-primary-visible">
                        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary" />
                        PROCESSING
                      </span>
                    )}
                    {hasFailed && (
                      <span className="px-2 py-1 rounded text-xs font-medium flex items-center gap-1 bg-destructive-visible text-destructive border-2 border-destructive-visible">
                        FAILED
                      </span>
                    )}
                    {isExpanded ? (
                      <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                    )}
                  </div>
                )}
              </div>
            </CardHeader>

            {(isExpanded || showNewVersionForGroup === groupName) && (
              <CardContent className={cn("border-t border-border pt-0 space-y-4", isExpanded ? "animate-in fade-in slide-in-from-top-1 duration-200" : "hidden")}>
                {/* Upload new version for this video */}
                {projectStatus !== 'APPROVED' && (
                  <div className="mt-4">
                    {showNewVersionForGroup !== groupName ? (
                      <Button
                        variant="outline"
                        size="lg"
                        onClick={() => setShowNewVersionForGroup(groupName)}
                        className="w-full border-dashed"
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        Add New Version
                      </Button>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-medium">Upload New Version</h4>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setShowNewVersionForGroup(null)}
                            title="Close"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                        <VideoUpload
                          projectId={projectId}
                          videoName={groupName}
                          allowApproval={canFullControl ? undefined : false}
                          showAllowApprovalField={canFullControl}
                          onUploadComplete={() => {
                            setShowNewVersionForGroup(null)
                            handleUploadComplete()
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Version list */}
                <div className="mt-5">
                  <h4 className="text-sm font-medium mb-3">All Versions</h4>
                  <VideoList
                    videos={groupVideos.slice().sort((a, b) => b.version - a.version)}
                    onRefresh={onRefresh}
                    canDelete={canFullControl}
                    canApprove={canFullControl}
                    canManageAllowApproval={canFullControl}
                    watermarkEnabled={watermarkEnabled}
                  />
                </div>
              </CardContent>
            )}
          </Card>
        )
      })}

      {!hasVideos && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <span className="rounded-full bg-muted p-3">
              <Video className="w-6 h-6 text-muted-foreground" />
            </span>
            <p className="text-sm font-medium">No videos yet</p>
            <p className="text-sm text-muted-foreground">
              {projectStatus === 'APPROVED'
                ? 'This project is approved.'
                : 'Add a video to start collecting feedback.'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Add new video button */}
      {projectStatus !== 'APPROVED' && (
        <div className="space-y-2">
          <Button
            variant="outline"
            size="lg"
            onClick={() => setAddVideosOpen(true)}
            className="w-full border-dashed"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Video/s
          </Button>

          <MultiVideoUploadModal
            open={addVideosOpen}
            onOpenChange={setAddVideosOpen}
            projectId={projectId}
            canFullControl={canFullControl}
            onUploadComplete={handleUploadComplete}
          />
        </div>
      )}
    </div>

    <ConfirmDialog
      open={renameConfirmGroup !== null}
      onOpenChange={(v) => { if (!v) setRenameConfirmGroup(null) }}
      title="Rename Video on S3?"
      description={`Renaming this video to "${renameConfirmGroup?.proposedName ?? ''}" requires copying all video files to a new S3 location. This will run as a background job — you can track progress in the Running Jobs indicator.`}
      confirmLabel={renameGroupConfirming ? 'Starting…' : 'Start Rename'}
      onConfirm={async () => {
        if (!renameConfirmGroup) return
        setRenameGroupConfirming(true)
        try {
          await apiPatch('/api/videos/batch', {
            videoIds: renameConfirmGroup.videoIds,
            name: renameConfirmGroup.proposedName,
            confirmed: true,
          })
          setEditingGroupName(null)
          setEditGroupValue('')
          setRenameConfirmGroup(null)
          onRefresh?.()
          router.refresh()
        } catch (e: any) {
          toast.error(e?.message || 'Failed to start video rename')
        } finally {
          setRenameGroupConfirming(false)
        }
      }}
      onCancel={() => setRenameConfirmGroup(null)}
    />

    <ConfirmDialog
      open={reprocessConfirm !== null}
      onOpenChange={(v) => { if (!v) setReprocessConfirm(null) }}
      title="Reprocess Previews?"
      description={`This will re-generate previews for ${reprocessConfirm?.videoIds.length ?? 0} video version(s). It runs as a background job — you can track progress in the Running Jobs indicator.`}
      confirmLabel="Reprocess"
      variant="default"
      onConfirm={async () => {
        if (!reprocessConfirm) return
        const { groupName, videoIds } = reprocessConfirm
        setReprocessConfirm(null)
        await runReprocess(groupName, videoIds)
      }}
      onCancel={() => setReprocessConfirm(null)}
    />
  </>
  )
}
