'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { ChevronDown, ChevronUp, Plus, Video, CheckCircle2, Pencil, X } from 'lucide-react'
import VideoUpload from './VideoUpload'
import VideoList from './VideoList'
import { InlineEdit } from './InlineEdit'
import { cn } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import { apiPatch } from '@/lib/api-client'
import MultiVideoUploadModal from '@/components/MultiVideoUploadModal'

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
  enableRevisions
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

  // Notify parent when component mounts with first video
  useEffect(() => {
    // No auto-expansion on mount; admin will expand explicitly
  }, [])

  const toggleGroup = (name: string) => {
    const wasExpanded = expandedGroup === name

    if (wasExpanded) {
      // Collapse current video
      setExpandedGroup(null)
      setShowNewVersionForGroup(null)
    } else {
      // Expand this video (and collapse any other)
      setExpandedGroup(name)
      setShowNewVersionForGroup(null)
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
      alert('Video name cannot be empty')
      return
    }

    setSavingGroupName(oldName)

    const videosInGroup = videoGroups[oldName]
    const videoIds = videosInGroup.map(v => v.id)

    // Single batch update for all videos (non-blocking)
    apiPatch('/api/videos/batch', { videoIds, name: editGroupValue.trim() })
      .then(() => {
        setEditingGroupName(null)
        setEditGroupValue('')
        // Refresh in background
        onRefresh?.()
        router.refresh()
      })
      .catch((error) => {
        alert('Failed to update video name')
      })
      .finally(() => {
        setSavingGroupName(null)
      })
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
    <div className="space-y-4">
      {sortedGroupNames.map((groupName) => {
        const groupVideos = videoGroups[groupName]
        const isExpanded = expandedGroup === groupName
        const latestVideo = groupVideos.sort((a, b) => b.version - a.version)[0]
        const approvedCount = groupVideos.filter(v => v.approved).length
        const hasApprovedVideos = approvedCount > 0
        const hasProcessing = groupVideos.some((v) => v?.status === 'PROCESSING')

        return (
          <Card key={groupName} className="overflow-hidden">
            <CardHeader
              className={cn(
                'cursor-pointer hover:bg-accent/50 transition-colors',
                'flex flex-row items-center justify-between space-y-0 py-3'
              )}
              onClick={() => toggleGroup(groupName)}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Video className="w-5 h-5 text-muted-foreground flex-shrink-0" />
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
                    {hasProcessing && (
                      <span className="px-2 py-1 rounded text-xs font-medium flex items-center gap-1 bg-primary-visible text-primary border-2 border-primary-visible">
                        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary" />
                        PROCESSING
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

            {isExpanded && (
              <CardContent className="border-t border-border pt-0 space-y-4">
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
                  />
                </div>
              </CardContent>
            )}
          </Card>
        )
      })}

      {/* Add new video button */}
      {projectStatus !== 'APPROVED' && (
        <div>
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
  )
}
